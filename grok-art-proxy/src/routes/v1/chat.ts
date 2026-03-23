import { Hono } from "hono";
import { streamChat } from "../../grok/chat";
import { countActiveTokens, getRandomToken, syncTokenUsage, markTokenCooling, recordTokenFail } from "../../repo/tokens";
import { incrementApiKeyUsage } from "../../repo/api-keys";
import { getModelInfo } from "../../grok/models";
import { addLog } from "../../repo/logs";
import type { ApiAuthEnv } from "../../middleware/api-auth";

const app = new Hono<ApiAuthEnv>();

interface ChatMessage {
  role: string;
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
}

interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

interface OpenAIErrorResponse {
  error: {
    message: string;
    type: string;
    code: string | null;
  };
}

function createErrorResponse(message: string, status: number): Response {
  const errorBody: OpenAIErrorResponse = {
    error: {
      message,
      type: status >= 500 ? "server_error" : "invalid_request_error",
      code: status === 429 ? "rate_limit_exceeded" : null,
    },
  };
  return new Response(JSON.stringify(errorBody), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Generate SSE chunk for streaming response
 */
function sseChunk(
  id: string,
  model: string,
  content: string = "",
  role: string | null = null,
  finishReason: string | null = null
): string {
  const delta: Record<string, string> = {};
  if (role) {
    delta.role = role;
    delta.content = "";
  } else if (content) {
    delta.content = content;
  }

  const chunk = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta,
        logprobs: null,
        finish_reason: finishReason,
      },
    ],
  };

  return `data: ${JSON.stringify(chunk)}\n\n`;
}

// POST /v1/chat/completions
app.post("/completions", async (c) => {
  const body = await c.req.json<ChatCompletionRequest>();

  const { model, messages, stream = false } = body;

  // Validate model
  const modelInfo = getModelInfo(model);
  if (!modelInfo) {
    return createErrorResponse(`Model '${model}' not found`, 404);
  }

  // Validate messages
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return createErrorResponse("messages is required and must be a non-empty array", 400);
  }

  // Get base URL for building full proxy URLs
  const reqUrl = new URL(c.req.url);
  const baseUrl = `${reqUrl.protocol}//${reqUrl.host}`;

  // Check if video poster preview is enabled
  const posterPreview = c.env.VIDEO_POSTER_PREVIEW === "true";

  const db = c.env.DB;
  const maxRetries = Math.max(1, await countActiveTokens(db));
  const excludedTokenIds: string[] = [];
  let retryCount = 0;

  // Streaming response
  if (stream) {
    const responseId = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const clientIp = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "unknown";

    const streamBody = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();

        // Send initial role chunk
        controller.enqueue(encoder.encode(sseChunk(responseId, model, "", "assistant", null)));

        let success = false;

        while (retryCount < maxRetries) {
          const token = await getRandomToken(db, excludedTokenIds);
          const tokenStartTime = Date.now();

          if (!token) {
            if (excludedTokenIds.length > 0) {
              controller.enqueue(
                encoder.encode(
                  sseChunk(responseId, model, `[Error: All tokens rate limited]`, null, null)
                )
              );
            } else {
              controller.enqueue(
                encoder.encode(
                  sseChunk(responseId, model, `[Error: No available tokens]`, null, null)
                )
              );
            }
            break;
          }

          try {
            for await (const update of streamChat(
              token.sso,
              token.sso_rw,
              messages,
              model,
              true, // showThinking
              token.id, // tokenId for video generation
              baseUrl, // baseUrl for building full proxy URLs
              posterPreview, // video poster preview
              token.user_id,
              token.cf_clearance
            )) {
              if (update.type === "error") {
                const msg = update.message || "";
                if (msg.includes("429") || msg.includes("rate") || msg.includes("401")) {
                  excludedTokenIds.push(token.id);
                  retryCount++;
                  await markTokenCooling(db, token.id);
                  await addLog(db, { ip: clientIp, action: "chat", token_id: token.id, duration: Date.now() - tokenStartTime, status: 429, error: msg }).catch(() => {});
                  break;
                }
                controller.enqueue(
                  encoder.encode(sseChunk(responseId, model, `[Error: ${msg}]`, null, null))
                );
                break;
              }

              if (update.type === "token" && update.content) {
                controller.enqueue(encoder.encode(sseChunk(responseId, model, update.content)));
              }

              if (update.type === "done") {
                await syncTokenUsage(db, token.id, 1);
                await addLog(db, { ip: clientIp, action: "chat", token_id: token.id, duration: Date.now() - tokenStartTime, status: 200 }).catch(() => {});
                success = true;
                break;
              }
            }

            if (success) break;
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            if (message.includes("429") || message.includes("rate")) {
              excludedTokenIds.push(token.id);
              retryCount++;
              await markTokenCooling(db, token.id);
              await addLog(db, { ip: clientIp, action: "chat", token_id: token.id, duration: Date.now() - tokenStartTime, status: 429, error: message }).catch(() => {});
              continue;
            }
            controller.enqueue(
              encoder.encode(sseChunk(responseId, model, `[Error: ${message}]`, null, null))
            );
            break;
          }
        }

        if (!success && excludedTokenIds.length > 0 && retryCount >= maxRetries) {
          controller.enqueue(
            encoder.encode(
              sseChunk(responseId, model, `[Error: All tokens rate limited (tried ${excludedTokenIds.length})]`, null, null)
            )
          );
        }

        // Send finish chunk
        controller.enqueue(encoder.encode(sseChunk(responseId, model, "", null, "stop")));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));

        // Update API key usage
        if (success) {
          const apiKeyInfo = c.get("apiKeyInfo");
          if (apiKeyInfo) {
            await incrementApiKeyUsage(c.env.DB, apiKeyInfo.id);
          }
        }

        controller.close();
      },
    });

    return new Response(streamBody, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  }

  // Non-streaming response
  let fullContent = "";
  let success = false;
  let lastError = "";
  const clientIp = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "unknown";

  while (retryCount < maxRetries) {
    const token = await getRandomToken(db, excludedTokenIds);
    const tokenStartTime = Date.now();

    if (!token) {
      if (excludedTokenIds.length > 0) {
        return createErrorResponse(`All tokens rate limited (tried ${excludedTokenIds.length})`, 429);
      }
      return createErrorResponse("No available tokens", 503);
    }

    try {
      for await (const update of streamChat(
        token.sso,
        token.sso_rw,
        messages,
        model,
        true, // showThinking
        token.id, // tokenId for video generation
        baseUrl, // baseUrl for building full proxy URLs
        posterPreview, // video poster preview
        token.user_id,
        token.cf_clearance
      )) {
        if (update.type === "error") {
          const msg = update.message || "";
          if (msg.includes("429") || msg.includes("rate") || msg.includes("401")) {
            excludedTokenIds.push(token.id);
            retryCount++;
            lastError = msg;
            await markTokenCooling(db, token.id);
            await addLog(db, { ip: clientIp, action: "chat", token_id: token.id, duration: Date.now() - tokenStartTime, status: 429, error: msg }).catch(() => {});
            break;
          }
          return createErrorResponse(msg, 500);
        }

        if (update.type === "token" && update.content) {
          fullContent += update.content;
        }

        if (update.type === "done") {
          await syncTokenUsage(db, token.id, 1);
          await addLog(db, { ip: clientIp, action: "chat", token_id: token.id, duration: Date.now() - tokenStartTime, status: 200 }).catch(() => {});
          success = true;
          break;
        }
      }

      if (success) break;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.includes("429") || message.includes("rate")) {
        excludedTokenIds.push(token.id);
        retryCount++;
        lastError = message;
        await markTokenCooling(db, token.id);
        await addLog(db, { ip: clientIp, action: "chat", token_id: token.id, duration: Date.now() - tokenStartTime, status: 429, error: message }).catch(() => {});
        continue;
      }
      return createErrorResponse(message, 500);
    }
  }

  if (!success) {
    if (excludedTokenIds.length > 0 && retryCount >= maxRetries) {
      return createErrorResponse(`All tokens rate limited (tried ${excludedTokenIds.length})`, 429);
    }

    return createErrorResponse(lastError || "Failed after retries", 429);
  }

  // Update API key usage
  const apiKeyInfo = c.get("apiKeyInfo");
  if (apiKeyInfo) {
    await incrementApiKeyUsage(c.env.DB, apiKeyInfo.id);
  }

  // Return non-streaming response
  return c.json({
    id: `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: fullContent,
        },
        logprobs: null,
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  });
});

export { app as chatRoutes };
