/**
 * Grok Rate Limits API — 同步 token 配额
 * 参考 grok2api: POST https://grok.com/rest/rate-limits
 */

import { getHeaders, buildCookie } from "./headers";

const RATE_LIMITS_API = "https://grok.com/rest/rate-limits";

export interface RateLimitsResult {
  remainingTokens: number | null;
  windowSizeSeconds: number | null;
  raw: Record<string, unknown>;
}

export interface SyncResult {
  success: boolean;
  remainingTokens: number | null;
  windowSizeSeconds: number | null;
  error?: string;
  isExpired?: boolean;
}

/**
 * 调用 Grok Rate Limits API 获取剩余配额
 */
export async function fetchRateLimits(
  sso: string,
  ssoRw: string = "",
  userId: string = "",
  cfClearance: string = ""
): Promise<SyncResult> {
  const cookie = buildCookie(sso, ssoRw, userId, cfClearance);
  const headers = getHeaders(cookie);

  const payload = {
    requestKind: "DEFAULT",
    modelName: "grok-4-1-thinking-1129",
  };

  try {
    const response = await fetch(RATE_LIMITS_API, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (response.status === 401) {
      const body = await response.text().catch(() => "");
      const bodyLower = body.toLowerCase();
      const isExpired = ["unauthorized", "not logged in", "unauthenticated", "bad-credentials"]
        .some(kw => bodyLower.includes(kw));

      return {
        success: false,
        remainingTokens: null,
        windowSizeSeconds: null,
        error: `Auth failed (401): ${body.slice(0, 200)}`,
        isExpired,
      };
    }

    if (response.status === 429) {
      return {
        success: false,
        remainingTokens: 0,
        windowSizeSeconds: null,
        error: "Rate limited (429)",
      };
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return {
        success: false,
        remainingTokens: null,
        windowSizeSeconds: null,
        error: `HTTP ${response.status}: ${body.slice(0, 200)}`,
      };
    }

    const data = await response.json<Record<string, unknown>>();

    let remainingTokens = data.remainingTokens as number | undefined;
    if (remainingTokens === undefined) {
      remainingTokens = data.remainingQueries as number | undefined;
    }

    // 提取 windowSizeSeconds
    let windowSizeSeconds: number | null = null;
    if (typeof data.windowSizeSeconds === "number") {
      windowSizeSeconds = data.windowSizeSeconds;
    } else if (data.limits && typeof data.limits === "object") {
      const limits = data.limits as Record<string, unknown>;
      if (typeof limits.windowSizeSeconds === "number") {
        windowSizeSeconds = limits.windowSizeSeconds;
      }
    } else if (data.rateLimits && typeof data.rateLimits === "object") {
      const rateLimits = data.rateLimits as Record<string, unknown>;
      if (typeof rateLimits.windowSizeSeconds === "number") {
        windowSizeSeconds = rateLimits.windowSizeSeconds;
      }
    }

    return {
      success: true,
      remainingTokens: remainingTokens ?? null,
      windowSizeSeconds,
    };
  } catch (e) {
    return {
      success: false,
      remainingTokens: null,
      windowSizeSeconds: null,
      error: `Network error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
