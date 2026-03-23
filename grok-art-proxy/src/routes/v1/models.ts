import { Hono } from "hono";
import type { ApiAuthEnv } from "../../middleware/api-auth";
import { MODELS } from "../../grok/models";

const app = new Hono<ApiAuthEnv>();

// GET /v1/models - List available models
app.get("/", (c) => {
  return c.json({
    object: "list",
    data: MODELS.map((m) => ({
      id: m.id,
      object: "model",
      created: 1700000000,
      owned_by: "xai",
      permission: [],
      root: m.id,
      parent: null,
    })),
  });
});

export { app as modelsRoutes };
