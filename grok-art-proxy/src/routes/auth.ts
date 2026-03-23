import { Hono } from "hono";
import type { Env } from "../env";

type HonoEnv = { Bindings: Env };

const app = new Hono<HonoEnv>();

// Simple session token generation
async function generateSessionToken(username: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(`${username}:${Date.now()}:${Math.random()}`);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Login endpoint
app.post("/api/auth/login", async (c) => {
  const body = await c.req.json<{ username: string; password: string }>();
  const { username, password } = body;

  const authUsername = c.env.AUTH_USERNAME;
  const authPassword = c.env.AUTH_PASSWORD;

  if (!authUsername || !authPassword) {
    return c.json({ success: false, error: "Authentication not configured" }, 500);
  }

  if (username !== authUsername || password !== authPassword) {
    return c.json({ success: false, error: "用户名或密码错误" }, 401);
  }

  const token = await generateSessionToken(username);

  // Set cookie with token
  const cookie = `auth_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${7 * 24 * 60 * 60}`;

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": cookie,
    },
  });
});

// Logout endpoint
app.post("/api/auth/logout", () => {
  const cookie = "auth_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0";

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": cookie,
    },
  });
});

// Check auth status
app.get("/api/auth/status", (c) => {
  const cookieHeader = c.req.header("Cookie") || "";
  const match = cookieHeader.match(/auth_token=([^;]+)/);

  // Token exists and is not empty
  const authenticated = !!(match && match[1] && match[1].length > 0);

  return c.json({ authenticated });
});

// Check if request has valid auth cookie
function hasAuthCookie(request: Request): boolean {
  const cookieHeader = request.headers.get("Cookie") || "";
  const match = cookieHeader.match(/auth_token=([^;]+)/);
  return !!(match && match[1] && match[1].length > 0);
}

export { hasAuthCookie };
export { app as authRoutes };
