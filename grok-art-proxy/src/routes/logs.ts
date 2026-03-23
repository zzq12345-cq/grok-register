import { Hono } from "hono";
import type { Env } from "../env";
import { listLogs, getLogStats, clearLogs } from "../repo/logs";

const app = new Hono<{ Bindings: Env }>();

// 查询日志列表（分页 + 筛选）
app.get("/api/logs", async (c) => {
  const url = new URL(c.req.url);
  const page = parseInt(url.searchParams.get("page") || "1", 10);
  const limit = parseInt(url.searchParams.get("limit") || "50", 10);
  const token_id = url.searchParams.get("token_id") || undefined;
  const action = url.searchParams.get("action") || undefined;
  const status = url.searchParams.get("status") || undefined;

  const result = await listLogs(c.env.DB, {
    page,
    limit,
    token_id,
    action,
    status,
  });

  return c.json({ success: true, ...result });
});

// 统计概览
app.get("/api/logs/stats", async (c) => {
  const stats = await getLogStats(c.env.DB);
  return c.json({ ok: true, ...stats });
});

// 清空日志
app.delete("/api/logs", async (c) => {
  await clearLogs(c.env.DB);
  return c.json({ success: true, message: "日志已清空" });
});

export { app as logRoutes };
