import { getHeaders, buildCookie, generateStatsigId } from "./headers";

const CHAT_API = "https://grok.com/rest/app-chat/conversations/new";
const LIKE_API = "https://grok.com/rest/media/post/like";
const CREATE_POST_API = "https://grok.com/rest/media/post/create";

export interface VideoProgress {
  type: "progress";
  video_id: string;
  progress: number;
  prompt: string;
  image_url: string;
  width: number;
  height: number;
  resolution: string;
  moderated: boolean;
}

export interface VideoResult {
  type: "complete";
  video_id: string;
  video_url: string;
  original_url: string;
  thumbnail_url: string;
  token_id: string;
  message: string;
}

export interface VideoError {
  type: "error";
  message: string;
}

export interface VideoDone {
  type: "done";
}

export type VideoUpdate = VideoProgress | VideoResult | VideoError | VideoDone;

async function createMediaPost(
  imageUrl: string,
  cookie: string
): Promise<string | null> {
  const headers = getHeaders(cookie, "https://grok.com/imagine");

  // Try .jpg version first if it's .png
  const urlsToTry = [imageUrl];
  if (imageUrl.endsWith(".png")) {
    urlsToTry.unshift(imageUrl.slice(0, -4) + ".jpg");
  }

  for (const url of urlsToTry) {
    try {
      const response = await fetch(CREATE_POST_API, {
        method: "POST",
        headers,
        body: JSON.stringify({ media_url: url }),
      });

      if (response.ok) {
        const data = await response.json() as { post?: { id?: string } };
        const postId = data.post?.id;
        if (postId) return postId;
      }
    } catch {
      // Try next URL
    }
  }

  return null;
}

async function likePost(postId: string, cookie: string): Promise<boolean> {
  const headers = getHeaders(cookie, `https://grok.com/imagine/post/${postId}`);

  try {
    const response = await fetch(LIKE_API, {
      method: "POST",
      headers,
      body: JSON.stringify({ id: postId }),
    });

    return response.ok;
  } catch {
    return false;
  }
}

function buildVideoPayload(
  imageUrl: string,
  prompt: string,
  parentPostId: string,
  aspectRatio: string,
  videoLength: number,
  resolution: string,
  mode: string
): Record<string, unknown> {
  const message = `${imageUrl}  ${prompt} --mode=${mode}`;

  return {
    temporary: true,
    modelName: "grok-3",
    message,
    toolOverrides: { videoGen: true },
    enableSideBySide: true,
    responseMetadata: {
      experiments: [],
      modelConfigOverride: {
        modelMap: {
          videoGenModelConfig: {
            parentPostId,
            aspectRatio,
            videoLength,
            isVideoEdit: false,
            resolutionName: resolution,
          },
        },
      },
    },
  };
}

export async function* generateVideo(
  sso: string,
  sso_rw: string,
  user_id: string,
  cf_clearance: string,
  token_id: string,
  imageUrl: string,
  prompt: string,
  parentPostId: string,
  aspectRatio: string,
  videoLength: number,
  resolution: string,
  mode: string
): AsyncGenerator<VideoUpdate> {
  // Build cookie with all credentials
  const cookie = buildCookie(sso, sso_rw, user_id, cf_clearance);

  let actualPostId = parentPostId;

  // Try to like the post first
  let liked = await likePost(actualPostId, cookie);

  if (!liked) {
    // Create media post and try again
    const createdPostId = await createMediaPost(imageUrl, cookie);
    if (createdPostId) {
      actualPostId = createdPostId;
      liked = await likePost(actualPostId, cookie);
    }
  }

  const headers = getHeaders(cookie, `https://grok.com/imagine/post/${actualPostId}`);
  const payload = buildVideoPayload(
    imageUrl,
    prompt,
    actualPostId,
    aspectRatio,
    videoLength,
    resolution,
    mode
  );

  try {
    const response = await fetch(CHAT_API, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      yield { type: "error", message: `HTTP ${response.status}: ${text.slice(0, 200)}` };
      return;
    }

    if (!response.body) {
      yield { type: "error", message: "No response body" };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let videoId: string | null = null;
    let videoUrl: string | null = null;
    let thumbnailUrl: string | null = null;
    let lastProgress = -1;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const data = JSON.parse(line) as Record<string, unknown>;
          const result = (data.result as Record<string, unknown>)?.response as Record<string, unknown> | undefined;
          const videoResp = result?.streamingVideoGenerationResponse as Record<string, unknown> | undefined;

          if (videoResp) {
            const progress = (videoResp.progress as number) || 0;
            videoId = (videoResp.videoPostId as string) || (videoResp.videoId as string) || videoId;
            const url = videoResp.videoUrl as string | undefined;
            const thumb = videoResp.thumbnailImageUrl as string | undefined;

            if (url) videoUrl = url;
            if (thumb) thumbnailUrl = thumb;

            // Check moderation
            if (videoResp.moderated) {
              yield { type: "error", message: "Video generation blocked: content moderated" };
              return;
            }

            // Only yield on progress change
            if (progress !== lastProgress) {
              lastProgress = progress;
              yield {
                type: "progress",
                video_id: videoId || "",
                progress,
                prompt: (videoResp.videoPrompt as string) || "",
                image_url: (videoResp.imageReference as string) || "",
                width: (videoResp.width as number) || 0,
                height: (videoResp.height as number) || 0,
                resolution: (videoResp.resolutionName as string) || "",
                moderated: false,
              };
            }
          }
        } catch {
          // Invalid JSON line, skip
        }
      }
    }

    if (videoUrl && videoId) {
      const originalUrl = videoUrl.startsWith("http")
        ? videoUrl
        : `https://assets.grok.com/${videoUrl.replace(/^\//, "")}`;

      // Return proxy URL for frontend to use
      const proxyUrl = `/api/proxy/video?url=${encodeURIComponent(originalUrl)}&token=${encodeURIComponent(token_id)}`;

      // Build thumbnail proxy URL if available
      let thumbnailProxyUrl = "";
      if (thumbnailUrl) {
        const originalThumbUrl = thumbnailUrl.startsWith("http")
          ? thumbnailUrl
          : `https://assets.grok.com/${thumbnailUrl.replace(/^\//, "")}`;
        thumbnailProxyUrl = `/api/proxy/assets/${encodeURIComponent(originalThumbUrl)}?token=${encodeURIComponent(token_id)}`;
      }

      yield {
        type: "complete",
        video_id: videoId,
        video_url: proxyUrl,
        original_url: originalUrl,
        thumbnail_url: thumbnailProxyUrl,
        token_id: token_id,
        message: `Video generated: ${prompt}`,
      };
    } else {
      yield { type: "error", message: "Video generation incomplete: no videoUrl received" };
      return;
    }

    yield { type: "done" };

  } catch (e) {
    yield { type: "error", message: e instanceof Error ? e.message : String(e) };
  }
}
