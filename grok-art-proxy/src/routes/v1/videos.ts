import { Hono } from "hono";
import type { Env } from "../../env";
import { countActiveTokens, getRandomToken, type TokenRow } from "../../repo/tokens";
import { generateVideo, type VideoUpdate } from "../../grok/video";
import { incrementApiKeyUsage } from "../../repo/api-keys";
import type { ApiAuthEnv } from "../../middleware/api-auth";

const app = new Hono<ApiAuthEnv>();

interface VideoGenerationRequest {
  model?: string;
  image_url: string;
  prompt?: string;
  duration?: number;
  resolution?: string;
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
 * Extract post_id from image URL or create a new media post.
 * Grok image URLs typically have format: https://assets.grok.com/{post_id}.png
 */
function extractPostIdFromUrl(imageUrl: string): string | null {
  try {
    const url = new URL(imageUrl);
    // Try to extract from path: /abc123.png -> abc123
    const match = url.pathname.match(/\/([a-zA-Z0-9_-]+)\.(png|jpg|jpeg|webp)$/i);
    if (match && match[1]) {
      return match[1];
    }
    return null;
  } catch {
    return null;
  }
}

// POST /v1/videos/generations
app.post("/generations", async (c) => {
  const body = await c.req.json<VideoGenerationRequest>();

  // Validate required fields
  if (!body.image_url) {
    return createErrorResponse("image_url is required", 400);
  }

  const {
    image_url,
    prompt = "",
    duration = 6,
    resolution = "720p",
  } = body;

  // Validate duration
  if (duration !== 6 && duration !== 10) {
    return createErrorResponse("duration must be 6 or 10", 400);
  }

  // Validate resolution
  if (resolution !== "480p" && resolution !== "720p") {
    return createErrorResponse("resolution must be '480p' or '720p'", 400);
  }

  const db = c.env.DB;

  // Try to extract post_id from URL
  const postId = extractPostIdFromUrl(image_url);
  const maxRetries = Math.max(1, await countActiveTokens(db));

  // Retry logic with token rotation
  const excludedTokenIds: string[] = [];
  let retryCount = 0;
  let videoUrl: string | null = null;
  let lastError = "";

  while (retryCount < maxRetries) {
    const token: TokenRow | null = await getRandomToken(db, excludedTokenIds);

    if (!token) {
      if (excludedTokenIds.length > 0) {
        return createErrorResponse(
          `All tokens rate limited (tried ${excludedTokenIds.length} tokens)`,
          429
        );
      }
      return createErrorResponse(
        "No available tokens. Please import tokens first.",
        503
      );
    }

    try {
      // Use extracted postId or empty string (generateVideo will create one)
      const actualPostId = postId || "";

      // Determine aspect ratio from resolution (default to square for video)
      const aspectRatio = "1:1";

      for await (const update of generateVideo(
        token.sso,
        token.sso_rw,
        token.user_id,
        token.cf_clearance,
        token.id,
        image_url,
        prompt,
        actualPostId,
        aspectRatio,
        duration,
        resolution,
        "custom"
      )) {
        if (update.type === "error") {
          const msg = update.message;

          // Check for 429 rate limit
          if (msg.includes("429") || msg.includes("Rate limited")) {
            excludedTokenIds.push(token.id);
            retryCount++;
            lastError = msg;
            break;
          }

          // Other error, return immediately
          return createErrorResponse(msg, 500);
        }

        if (update.type === "complete") {
          videoUrl = update.original_url;
        }

        if (update.type === "done" && videoUrl) {
          // Update API key usage statistics
          const apiKeyInfo = c.get("apiKeyInfo");
          if (apiKeyInfo) {
            await incrementApiKeyUsage(c.env.DB, apiKeyInfo.id);
          }
          // Success - return OpenAI-compatible response
          return c.json({
            created: Math.floor(Date.now() / 1000),
            data: [{ url: videoUrl }],
          });
        }
      }

      // If we have a video URL but loop ended, return it
      if (videoUrl) {
        // Update API key usage statistics
        const apiKeyInfo = c.get("apiKeyInfo");
        if (apiKeyInfo) {
          await incrementApiKeyUsage(c.env.DB, apiKeyInfo.id);
        }
        return c.json({
          created: Math.floor(Date.now() / 1000),
          data: [{ url: videoUrl }],
        });
      }

    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);

      if (message.includes("429") || message.includes("Rate limited")) {
        excludedTokenIds.push(token.id);
        retryCount++;
        lastError = message;
        continue;
      }

      return createErrorResponse(message, 500);
    }
  }

  // All retries exhausted
  if (excludedTokenIds.length > 0 && retryCount >= maxRetries) {
    return createErrorResponse(
      `All tokens rate limited (tried ${excludedTokenIds.length} tokens)`,
      429
    );
  }

  return createErrorResponse(
    lastError || "Video generation failed after multiple attempts",
    429
  );
});

export { app as videosRoutes };
