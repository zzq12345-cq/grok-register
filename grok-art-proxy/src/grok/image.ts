import { buildCookie, getHeaders } from "./headers";
import {
  generateImages as generateImagesWs,
  type ImageUpdate,
  type StreamUpdate,
} from "./imagine";

const CHAT_API = "https://grok.com/rest/app-chat/conversations/new";
const ASSETS_BASE = "https://assets.grok.com";
const IMAGINE_PUBLIC_BASE = "https://imagine-public.x.ai";
const IMAGE_EXT_PATTERN = /\.(?:jpg|jpeg|png|webp)(?:\?[^\s"'<>\\)]*)?$/i;
const ABSOLUTE_IMAGE_URL_PATTERN = /https?:\/\/[^\s"'<>\\]+?\.(?:jpg|jpeg|png|webp)(?:\?[^\s"'<>\\)]*)?/gi;
const RELATIVE_IMAGINE_URL_PATTERN = /\/imagine-public\/[^\s"'<>\\]+?\.(?:jpg|jpeg|png|webp)(?:\?[^\s"'<>\\)]*)?/gi;
const MAX_CHAT_BATCH_SIZE = 4;

interface RestImageCandidate {
  url: string;
  prompt: string;
  full_prompt: string;
  request_id: string;
  width: number;
  height: number;
  model_name: string;
}

interface RestCollectResult {
  images: RestImageCandidate[];
  error: string;
}

function buildImagePayload(
  prompt: string,
  count: number,
  aspectRatio: string,
  enableNsfw: boolean,
): Record<string, unknown> {
  return {
    temporary: true,
    modelName: "grok-3",
    modelMode: "MODEL_MODE_FAST",
    message: prompt,
    fileAttachments: [],
    imageAttachments: [],
    disableSearch: false,
    enableImageGeneration: true,
    returnImageBytes: false,
    returnRawGrokInXaiRequest: false,
    enableImageStreaming: true,
    imageGenerationCount: count,
    forceConcise: false,
    toolOverrides: { imageGen: true },
    enableSideBySide: true,
    sendFinalMetadata: true,
    isReasoning: false,
    disableTextFollowUps: false,
    disableMemory: false,
    forceSideBySide: false,
    isAsyncChat: false,
    disableSelfHarmShortCircuit: false,
    responseMetadata: {
      experiments: [],
      modelConfigOverride: {
        modelMap: {
          imageGenModelConfig: {
            aspectRatio,
            enableNsfw,
            imageGenerationCount: count,
          },
        },
      },
    },
  };
}

function isRateLimitMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("429")
    || lower.includes("rate limit")
    || lower.includes("rate_limit")
    || lower.includes("too many requests");
}

function normalizeImageUrl(rawUrl: string): string {
  const value = rawUrl.trim().replace(/[),]+$/, "");
  if (!value) return "";
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return IMAGE_EXT_PATTERN.test(value) ? value : "";
  }
  if (value.startsWith("/imagine-public/")) {
    return `${IMAGINE_PUBLIC_BASE}${value}`;
  }
  if (value.startsWith("/")) {
    return `${ASSETS_BASE}${value}`;
  }
  return "";
}

function extractImageUrls(text: string): string[] {
  const normalizedText = text.replace(/\\\//g, "/");
  const matches = [
    ...(normalizedText.match(ABSOLUTE_IMAGE_URL_PATTERN) ?? []),
    ...(normalizedText.match(RELATIVE_IMAGINE_URL_PATTERN) ?? []),
  ];

  const uniqueUrls = new Set<string>();
  for (const match of matches) {
    const normalized = normalizeImageUrl(match);
    if (normalized) uniqueUrls.add(normalized);
  }
  return Array.from(uniqueUrls);
}

function extractRequestId(text: string): string {
  const match = text.match(/"responseId"\s*:\s*"([^"]+)"/);
  return match?.[1] ?? "";
}

function extractErrorMessage(text: string): string {
  const normalizedText = text.replace(/\\\//g, "/");
  const lower = normalizedText.toLowerCase();

  if (isRateLimitMessage(normalizedText)) {
    return `Rate limited: ${normalizedText.slice(0, 240)}`;
  }
  if (
    lower.includes("unauthorized")
    || lower.includes("invalid token")
    || lower.includes("sign in")
    || lower.includes("login")
    || lower.includes(" 401")
    || lower.includes("\"401\"")
  ) {
    return `Unauthorized: ${normalizedText.slice(0, 240)}`;
  }
  if (
    lower.includes("cloudflare")
    || lower.includes("attention required")
    || lower.includes("access denied")
    || lower.includes("cf_clearance")
  ) {
    return `Upstream blocked: ${normalizedText.slice(0, 240)}`;
  }
  return "";
}

function toImageUpdate(candidate: RestImageCandidate, index: number): ImageUpdate {
  const jobId = candidate.url.match(/\/images\/([a-f0-9-]+)\.(?:jpg|jpeg|png|webp)/i)?.[1]
    ?? `chat-image-${index + 1}`;

  return {
    type: "image",
    job_id: jobId,
    request_id: candidate.request_id,
    url: candidate.url,
    image_src: candidate.url,
    has_blob: false,
    prompt: candidate.prompt,
    full_prompt: candidate.full_prompt,
    width: candidate.width,
    height: candidate.height,
    model_name: candidate.model_name,
    grid_index: index,
    order: index,
    r_rated: false,
    moderated: false,
  };
}

async function collectImagesViaChatBatch(
  sso: string,
  ssoRw: string,
  prompt: string,
  count: number,
  aspectRatio: string,
  enableNsfw: boolean,
  userId: string,
  cfClearance: string,
): Promise<RestCollectResult> {
  const cookie = buildCookie(sso, ssoRw, userId, cfClearance);
  const headers = getHeaders(cookie);
  const payload = buildImagePayload(prompt, count, aspectRatio, enableNsfw);

  let response: Response;
  try {
    response = await fetch(CHAT_API, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return {
      images: [],
      error: `Network error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    return {
      images: [],
      error: `HTTP ${response.status}: ${errorText.slice(0, 500)}`,
    };
  }

  if (!response.body) {
    return { images: [], error: "No response body" };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const urls = new Set<string>();
  let requestId = "";
  let lastError = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;

        const line = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
        if (!line || line === "[DONE]") continue;

        if (!requestId) {
          requestId = extractRequestId(line);
        }

        const errorMessage = extractErrorMessage(line);
        if (errorMessage) {
          lastError = errorMessage;
        }

        for (const url of extractImageUrls(line)) {
          urls.add(url);
          if (urls.size >= count) {
            break;
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const images = Array.from(urls).slice(0, count).map((url, index) => ({
    url,
    prompt,
    full_prompt: prompt,
    request_id: requestId || `chat-image-${index + 1}`,
    width: 0,
    height: 0,
    model_name: "grok-3",
  }));

  return {
    images,
    error: images.length > 0 ? "" : (lastError || "No images generated via app-chat"),
  };
}

export async function* generateImages(
  sso: string,
  ssoRw: string,
  prompt: string,
  count: number,
  aspectRatio: string,
  enableNsfw: boolean,
  userId: string = "",
  cfClearance: string = "",
): AsyncGenerator<StreamUpdate> {
  const targetCount = Math.max(1, count);
  const emittedUrls = new Set<string>();
  let completedCount = 0;
  let lastError = "";

  yield {
    type: "progress",
    job_id: "",
    status: "starting",
    percentage: 0,
    completed_count: 0,
    target_count: targetCount,
  };

  yield {
    type: "info",
    message: "优先使用 app-chat REST 生图...",
  };

  let restBatchIndex = 0;
  while (completedCount < targetCount) {
    restBatchIndex += 1;
    const batchCount = Math.min(MAX_CHAT_BATCH_SIZE, targetCount - completedCount);
    const result = await collectImagesViaChatBatch(
      sso,
      ssoRw,
      prompt,
      batchCount,
      aspectRatio,
      enableNsfw,
      userId,
      cfClearance,
    );

    let appendedThisBatch = 0;
    for (const image of result.images) {
      if (emittedUrls.has(image.url)) continue;
      emittedUrls.add(image.url);
      completedCount += 1;
      appendedThisBatch += 1;

      yield toImageUpdate(image, completedCount - 1);
      yield {
        type: "progress",
        job_id: image.request_id,
        status: "collecting",
        percentage: (completedCount / targetCount) * 100,
        completed_count: completedCount,
        target_count: targetCount,
      };

      if (completedCount >= targetCount) {
        yield { type: "done" };
        return;
      }
    }

    if (appendedThisBatch === 0) {
      lastError = result.error || lastError || "No images generated via app-chat";
      break;
    }

    if (result.images.length < batchCount || restBatchIndex >= Math.ceil(targetCount / MAX_CHAT_BATCH_SIZE)) {
      if (completedCount < targetCount) {
        lastError = result.error || `app-chat only returned ${completedCount}/${targetCount} images`;
      }
      break;
    }
  }

  const remainingCount = targetCount - completedCount;
  if (remainingCount <= 0) {
    yield { type: "done" };
    return;
  }

  yield {
    type: "info",
    message: `app-chat 未补齐图片，回退 ws_imagine（剩余 ${remainingCount} 张）`,
  };

  let fallbackError = "";
  for await (const update of generateImagesWs(
    sso,
    ssoRw,
    prompt,
    remainingCount,
    aspectRatio,
    enableNsfw,
    userId,
    cfClearance,
  )) {
    if (update.type === "image") {
      if (emittedUrls.has(update.url)) continue;
      emittedUrls.add(update.url);
      completedCount += 1;

      yield update;
      yield {
        type: "progress",
        job_id: update.job_id,
        status: "collecting",
        percentage: (completedCount / targetCount) * 100,
        completed_count: completedCount,
        target_count: targetCount,
      };

      if (completedCount >= targetCount) {
        yield { type: "done" };
        return;
      }
      continue;
    }

    if (update.type === "error") {
      fallbackError = update.message;
      yield update;
      return;
    }

    if (update.type === "info") {
      yield update;
    }
  }

  if (completedCount >= targetCount) {
    yield { type: "done" };
    return;
  }

  const finalError = fallbackError || lastError || "Failed to generate images";
  if (completedCount > 0 && isRateLimitMessage(finalError)) {
    yield { type: "error", message: finalError };
    return;
  }

  if (completedCount > 0) {
    yield {
      type: "info",
      message: `本次已返回 ${completedCount}/${targetCount} 张图片`,
    };
    yield { type: "done" };
    return;
  }

  yield { type: "error", message: finalError };
}

export type { ImageUpdate, StreamUpdate };

// REST-based token diagnostic types (mirrors imagine.ts for compatibility)
export type RestDiagnosticCode =
  | "ok"
  | "rate_limited"
  | "auth_invalid"
  | "upstream_blocked"
  | "rest_failed"
  | "unknown_error";

export interface RestDiagnosticResult {
  ok: boolean;
  code: RestDiagnosticCode;
  message: string;
  detail: string;
  checked_at: string;
  probe: "app_chat_rest";
  images_received: number;
}

function classifyRestError(errorText: string): Omit<RestDiagnosticResult, "checked_at"> {
  const detail = String(errorText || "Unknown error").slice(0, 500);
  const lower = detail.toLowerCase();

  if (isRateLimitMessage(detail)) {
    return {
      ok: false,
      code: "rate_limited",
      message: "上游返回速率限制",
      detail,
      probe: "app_chat_rest",
      images_received: 0,
    };
  }

  if (
    lower.includes("cloudflare")
    || lower.includes("attention required")
    || lower.includes("access denied")
    || lower.includes("cf_clearance")
    || lower.includes("captcha")
    || lower.includes("forbidden")
  ) {
    return {
      ok: false,
      code: "upstream_blocked",
      message: "上游拦截，可能需要额外验证或更换出口 IP",
      detail,
      probe: "app_chat_rest",
      images_received: 0,
    };
  }

  if (
    lower.includes("401")
    || lower.includes("unauthorized")
    || lower.includes("invalid token")
    || lower.includes("sign in")
    || lower.includes("login")
    || lower.includes("jwt")
  ) {
    return {
      ok: false,
      code: "auth_invalid",
      message: "鉴权失效，令牌可能已过期",
      detail,
      probe: "app_chat_rest",
      images_received: 0,
    };
  }

  if (lower.includes("http 5") || lower.includes("500") || lower.includes("502") || lower.includes("503")) {
    return {
      ok: false,
      code: "rest_failed",
      message: "上游服务暂时不可用",
      detail,
      probe: "app_chat_rest",
      images_received: 0,
    };
  }

  return {
    ok: false,
    code: "unknown_error",
    message: "未识别的上游错误",
    detail,
    probe: "app_chat_rest",
    images_received: 0,
  };
}

/**
 * REST-based token diagnostic probe using app-chat API.
 * This is the preferred diagnostic method as it matches the primary image generation path.
 */
export async function diagnoseImageTokenViaRest(
  sso: string,
  ssoRw: string,
  userId: string = "",
  cfClearance: string = "",
): Promise<RestDiagnosticResult> {
  const result = await collectImagesViaChatBatch(
    sso,
    ssoRw,
    "diagnostic probe",
    1,
    "1:1",
    false,
    userId,
    cfClearance,
  );

  if (result.images.length > 0) {
    return {
      ok: true,
      code: "ok",
      message: `连接正常，已收到 ${result.images.length} 条图片结果`,
      detail: "",
      checked_at: new Date().toISOString(),
      probe: "app_chat_rest",
      images_received: result.images.length,
    };
  }

  if (result.error) {
    const classified = classifyRestError(result.error);
    return {
      ...classified,
      checked_at: new Date().toISOString(),
    };
  }

  return {
    ok: false,
    code: "unknown_error",
    message: "未知错误：未生成图片但无错误信息",
    detail: "",
    checked_at: new Date().toISOString(),
    probe: "app_chat_rest",
    images_received: 0,
  };
}
