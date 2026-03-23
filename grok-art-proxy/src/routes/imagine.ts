import { Hono } from "hono";
import type { Env } from "../env";
import { countActiveTokens, getToken, getRandomToken, syncTokenUsage, markTokenCooling, recordTokenFail, type TokenRow } from "../repo/tokens";
import { generateImages, type StreamUpdate } from "../grok/image";
import { generateVideo, type VideoUpdate } from "../grok/video";
import { addLog } from "../repo/logs";

type HonoEnv = { Bindings: Env };

const app = new Hono<HonoEnv>();

// Image generation (SSE stream) with auto-retry on 429
app.post("/api/imagine/generate", async (c) => {
  const body = await c.req.json<{
    prompt: string;
    aspect_ratio?: string;
    enable_nsfw?: boolean;
    count?: number;
    token_id?: string;
  }>();

  const { prompt, aspect_ratio = "2:3", enable_nsfw = true, count = 10, token_id } = body;
  const clientIp = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "unknown";

  // Stream SSE response
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  const encoder = new TextEncoder();

  const writeEvent = async (event: string, data: unknown) => {
    await writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  };

  // Capture db reference before async context
  const db = c.env.DB;

  // Generate images with retry logic
  const backgroundTask = (async () => {
    const excludedTokenIds: string[] = [];
    const maxRetries = Math.max(1, await countActiveTokens(db)) + (token_id ? 1 : 0);
    let retryCount = 0;
    let totalCollected = 0;
    const targetCount = count;

    while (retryCount < maxRetries && totalCollected < targetCount) {
      // Get token (excluding rate-limited ones)
      let token: TokenRow | null = null;

      if (token_id && retryCount === 0) {
        token = await getToken(db, token_id);
      }

      if (!token) {
        token = await getRandomToken(db, excludedTokenIds);
      }

      if (!token) {
        if (excludedTokenIds.length > 0) {
          await writeEvent("error", {
            type: "error",
            message: `All tokens rate limited (tried ${excludedTokenIds.length} tokens)`,
          });
        } else {
          await writeEvent("error", {
            type: "error",
            message: "No available tokens. Please import tokens first.",
          });
        }
        break;
      }

      const tokenStartTime = Date.now();
      try {
        const remainingCount = targetCount - totalCollected;
        let gotRateLimited = false;

        for await (const update of generateImages(
          token.sso,
          token.sso_rw,
          prompt,
          remainingCount,
          aspect_ratio,
          enable_nsfw,
          token.user_id,
          token.cf_clearance
        )) {
          if (update.type === "error") {
            const msg = update.message;

            // Check for rate limit (429, Rate limited, rate_limit_exceeded)
            if (msg.includes("429") || msg.includes("Rate limited") || msg.includes("rate_limit")) {
              excludedTokenIds.push(token.id);
              retryCount++;
              gotRateLimited = true;
              await markTokenCooling(db, token.id);
              await addLog(db, { ip: clientIp, action: "imagine", token_id: token.id, duration: Date.now() - tokenStartTime, status: 429, error: msg }).catch(() => {});

              await writeEvent("info", {
                type: "info",
                message: `Token rate limited, switching to another (attempt ${retryCount}/${maxRetries}) [${msg.slice(0, 120)}]`,
              });

              // Break inner loop to retry with new token
              break;
            } else {
              // Other error, propagate it
              await addLog(db, { ip: clientIp, action: "imagine", token_id: token.id, duration: Date.now() - tokenStartTime, status: 500, error: msg }).catch(() => {});
              await writeEvent("error", update);
              await writer.close();
              return;
            }
          } else if (update.type === "image") {
            totalCollected++;
            await writeEvent("image", update);

            // Update progress with total collected
            await writeEvent("progress", {
              type: "progress",
              job_id: update.job_id,
              status: "collecting",
              percentage: (totalCollected / targetCount) * 100,
              completed_count: totalCollected,
              target_count: targetCount,
            });
          } else if (update.type === "progress") {
            // Forward progress events (except collecting which we handle above)
            if (update.status !== "collecting") {
              await writeEvent("progress", update);
            }
          } else if (update.type === "done") {
            // API 同步配额（优先），失败 fallback 到本地预扣
            await syncTokenUsage(db, token.id, 1);
            await addLog(db, { ip: clientIp, action: "imagine", token_id: token.id, duration: Date.now() - tokenStartTime, status: 200 }).catch(() => {});
            // Check if we got enough
            if (totalCollected >= targetCount) {
              await writeEvent("done", {});
              await writer.close();
              return;
            }
            // Otherwise continue with next token if needed
            break;
          }
        }

        if (gotRateLimited) {
          continue;
        }

        if (totalCollected < targetCount) {
          excludedTokenIds.push(token.id);
          retryCount++;
          await writeEvent("info", {
            type: "info",
            message: `Current token only returned ${totalCollected}/${targetCount}, switching to another (attempt ${retryCount}/${maxRetries})`,
          });
          continue;
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);

        if (message.includes("429") || message.includes("Rate limited") || message.includes("rate_limit")) {
          excludedTokenIds.push(token.id);
          retryCount++;
          await markTokenCooling(db, token.id);
          await addLog(db, { ip: clientIp, action: "imagine", token_id: token.id, duration: Date.now() - tokenStartTime, status: 429, error: message }).catch(() => {});

          await writeEvent("info", {
            type: "info",
            message: `Token rate limited, switching to another (attempt ${retryCount}/${maxRetries})`,
          });
          continue;
        } else {
          await writeEvent("error", {
            type: "error",
            message,
          });
          break;
        }
      }
    }

    // Final done event
    if (totalCollected === 0 && excludedTokenIds.length > 0 && retryCount >= maxRetries) {
      await writeEvent("error", {
        type: "error",
        message: `All tokens rate limited (tried ${excludedTokenIds.length} tokens)`,
      });
    }

    if (totalCollected > 0) {
      await writeEvent("done", {});
    }
    await writer.close();
  })().catch(console.error);

  // Use waitUntil if available to ensure background task completes
  if (c.executionCtx?.waitUntil) {
    c.executionCtx.waitUntil(backgroundTask);
  }

  return new Response(stream.readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

// Video generation (SSE stream) with auto-retry on 429
app.post("/api/video/generate", async (c) => {
  const body = await c.req.json<{
    image_url: string;
    prompt: string;
    parent_post_id: string;
    aspect_ratio?: string;
    video_length?: number;
    resolution?: string;
    mode?: string;
    token_id?: string;
  }>();

  const {
    image_url,
    prompt,
    parent_post_id,
    aspect_ratio = "2:3",
    video_length = 6,
    resolution = "480p",
    mode = "custom",
    token_id,
  } = body;

  const clientIp = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "unknown";

  // Stream SSE response
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  const encoder = new TextEncoder();

  const writeEvent = async (event: string, data: unknown) => {
    await writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  };

  // Capture db reference before async context
  const db = c.env.DB;

  // Generate video with retry logic
  const backgroundTask = (async () => {
    const excludedTokenIds: string[] = [];
    const maxRetries = Math.max(1, await countActiveTokens(db)) + (token_id ? 1 : 0);
    let retryCount = 0;

    while (retryCount < maxRetries) {
      // Get token (excluding rate-limited ones)
      let token: TokenRow | null = null;

      if (token_id && retryCount === 0) {
        token = await getToken(db, token_id);
      }

      if (!token) {
        token = await getRandomToken(db, excludedTokenIds);
      }

      if (!token) {
        if (excludedTokenIds.length > 0) {
          await writeEvent("error", {
            type: "error",
            message: `All tokens rate limited (tried ${excludedTokenIds.length} tokens)`,
          });
        } else {
          await writeEvent("error", {
            type: "error",
            message: "No available tokens. Please import tokens first.",
          });
        }
        break;
      }

      const tokenStartTime = Date.now();
      try {
        let completed = false;

        for await (const update of generateVideo(
          token.sso,
          token.sso_rw,
          token.user_id,
          token.cf_clearance,
          token.id,
          image_url,
          prompt,
          parent_post_id,
          aspect_ratio,
          video_length,
          resolution,
          mode
        )) {
          if (update.type === "error") {
            const msg = update.message;

            // Check for 429 rate limit
            if (msg.includes("429") || msg.includes("Rate limited") || msg.includes("rate_limit")) {
              excludedTokenIds.push(token.id);
              retryCount++;
              await markTokenCooling(db, token.id);
              await addLog(db, { ip: clientIp, action: "video", token_id: token.id, duration: Date.now() - tokenStartTime, status: 429, error: msg }).catch(() => {});

              await writeEvent("info", {
                type: "info",
                message: `Token rate limited, switching to another (attempt ${retryCount}/${maxRetries})`,
              });

              break;
            } else {
              // Other error, propagate it
              await addLog(db, { ip: clientIp, action: "video", token_id: token.id, duration: Date.now() - tokenStartTime, status: 500, error: msg }).catch(() => {});
              await writeEvent("error", update);
              await writer.close();
              return;
            }
          } else if (update.type === "complete") {
            await writeEvent("complete", update);
            completed = true;
          } else if (update.type === "progress") {
            await writeEvent("progress", update);
          } else if (update.type === "done") {
            if (completed) {
              await syncTokenUsage(db, token.id, 4);
              await addLog(db, { ip: clientIp, action: "video", token_id: token.id, duration: Date.now() - tokenStartTime, status: 200 }).catch(() => {});
              await writeEvent("done", {});
              await writer.close();
              return;
            }
          }
        }

        // If we got here without completing, try next token
        if (!completed) {
          continue;
        }
        break;

      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);

        if (message.includes("429") || message.includes("Rate limited") || message.includes("rate_limit")) {
          excludedTokenIds.push(token.id);
          retryCount++;
          await markTokenCooling(db, token.id);
          await addLog(db, { ip: clientIp, action: "video", token_id: token.id, duration: Date.now() - tokenStartTime, status: 429, error: message }).catch(() => {});

          await writeEvent("info", {
            type: "info",
            message: `Token rate limited, switching to another (attempt ${retryCount}/${maxRetries})`,
          });
          continue;
        } else {
          await writeEvent("error", {
            type: "error",
            message,
          });
          break;
        }
      }
    }

    if (excludedTokenIds.length > 0 && retryCount >= maxRetries) {
      await writeEvent("error", {
        type: "error",
        message: `All tokens rate limited (tried ${excludedTokenIds.length} tokens)`,
      });
    }

    await writer.close();
  })().catch(console.error);

  // Use waitUntil if available
  if (c.executionCtx?.waitUntil) {
    c.executionCtx.waitUntil(backgroundTask);
  }

  return new Response(stream.readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

// Scroll/load more images (SSE stream) with auto-retry on 429
app.post("/api/imagine/scroll", async (c) => {
  const body = await c.req.json<{
    prompt: string;
    aspect_ratio?: string;
    enable_nsfw?: boolean;
    max_pages?: number;
  }>();

  const { prompt, aspect_ratio = "2:3", enable_nsfw = true, max_pages = 1 } = body;

  // Stream SSE response
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  const encoder = new TextEncoder();

  const writeEvent = async (event: string, data: unknown) => {
    await writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  };

  // Capture db reference before async context
  const db = c.env.DB;

  // Scroll with retry logic
  const backgroundTask = (async () => {
    const excludedTokenIds: string[] = [];
    const maxRetries = Math.max(1, await countActiveTokens(db));
    let retryCount = 0;
    const imagesPerPage = 6;
    const targetCount = max_pages * imagesPerPage;

    while (retryCount < maxRetries) {
      const token = await getRandomToken(db, excludedTokenIds);

      if (!token) {
        if (excludedTokenIds.length > 0) {
          await writeEvent("error", {
            type: "error",
            message: `All tokens rate limited (tried ${excludedTokenIds.length} tokens)`,
          });
        } else {
          await writeEvent("error", {
            type: "error",
            message: "No available tokens.",
          });
        }
        break;
      }

      try {
        for await (const update of generateImages(
          token.sso,
          token.sso_rw,
          prompt,
          targetCount,
          aspect_ratio,
          enable_nsfw,
          token.user_id,
          token.cf_clearance
        )) {
          if (update.type === "error") {
            const msg = update.message;

            if (msg.includes("429") || msg.includes("Rate limited") || msg.includes("rate_limit")) {
              excludedTokenIds.push(token.id);
              retryCount++;

              await writeEvent("info", {
                type: "info",
                message: `Token rate limited, switching (attempt ${retryCount}/${maxRetries})`,
              });
              break;
            } else {
              await writeEvent("error", update);
              await writer.close();
              return;
            }
          } else if (update.type === "image") {
            await writeEvent("image", update);
          } else if (update.type === "done") {
            await writeEvent("done", {});
            await writer.close();
            return;
          }
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);

        if (message.includes("429") || message.includes("Rate limited") || message.includes("rate_limit")) {
          excludedTokenIds.push(token.id);
          retryCount++;
          continue;
        } else {
          await writeEvent("error", { type: "error", message });
          break;
        }
      }
    }

    if (excludedTokenIds.length > 0 && retryCount >= maxRetries) {
      await writeEvent("error", {
        type: "error",
        message: `All tokens rate limited (tried ${excludedTokenIds.length} tokens)`,
      });
    } else {
      await writeEvent("done", {});
    }
    await writer.close();
  })().catch(console.error);

  // Use waitUntil if available
  if (c.executionCtx?.waitUntil) {
    c.executionCtx.waitUntil(backgroundTask);
  }

  return new Response(stream.readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

export { app as imagineRoutes };
