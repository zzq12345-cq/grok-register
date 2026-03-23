import { getWebSocketHeaders, buildCookie } from "./headers";

const WS_URL = "wss://grok.com/ws/imagine/listen";

export interface ImageResult {
  job_id: string;
  request_id: string;
  url: string;
  blob: string;
  prompt: string;
  full_prompt: string;
  width: number;
  height: number;
  model_name: string;
  grid_index: number;
  order: number;
  r_rated: boolean;
  moderated: boolean;
}

export interface ProgressUpdate {
  type: "progress";
  job_id: string;
  status: string;
  percentage: number;
  completed_count: number;
  target_count: number;
}

export interface ImageUpdate {
  type: "image";
  job_id: string;
  request_id: string;
  url: string;
  image_src: string;
  has_blob: boolean;
  prompt: string;
  full_prompt: string;
  width: number;
  height: number;
  model_name: string;
  grid_index: number;
  order: number;
  r_rated: boolean;
  moderated: boolean;
}

export interface ErrorUpdate {
  type: "error";
  message: string;
}

export interface InfoUpdate {
  type: "info";
  message: string;
}

export interface DoneUpdate {
  type: "done";
}

export type StreamUpdate = ProgressUpdate | ImageUpdate | ErrorUpdate | InfoUpdate | DoneUpdate;

export type TokenDiagnosticCode =
  | "ok"
  | "rate_limited"
  | "auth_invalid"
  | "ws_upgrade_failed"
  | "upstream_blocked"
  | "unknown_error";

export interface TokenDiagnosticResult {
  ok: boolean;
  code: TokenDiagnosticCode;
  message: string;
  detail: string;
  checked_at: string;
  probe: "imagine_ws";
  images_received: number;
}

function classifyDiagnosticError(message: string): Omit<TokenDiagnosticResult, "checked_at"> {
  const detail = String(message || "Unknown error");
  const lower = detail.toLowerCase();

  if (
    lower.includes("429")
    || lower.includes("rate limited")
    || lower.includes("rate_limit")
    || lower.includes("too many requests")
  ) {
    return {
      ok: false,
      code: "rate_limited",
      message: "上游返回速率限制",
      detail,
      probe: "imagine_ws",
      images_received: 0,
    };
  }

  if (
    lower.includes("cloudflare")
    || lower.includes("cf_clearance")
    || lower.includes("__cf$cv$params")
    || lower.includes("cdn-cgi/challenge-platform")
    || lower.includes("attention required")
    || lower.includes("captcha")
    || lower.includes("access denied")
    || lower.includes("please enable javascript")
    || lower.includes("forbidden")
  ) {
    return {
      ok: false,
      code: "upstream_blocked",
      message: "上游拦截，可能需要额外验证或更换出口 IP",
      detail,
      probe: "imagine_ws",
      images_received: 0,
    };
  }

  if (
    lower.includes("401")
    || lower.includes("unauthorized")
    || lower.includes("sign in")
    || lower.includes("login")
    || lower.includes("jwt")
    || lower.includes("invalid token")
  ) {
    return {
      ok: false,
      code: "auth_invalid",
      message: "鉴权失效，令牌可能已过期",
      detail,
      probe: "imagine_ws",
      images_received: 0,
    };
  }

  if (
    lower.includes("websocket upgrade failed")
    || lower.includes("websocket closed")
    || lower.includes("websocket error")
  ) {
    return {
      ok: false,
      code: "ws_upgrade_failed",
      message: "WebSocket 握手或连接失败",
      detail,
      probe: "imagine_ws",
      images_received: 0,
    };
  }

  return {
    ok: false,
    code: "unknown_error",
    message: "未识别的上游错误",
    detail,
    probe: "imagine_ws",
    images_received: 0,
  };
}

function buildRequest(
  prompt: string,
  aspectRatio: string,
  enableNsfw: boolean,
  isScroll: boolean
): Record<string, unknown> {
  return {
    type: "conversation.item.create",
    timestamp: Date.now(),
    item: {
      type: "message",
      content: [{
        requestId: crypto.randomUUID(),
        text: prompt,
        type: isScroll ? "input_scroll" : "input_text",
        properties: {
          section_count: 0,
          is_kids_mode: false,
          enable_nsfw: enableNsfw,
          skip_upsampler: false,
          is_initial: false,
          aspect_ratio: aspectRatio,
        },
      }],
    },
  };
}

interface WsMessage {
  type: string;
  job_id?: string;
  request_id?: string;
  url?: string;
  blob?: string;
  prompt?: string;
  full_prompt?: string;
  width?: number;
  height?: number;
  model_name?: string;
  grid_index?: number;
  order?: number;
  r_rated?: boolean;
  moderated?: boolean;
  current_status?: string;
  percentage_complete?: number;
  message?: string;
  err_code?: string;
  err_msg?: string;
}

async function connectAndReceive(
  sso: string,
  sso_rw: string,
  prompt: string,
  aspectRatio: string,
  enableNsfw: boolean,
  isScroll: boolean,
  timeoutMs: number = 30000,
  user_id: string = "",
  cf_clearance: string = ""
): Promise<ImageResult[]> {
  const cookie = buildCookie(sso, sso_rw, user_id, cf_clearance);
  const headers = getWebSocketHeaders(cookie);

  // Use fetch to establish WebSocket connection (Cloudflare Workers way)
  const response = await fetch(WS_URL.replace("wss://", "https://"), {
    headers: {
      ...headers,
      Upgrade: "websocket",
    },
  });

  const ws = response.webSocket;
  if (!ws) {
    let body = "";
    try { body = await response.text(); } catch {}
    throw new Error(`WebSocket upgrade failed: ${response.status} ${response.statusText} ${body}`.trim());
  }

  ws.accept();

  // Send request immediately after accept (connection is already open)
  const request = buildRequest(prompt, aspectRatio, enableNsfw, isScroll);
  ws.send(JSON.stringify(request));

  return new Promise((resolve, reject) => {
    const results: ImageResult[] = [];
    const receivedImages: Map<string, ImageResult> = new Map();
    const completedJobs = new Set<string>();
    const failedJobs = new Set<string>();

    const timeout = setTimeout(() => {
      ws.close();
      resolve(results);
    }, timeoutMs);

    ws.addEventListener("message", (event: MessageEvent) => {
      try {
        const data: WsMessage = JSON.parse(event.data as string);
        const msgType = data.type;

        if (msgType === "json") {
          const jobId = data.job_id || "";
          const status = data.current_status || "";
          const percentage = data.percentage_complete || 0;

          if (status === "completed" && percentage >= 100) {
            completedJobs.add(jobId);
          } else if (status === "error") {
            failedJobs.add(jobId);
          }
        } else if (msgType === "image") {
          const jobId = data.job_id || "";
          const blob = data.blob || "";
          const url = data.url || "";
          const blobLen = blob.length;

          if (jobId) {
            const existing = receivedImages.get(jobId);
            const existingBlobLen = existing?.blob?.length || 0;

            // Check if this is a full image (blob > 100KB or URL ends with .jpg)
            const isFullImage = blobLen > 100000 || url.endsWith(".jpg");

            // Update to larger blob
            if (!existing || blobLen > existingBlobLen) {
              const result: ImageResult = {
                job_id: jobId,
                request_id: data.request_id || "",
                url: url,
                blob: blob,
                prompt: data.prompt || "",
                full_prompt: data.full_prompt || "",
                width: data.width || 0,
                height: data.height || 0,
                model_name: data.model_name || "",
                grid_index: data.grid_index || 0,
                order: data.order || 0,
                r_rated: data.r_rated || false,
                moderated: data.moderated || false,
              };
              receivedImages.set(jobId, result);

              // Only add to results when we receive full image
              if (isFullImage && !result.moderated) {
                results.push(result);
              }
            }
          }
        } else if (msgType === "error") {
          // 优先使用 err_msg（Grok 返回的格式），其次 message
          const errorMsg = data.err_msg || data.message
            || (data.err_code ? `Error code: ${data.err_code}` : "")
            || `Unknown WS error (raw: ${JSON.stringify(data).slice(0, 200)})`;

          // 检查是否为 rate limit（包括 err_code 和消息内容匹配）
          const isRateLimit = data.err_code === "rate_limit_exceeded"
            || String(errorMsg).includes("429")
            || String(errorMsg).includes("Rate limit")
            || String(errorMsg).includes("rate_limit");

          if (isRateLimit) {
            clearTimeout(timeout);
            ws.close();
            reject(new Error(`Rate limited: ${errorMsg}`));
            return;
          }

          clearTimeout(timeout);
          ws.close();
          reject(new Error(String(errorMsg)));
          return;
        }

        // Check if batch is done (6 jobs completed or failed)
        const totalDone = completedJobs.size + failedJobs.size;
        if (totalDone >= 6) {
          clearTimeout(timeout);
          setTimeout(() => {
            ws.close();
            resolve(results);
          }, 300);
        }
      } catch {
        // Ignore parse errors
      }
    });

    ws.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("WebSocket error"));
    });

    ws.addEventListener("close", (event: CloseEvent) => {
      clearTimeout(timeout);
      if (event.code === 1008 || event.code === 429) {
        reject(new Error(`Rate limited (429) code=${event.code} reason=${event.reason || "none"}`));
      } else if (event.code >= 4000) {
        reject(new Error(`WebSocket closed: code=${event.code} reason=${event.reason || "none"}`));
      } else {
        resolve(results);
      }
    });
  });
}

export async function* generateImages(
  sso: string,
  sso_rw: string,
  prompt: string,
  count: number,
  aspectRatio: string,
  enableNsfw: boolean,
  user_id: string = "",
  cf_clearance: string = ""
): AsyncGenerator<StreamUpdate> {
  const collectedJobs = new Set<string>();
  const maxPages = Math.ceil(count / 6) + 2;

  yield {
    type: "progress",
    job_id: "",
    status: "starting",
    percentage: 0,
    completed_count: 0,
    target_count: count,
  };

  for (let page = 0; page < maxPages; page++) {
    if (collectedJobs.size >= count) break;

    const isScroll = page > 0;

    try {
      const images = await connectAndReceive(
        sso,
        sso_rw,
        prompt,
        aspectRatio,
        enableNsfw,
        isScroll,
        30000,
        user_id,
        cf_clearance
      );

      for (const img of images) {
        if (img.moderated || !img.url) continue;
        if (collectedJobs.has(img.job_id)) continue;

        collectedJobs.add(img.job_id);

        // Determine image source
        let imageSrc = img.url;
        if (img.blob) {
          if (img.blob.startsWith("data:")) {
            imageSrc = img.blob;
          } else if (img.blob.startsWith("/9j/")) {
            imageSrc = `data:image/jpeg;base64,${img.blob}`;
          } else {
            imageSrc = `data:image/png;base64,${img.blob}`;
          }
        }

        yield {
          type: "image",
          job_id: img.job_id,
          request_id: img.request_id,
          url: img.url,
          image_src: imageSrc,
          has_blob: Boolean(img.blob),
          prompt: img.prompt,
          full_prompt: img.full_prompt,
          width: img.width,
          height: img.height,
          model_name: img.model_name,
          grid_index: img.grid_index,
          order: img.order,
          r_rated: img.r_rated,
          moderated: img.moderated,
        };

        yield {
          type: "progress",
          job_id: img.job_id,
          status: "collecting",
          percentage: (collectedJobs.size / count) * 100,
          completed_count: collectedJobs.size,
          target_count: count,
        };

        if (collectedJobs.size >= count) break;
      }

    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.includes("429") || message.includes("Rate limited") || message.includes("rate_limit")) {
        yield { type: "error", message: `Rate limited: ${message}` };
        return;
      }
      yield { type: "error", message };
      return;
    }

    // Small delay between pages
    if (page < maxPages - 1 && collectedJobs.size < count) {
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }

  yield { type: "done" };
}

export async function diagnoseImageToken(
  sso: string,
  sso_rw: string,
  user_id: string = "",
  cf_clearance: string = ""
): Promise<TokenDiagnosticResult> {
  try {
    const images = await connectAndReceive(
      sso,
      sso_rw,
      "diagnostic probe",
      "1:1",
      false,
      false,
      6000,
      user_id,
      cf_clearance
    );

    return {
      ok: true,
      code: "ok",
      message: images.length > 0
        ? `连接正常，已收到 ${images.length} 条图片结果`
        : "连接正常，未见即时限流或鉴权错误",
      detail: "",
      checked_at: new Date().toISOString(),
      probe: "imagine_ws",
      images_received: images.length,
    };
  } catch (e) {
    const classified = classifyDiagnosticError(e instanceof Error ? e.message : String(e));
    return {
      ...classified,
      checked_at: new Date().toISOString(),
    };
  }
}
