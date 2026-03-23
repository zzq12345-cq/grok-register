import { Hono } from "hono";
import type { Env } from "../env";
import { getRandomToken, getToken } from "../repo/tokens";

const ASSETS_BASE = "https://assets.grok.com";
const IMAGINE_PUBLIC_BASE = "https://imagine-public.x.ai";

export const proxyRoutes = new Hono<{ Bindings: Env }>();

function buildProxyHeaders(sso: string, sso_rw?: string, user_id?: string, cf_clearance?: string): Record<string, string> {
  // Cookie order matters - follow original project format
  let cookie = "";
  if (sso_rw) {
    cookie = `sso-rw=${sso_rw}; sso=${sso}`;
  } else {
    cookie = `sso-rw=${sso}; sso=${sso}`;
  }
  if (user_id) cookie += `; x-userid=${user_id}`;
  if (cf_clearance) cookie += `; cf_clearance=${cf_clearance}`;

  return {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Host": "assets.grok.com",
    "Pragma": "no-cache",
    "Sec-Ch-Ua": '"Chromium";v="136", "Google Chrome";v="136", "Not(A:Brand";v="24"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-site",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
    "Referer": "https://grok.com/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    "Cookie": cookie,
  };
}

// Proxy assets.grok.com and imagine-public.x.ai resources
// Usage: /api/proxy/assets/{path}
proxyRoutes.get("/api/proxy/assets/*", async (c) => {
  const url = new URL(c.req.url);
  const assetPath = url.pathname.replace(/^\/api\/proxy\/assets/, "");

  if (!assetPath || assetPath === "/") {
    return c.json({ success: false, error: "Missing asset path" }, 400);
  }

  // Determine upstream based on path
  const isImaginePublic = assetPath.startsWith("/imagine-public/");
  const upstream = isImaginePublic ? IMAGINE_PUBLIC_BASE : ASSETS_BASE;
  const targetUrl = `${upstream}${assetPath}`;

  let fetchHeaders: Record<string, string>;

  if (isImaginePublic) {
    // imagine-public.x.ai is a public CDN - use simple headers, no auth cookies
    fetchHeaders = {
      "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Referer": "https://grok.com/",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    };
  } else {
    // assets.grok.com requires authentication cookies
    const token = await getRandomToken(c.env.DB);
    if (!token) {
      return c.json({ success: false, error: "No available tokens" }, 503);
    }
    fetchHeaders = buildProxyHeaders(token.sso, token.sso_rw, token.user_id, token.cf_clearance);
  }

  try {
    const response = await fetch(targetUrl, {
      method: "GET",
      headers: fetchHeaders,
    });

    if (!response.ok) {
      return c.json({
        success: false,
        error: `Upstream error: ${response.status}`,
        url: targetUrl,
      }, response.status as 400 | 403 | 404 | 500);
    }

    // Get content type from response
    const contentType = response.headers.get("content-type") || "application/octet-stream";

    // Stream the response back
    return new Response(response.body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (e) {
    return c.json({
      success: false,
      error: e instanceof Error ? e.message : String(e),
    }, 500);
  }
});


// Direct video proxy with URL parameter
// Usage: /api/proxy/video?url=https://assets.grok.com/...&token=xxx
proxyRoutes.get("/api/proxy/video", async (c) => {
  const videoUrl = c.req.query("url");
  const tokenId = c.req.query("token");

  if (!videoUrl) {
    return c.json({ success: false, error: "Missing url parameter" }, 400);
  }

  // Validate URL
  if (!videoUrl.startsWith("https://assets.grok.com/")) {
    return c.json({ success: false, error: "Invalid URL: must be from assets.grok.com" }, 400);
  }

  // Get specified token or random token
  let token;
  if (tokenId) {
    token = await getToken(c.env.DB, tokenId);
  }
  if (!token) {
    token = await getRandomToken(c.env.DB);
  }
  if (!token) {
    return c.json({ success: false, error: "No available tokens" }, 503);
  }

  const headers = buildProxyHeaders(token.sso, token.sso_rw, token.user_id, token.cf_clearance);

  try {
    const response = await fetch(videoUrl, {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      return c.json({
        success: false,
        error: `Upstream error: ${response.status}`,
        url: videoUrl,
      }, response.status as 400 | 403 | 404 | 500);
    }

    const contentType = response.headers.get("content-type") || "video/mp4";

    return new Response(response.body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (e) {
    return c.json({
      success: false,
      error: e instanceof Error ? e.message : String(e),
    }, 500);
  }
});
