import { Hono } from "hono";
import type { Env } from "../env";
import {
  listApiKeys,
  createApiKey,
  deleteApiKey,
  toggleApiKey,
  getApiKey,
  apiKeyRowToInfo,
  getApiKeyStats,
} from "../repo/api-keys";

const app = new Hono<{ Bindings: Env }>();

// List all API keys
// GET /api/keys
app.get("/api/keys", async (c) => {
  const stats = await getApiKeyStats(c.env.DB);
  const keys = await listApiKeys(c.env.DB);

  // Map keys with full key values
  const maskedKeys = keys.map((row) => {
    const info = apiKeyRowToInfo(row);
    return {
      id: info.id,
      key: info.key, // Return full key
      key_preview: info.key_preview,
      name: info.name,
      created_at: info.created_at,
      last_used_at: info.last_used_at,
      usage_count: info.usage_count,
      rate_limit: info.rate_limit,
      daily_usage: info.daily_usage,
      daily_reset_at: info.daily_reset_at,
      enabled: info.enabled,
    };
  });

  return c.json({
    keys: maskedKeys,
    total: stats.total,
    enabled: stats.enabled,
  });
});

// Create new API key
// POST /api/keys
app.post("/api/keys", async (c) => {
  const body = await c.req.json<{ name?: string }>().catch(() => ({ name: "" }));
  const name = body.name || "";

  const keyRow = await createApiKey(c.env.DB, name);
  const keyInfo = apiKeyRowToInfo(keyRow);

  return c.json({
    success: true,
    key: {
      id: keyInfo.id,
      key: keyInfo.key, // Return full key only on creation
      name: keyInfo.name,
      created_at: keyInfo.created_at,
      usage_count: keyInfo.usage_count,
      rate_limit: keyInfo.rate_limit,
      enabled: keyInfo.enabled,
    },
  });
});

// Delete API key
// DELETE /api/keys/:id
app.delete("/api/keys/:id", async (c) => {
  const id = c.req.param("id");
  const deleted = await deleteApiKey(c.env.DB, id);

  if (!deleted) {
    return c.json({ success: false, error: "API key not found" }, 404);
  }

  return c.json({ success: true });
});

// Update API key (enable/disable)
// PATCH /api/keys/:id
app.patch("/api/keys/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ enabled?: boolean }>().catch(() => ({ enabled: undefined }));

  // Check if API key exists
  const existing = await getApiKey(c.env.DB, id);
  if (!existing) {
    return c.json({ success: false, error: "API key not found" }, 404);
  }

  // Validate request body
  if (typeof body.enabled !== "boolean") {
    return c.json({ success: false, error: "Invalid request: 'enabled' must be a boolean" }, 400);
  }

  const updated = await toggleApiKey(c.env.DB, id, body.enabled);

  if (!updated) {
    return c.json({ success: false, error: "Failed to update API key" }, 500);
  }

  return c.json({ success: true });
});

export { app as apiKeyRoutes };
