/**
 * Grok Chat Service - Text/Image/Video completion via REST API
 */

import { toGrokModel, isImageModel, isVideoModel, requiresInputImage, parseModelWithRatio } from "./models";
import { getHeaders, buildCookie } from "./headers";
import { generateImages } from "./image";
import { generateVideo } from "./video";

const CHAT_API = "https://grok.com/rest/app-chat/conversations/new";
const ASSETS_BASE = "https://assets.grok.com";
const IMAGINE_PUBLIC_BASE = "https://imagine-public.x.ai";

/**
 * Rewrite Grok asset URLs to go through the local proxy
 */
function rewriteAssetUrl(url: string, baseUrl: string): string {
  if (!baseUrl) return url;
  if (url.startsWith(ASSETS_BASE)) {
    const path = url.slice(ASSETS_BASE.length);
    return `${baseUrl}/api/proxy/assets${path}`;
  }
  if (url.startsWith(IMAGINE_PUBLIC_BASE)) {
    const path = url.slice(IMAGINE_PUBLIC_BASE.length);
    return `${baseUrl}/api/proxy/assets${path}`;
  }
  return url;
}

/**
 * Build video poster preview HTML (clickable poster with play button overlay)
 */
function buildVideoPosterPreview(videoUrl: string, posterUrl?: string): string {
  const href = String(videoUrl || "").replace(/"/g, "&quot;");
  const poster = String(posterUrl || "").replace(/"/g, "&quot;");
  if (!href) return "";
  if (!poster) return `<a href="${href}" target="_blank" rel="noopener noreferrer">${href}</a>\n`;
  return `<a href="${href}" target="_blank" rel="noopener noreferrer" style="display:inline-block;position:relative;max-width:100%;text-decoration:none;">
  <img src="${poster}" alt="video" style="max-width:100%;height:auto;border-radius:12px;display:block;" />
  <span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;">
    <span style="width:64px;height:64px;border-radius:9999px;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;">
      <span style="width:0;height:0;border-top:12px solid transparent;border-bottom:12px solid transparent;border-left:18px solid #fff;margin-left:4px;"></span>
    </span>
  </span>
</a>\n`;
}

/**
 * Build video output based on poster preview setting
 */
function buildVideoOutput(videoUrl: string, posterUrl: string | undefined, posterPreview: boolean): string {
  if (posterPreview) {
    return buildVideoPosterPreview(videoUrl, posterUrl);
  }
  return `![video](${videoUrl})\n\n[下载视频](${videoUrl})\n`;
}

interface ChatMessage {
  role: string;
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
}

interface GrokChatPayload {
  temporary: boolean;
  modelName: string;
  modelMode: string;
  message: string;
  fileAttachments: string[];
  imageAttachments: string[];
  disableSearch: boolean;
  enableImageGeneration: boolean;
  returnImageBytes: boolean;
  returnRawGrokInXaiRequest: boolean;
  enableImageStreaming: boolean;
  imageGenerationCount: number;
  forceConcise: boolean;
  toolOverrides: Record<string, unknown>;
  enableSideBySide: boolean;
  sendFinalMetadata: boolean;
  isReasoning: boolean;
  disableTextFollowUps: boolean;
  disableMemory: boolean;
  forceSideBySide: boolean;
  isAsyncChat: boolean;
  disableSelfHarmShortCircuit: boolean;
}

/**
 * Extract image URLs from text content
 */
function extractImageUrlsFromText(text: string): string[] {
  const imageUrlPattern = /https?:\/\/[^\s<>"{}|\\^`\[\]]+\.(?:jpg|jpeg|png|gif|webp)/gi;
  const matches = text.match(imageUrlPattern);
  return matches || [];
}

/**
 * Extract postId from Grok image URL
 * URL format: https://imagine-public.x.ai/imagine-public/images/{postId}.jpg
 */
function extractPostIdFromUrl(imageUrl: string): string | null {
  const match = imageUrl.match(/\/images\/([a-f0-9-]+)\.(jpg|jpeg|png)/i);
  return match ? (match[1] ?? null) : null;
}

/**
 * Extract text content and image URLs from OpenAI messages format
 */
function extractMessages(messages: ChatMessage[]): { text: string; imageUrls: string[] } {
  const texts: string[] = [];
  const imageUrls: string[] = [];

  for (const msg of messages) {
    const role = msg.role || "user";
    let content = "";

    if (typeof msg.content === "string") {
      content = msg.content;
      // Also extract image URLs from text content
      const urlsInText = extractImageUrlsFromText(content);
      imageUrls.push(...urlsInText);
    } else if (Array.isArray(msg.content)) {
      for (const item of msg.content) {
        if (item.type === "text" && item.text) {
          content += item.text;
          // Also extract image URLs from text content
          const urlsInText = extractImageUrlsFromText(item.text);
          imageUrls.push(...urlsInText);
        } else if (item.type === "image_url" && item.image_url?.url) {
          imageUrls.push(item.image_url.url);
        }
      }
    }

    if (content.trim()) {
      if (role === "system") {
        texts.push(`[System]: ${content}`);
      } else if (role === "assistant") {
        texts.push(`[Assistant]: ${content}`);
      } else {
        texts.push(content);
      }
    }
  }

  return { text: texts.join("\n\n"), imageUrls };
}

/**
 * Build Grok chat payload for text/image generation
 */
function buildPayload(
  message: string,
  grokModel: string,
  modelMode: string,
  enableImageGeneration: boolean = false,
  imageCount: number = 4
): GrokChatPayload {
  return {
    temporary: true,
    modelName: grokModel,
    modelMode: modelMode,
    message: message,
    fileAttachments: [],
    imageAttachments: [],
    disableSearch: false,
    enableImageGeneration: enableImageGeneration,
    returnImageBytes: false,
    returnRawGrokInXaiRequest: false,
    enableImageStreaming: enableImageGeneration,
    imageGenerationCount: enableImageGeneration ? imageCount : 0,
    forceConcise: false,
    toolOverrides: {},
    enableSideBySide: true,
    sendFinalMetadata: true,
    isReasoning: false,
    disableTextFollowUps: false,
    disableMemory: false,
    forceSideBySide: false,
    isAsyncChat: false,
    disableSelfHarmShortCircuit: false,
  };
}

export interface ChatUpdate {
  type: "token" | "done" | "error";
  content?: string;
  responseId?: string;
  message?: string;
}

/**
 * Stream text chat completion from Grok API
 */
async function* streamTextChat(
  sso: string,
  ssoRw: string,
  text: string,
  modelId: string,
  showThinking: boolean = true,
  userId: string = "",
  cfClearance: string = ""
): AsyncGenerator<ChatUpdate> {
  const modelInfo = toGrokModel(modelId);
  if (!modelInfo) {
    yield { type: "error", message: `Unknown model: ${modelId}` };
    return;
  }

  const cookie = buildCookie(sso, ssoRw, userId, cfClearance);
  const headers = getHeaders(cookie);
  const payload = buildPayload(text, modelInfo.grokModel, modelInfo.modelMode, false);

  let response: Response;
  try {
    response = await fetch(CHAT_API, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(payload),
    });
  } catch (e) {
    yield { type: "error", message: `Network error: ${e instanceof Error ? e.message : String(e)}` };
    return;
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    yield { type: "error", message: `HTTP ${response.status}: ${errorText.slice(0, 500)}` };
    return;
  }

  if (!response.body) {
    yield { type: "error", message: "No response body" };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let responseId = "";
  let isThinking = false;
  let thinkingFinished = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const data = JSON.parse(line);
          const resp = data?.result?.response;
          if (!resp) continue;

          if (resp.responseId && !responseId) {
            responseId = resp.responseId;
          }

          // modelResponse - final response
          if (resp.modelResponse) {
            if (isThinking && showThinking) {
              yield { type: "token", content: "\n</think>\n", responseId };
              isThinking = false;
            }
            break;
          }

          // Token streaming with isThinking state tracking
          if (resp.token !== undefined && resp.token !== null) {
            const token = String(resp.token);
            if (!token) continue;

            const currentIsThinking = Boolean(resp.isThinking);

            if (thinkingFinished && currentIsThinking) continue;

            let content = token;

            if (!isThinking && currentIsThinking) {
              if (showThinking) {
                content = `<think>\n${content}`;
              } else {
                continue;
              }
            } else if (isThinking && !currentIsThinking) {
              if (showThinking) {
                content = `\n</think>\n${content}`;
              }
              thinkingFinished = true;
            } else if (currentIsThinking && !showThinking) {
              continue;
            }

            yield { type: "token", content, responseId };
            isThinking = currentIsThinking;
          }
        } catch {
          // Skip invalid JSON lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (isThinking && showThinking) {
    yield { type: "token", content: "\n</think>\n", responseId };
  }

  yield { type: "done", responseId };
}

/**
 * Stream image generation - returns markdown images
 * This function yields progress updates and handles 429 errors by returning them to the route layer
 */
async function* streamImageGeneration(
  sso: string,
  ssoRw: string,
  prompt: string,
  aspectRatio: string = "1:1",
  showThinking: boolean = true,
  baseUrl: string = "",
  userId: string = "",
  cfClearance: string = ""
): AsyncGenerator<ChatUpdate> {
  yield { type: "token", content: "<think>\n" };
  yield { type: "token", content: "开始生成图片...\n" };

  // Store image sources: prefer base64 data (image_src) over URL
  let imageSources: string[] = [];
  let lastProgress = 0;

  for await (const update of generateImages(sso, ssoRw, prompt, 4, aspectRatio, true, userId, cfClearance)) {
    if (update.type === "progress") {
      // Only output when progress changes significantly
      if (update.completed_count > lastProgress) {
        lastProgress = update.completed_count;
        yield {
          type: "token",
          content: `已收集 ${update.completed_count}/${update.target_count} 张图片\n`,
        };
      }
    } else if (update.type === "image") {
      // Always use proxied URL (verified: proxy returns correct JPEG images)
      imageSources.push(rewriteAssetUrl(update.url, baseUrl));
    } else if (update.type === "error") {
      // Pass 429/rate limit errors to route layer for token rotation
      if (update.message.includes("429") || update.message.includes("Rate limited")) {
        yield { type: "token", content: `遇到速率限制，切换账号重试...\n</think>\n` };
        yield { type: "error", message: update.message };
        return;
      }
      // Other errors
      yield { type: "token", content: `错误: ${update.message}\n</think>\n` };
      yield { type: "error", message: update.message };
      return;
    }
  }

  yield { type: "token", content: "</think>\n\n" };

  if (imageSources.length === 0) {
    // No images collected - this might happen if WebSocket failed silently
    yield { type: "token", content: "图片生成失败，未获取到图片。\n" };
    yield { type: "error", message: "No images generated" };
    return;
  }

  yield { type: "token", content: `生成了 ${imageSources.length} 张图片：\n\n` };
  for (let i = 0; i < imageSources.length; i++) {
    yield { type: "token", content: `![image-${i + 1}](${imageSources[i]})\n\n` };
  }


  yield { type: "done" };
}

/**
 * Stream video generation from image URL
 */
async function* streamVideoFromImage(
  sso: string,
  ssoRw: string,
  prompt: string,
  imageUrl: string,
  tokenId: string,
  baseUrl: string,
  posterPreview: boolean = false,
  showThinking: boolean = true,
  userId: string = "",
  cfClearance: string = ""
): AsyncGenerator<ChatUpdate> {
  yield { type: "token", content: "<think>\n" };
  yield { type: "token", content: `使用图片: ${imageUrl}\n` };

  // Extract postId from image URL
  const postId = extractPostIdFromUrl(imageUrl);
  if (!postId) {
    yield { type: "token", content: "错误: 无法从图片URL提取postId，请使用Grok生成的图片\n</think>\n" };
    yield { type: "error", message: "Invalid image URL: must be a Grok-generated image" };
    return;
  }

  yield { type: "token", content: `提取到 postId: ${postId}\n` };
  let lastProgress = -1;

  for await (const update of generateVideo(
    sso,
    ssoRw,
    userId,
    cfClearance,
    tokenId,
    imageUrl,
    prompt,
    postId,
    "16:9",
    5,
    "540p",
    "auto"
  )) {
    if (update.type === "progress") {
      // Only output when progress changes
      if (update.progress !== lastProgress) {
        lastProgress = update.progress;
        yield {
          type: "token",
          content: `视频生成中... ${update.progress}%\n`,
        };
      }
    } else if (update.type === "complete") {
      // Build full proxy URLs with baseUrl
      const fullVideoUrl = baseUrl ? `${baseUrl}${update.video_url}` : update.video_url;
      // Use source image as poster (thumbnailImageUrl is often not available)
      const posterUrl = imageUrl;

      yield { type: "token", content: "</think>\n\n" };
      yield { type: "token", content: `视频生成完成！\n\n` };
      yield { type: "token", content: buildVideoOutput(fullVideoUrl, posterUrl, posterPreview) };
    } else if (update.type === "error") {
      // Pass 429/rate limit errors to route layer for token rotation
      const msg = update.message || "";
      if (msg.includes("429") || msg.includes("rate") || msg.includes("401")) {
        yield { type: "token", content: `遇到速率限制，切换账号重试...\n</think>\n` };
        yield { type: "error", message: msg };
        return;
      }
      yield { type: "token", content: `错误: ${msg}\n</think>\n` };
      yield { type: "error", message: msg };
      return;
    }
  }

  yield { type: "done" };
}

/**
 * Stream one-click video generation (image + video)
 */
async function* streamOneClickVideo(
  sso: string,
  ssoRw: string,
  prompt: string,
  tokenId: string,
  baseUrl: string,
  aspectRatio: string = "16:9",
  posterPreview: boolean = false,
  showThinking: boolean = true,
  userId: string = "",
  cfClearance: string = ""
): AsyncGenerator<ChatUpdate> {
  yield { type: "token", content: "<think>\n" };
  yield { type: "token", content: "开始一键生成视频...\n\n" };

  // Step 1: Generate image
  yield { type: "token", content: "【第一步】生成图片\n" };

  let imageUrl: string | null = null;
  let lastProgress = 0;

  for await (const update of generateImages(sso, ssoRw, prompt, 1, aspectRatio, true, userId, cfClearance)) {
    if (update.type === "progress") {
      if (update.completed_count > lastProgress) {
        lastProgress = update.completed_count;
        yield {
          type: "token",
          content: `图片生成中... ${update.completed_count}/${update.target_count}\n`,
        };
      }
    } else if (update.type === "image") {
      imageUrl = update.url;
      yield { type: "token", content: `图片生成完成: ${imageUrl}\n\n` };
    } else if (update.type === "error") {
      // Pass 429/rate limit errors to route layer for token rotation
      const msg = update.message || "";
      if (msg.includes("429") || msg.includes("Rate limited")) {
        yield { type: "token", content: `遇到速率限制，切换账号重试...\n</think>\n` };
        yield { type: "error", message: msg };
        return;
      }
      yield { type: "token", content: `图片生成错误: ${msg}\n</think>\n` };
      yield { type: "error", message: `图片生成失败: ${msg}` };
      return;
    }
  }

  if (!imageUrl) {
    yield { type: "token", content: "图片生成失败，无法继续生成视频。\n</think>\n" };
    yield { type: "error", message: "图片生成失败" };
    return;
  }

  // Extract postId from generated image URL
  const postId = extractPostIdFromUrl(imageUrl);
  if (!postId) {
    yield { type: "token", content: "错误: 无法从图片URL提取postId\n</think>\n" };
    yield { type: "error", message: "Failed to extract postId from image URL" };
    return;
  }

  // Step 2: Generate video from image
  yield { type: "token", content: "【第二步】生成视频\n" };
  yield { type: "token", content: `使用 postId: ${postId}\n` };

  let lastVideoProgress = -1;

  for await (const update of generateVideo(
    sso,
    ssoRw,
    userId,
    cfClearance,
    tokenId,
    imageUrl,
    prompt,
    postId,
    aspectRatio,
    5,
    "540p",
    "auto"
  )) {
    if (update.type === "progress") {
      if (update.progress !== lastVideoProgress) {
        lastVideoProgress = update.progress;
        yield {
          type: "token",
          content: `视频生成中... ${update.progress}%\n`,
        };
      }
    } else if (update.type === "complete") {
      // Build full proxy URLs with baseUrl
      const fullVideoUrl = baseUrl ? `${baseUrl}${update.video_url}` : update.video_url;
      // Use source image as poster
      const posterUrl = imageUrl;

      yield { type: "token", content: "</think>\n\n" };
      yield { type: "token", content: `视频生成完成！\n\n` };
      yield { type: "token", content: buildVideoOutput(fullVideoUrl, posterUrl, posterPreview) };
    } else if (update.type === "error") {
      // Pass 429/rate limit errors to route layer for token rotation
      const msg = update.message || "";
      if (msg.includes("429") || msg.includes("rate") || msg.includes("401")) {
        yield { type: "token", content: `遇到速率限制，切换账号重试...\n</think>\n` };
        yield { type: "error", message: msg };
        return;
      }
      yield { type: "token", content: `视频生成错误: ${msg}\n</think>\n` };
      yield { type: "error", message: `视频生成失败: ${msg}` };
      return;
    }
  }

  yield { type: "done" };
}

/**
 * Main entry point - stream chat completion based on model type
 */
export async function* streamChat(
  sso: string,
  ssoRw: string,
  messages: ChatMessage[],
  modelId: string,
  showThinking: boolean = true,
  tokenId: string = "",
  baseUrl: string = "",
  posterPreview: boolean = false,
  userId: string = "",
  cfClearance: string = ""
): AsyncGenerator<ChatUpdate> {
  const { text, imageUrls } = extractMessages(messages);

  if (!text.trim()) {
    yield { type: "error", message: "Empty message" };
    return;
  }

  // Parse model to get aspect ratio
  const { aspectRatio } = parseModelWithRatio(modelId);

  // Handle grok-image model
  if (isImageModel(modelId)) {
    yield* streamImageGeneration(sso, ssoRw, text, aspectRatio, showThinking, baseUrl, userId, cfClearance);
    return;
  }

  // Handle grok-video model (one-click video generation)
  if (isVideoModel(modelId)) {
    yield* streamOneClickVideo(sso, ssoRw, text, tokenId, baseUrl, aspectRatio, posterPreview, showThinking, userId, cfClearance);
    return;
  }

  // Handle text models
  yield* streamTextChat(sso, ssoRw, text, modelId, showThinking, userId, cfClearance);
}

/**
 * Non-streaming chat completion
 */
export async function chatCompletion(
  sso: string,
  ssoRw: string,
  messages: ChatMessage[],
  modelId: string,
  showThinking: boolean = true,
  tokenId: string = "",
  baseUrl: string = "",
  posterPreview: boolean = false,
  userId: string = "",
  cfClearance: string = ""
): Promise<{ content: string; responseId: string } | { error: string }> {
  let content = "";
  let responseId = "";

  for await (const update of streamChat(sso, ssoRw, messages, modelId, showThinking, tokenId, baseUrl, posterPreview, userId, cfClearance)) {
    if (update.type === "error") {
      return { error: update.message || "Unknown error" };
    }
    if (update.type === "token") {
      content += update.content || "";
    }
    if (update.responseId) {
      responseId = update.responseId;
    }
  }

  return { content, responseId };
}
