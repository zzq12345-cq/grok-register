import { Hono } from "hono";
import type { Env } from "../env";
import {
  listTokens,
  getToken,
  getRandomToken,
  addToken,
  addTokensBatch,
  addTokensBulk,
  parseTokensText,
  deleteToken,
  clearAllTokens,
  setTokenNsfw,
  getTokenStats,
  tokenRowToInfo,
  tokenRowToExport,
  resetTokenQuota,
  resetAllQuotas,
  syncTokenUsage,
  refreshCoolingTokens,
} from "../repo/tokens";
import { enableNsfw } from "../grok/nsfw";
import { diagnoseImageTokenViaRest, type RestDiagnosticCode } from "../grok/image";
import { diagnoseImageToken, type TokenDiagnosticCode } from "../grok/imagine";

const app = new Hono<{ Bindings: Env }>();
const DIAGNOSE_BATCH_SIZE = 10;

type DiagnosticCode = RestDiagnosticCode | TokenDiagnosticCode;

function emptyDiagnosticSummary(): Record<DiagnosticCode, number> {
  return {
    ok: 0,
    rate_limited: 0,
    auth_invalid: 0,
    rest_failed: 0,
    upstream_blocked: 0,
    ws_upgrade_failed: 0,
    unknown_error: 0,
  };
}

async function runBestEffortDiagnostic(token: {
  sso: string;
  sso_rw: string;
  user_id: string;
  cf_clearance: string;
}) {
  const restResult = await diagnoseImageTokenViaRest(
    token.sso,
    token.sso_rw,
    token.user_id,
    token.cf_clearance
  );

  const shouldFallbackToWs = !restResult.ok && (
    restResult.code === "unknown_error"
    || restResult.code === "rest_failed"
    || restResult.detail.startsWith("HTTP 400")
  );

  if (!shouldFallbackToWs) {
    return restResult;
  }

  return await diagnoseImageToken(
    token.sso,
    token.sso_rw,
    token.user_id,
    token.cf_clearance
  );
}

// List all tokens
app.get("/api/tokens", async (c) => {
  const stats = await getTokenStats(c.env.DB);
  const tokens = await listTokens(c.env.DB);

  return c.json({
    success: true,
    total: stats.total,
    active: stats.active,
    tokens: tokens.map(tokenRowToInfo),
  });
});

// Export all tokens (full data)
app.get("/api/tokens/export", async (c) => {
  const tokens = await listTokens(c.env.DB);

  return c.json({
    success: true,
    total: tokens.length,
    tokens: tokens.map(tokenRowToExport),
  });
});

// Import tokens batch with high-performance bulk insert
app.post("/api/tokens/import", async (c) => {
  const body = await c.req.json<{ text: string }>();
  const parsed = parseTokensText(body.text);

  if (parsed.length === 0) {
    return c.json({
      success: false,
      error: "没有找到有效的令牌",
      imported: 0,
    });
  }

  // Use fast bulk import for all sizes
  const result = await addTokensBulk(c.env.DB, parsed);
  const stats = await getTokenStats(c.env.DB);

  return c.json({
    success: true,
    imported: result.count,
    total: stats.total,
  });
});

// Add single token
app.post("/api/tokens/add", async (c) => {
  const body = await c.req.json<{
    sso: string;
    sso_rw?: string;
    user_id?: string;
    name?: string;
  }>();

  const token = await addToken(
    c.env.DB,
    body.sso,
    body.sso_rw || "",
    body.user_id || "",
    "",
    body.name || ""
  );
  const stats = await getTokenStats(c.env.DB);

  return c.json({
    success: true,
    token: { id: token.id, name: token.name },
    total: stats.total,
  });
});

// Diagnose a single token via REST app-chat API
app.post("/api/tokens/:id/diagnose", async (c) => {
  const id = c.req.param("id");
  const token = await getToken(c.env.DB, id);

  if (!token) {
    return c.json({ success: false, error: "Token not found" }, 404);
  }

  const result = await runBestEffortDiagnostic(token);

  return c.json({
    success: true,
    result: {
      token_id: token.id,
      token_name: token.name,
      token_status: token.status,
      ...result,
    },
  });
});

// Diagnose tokens in batches to avoid Cloudflare subrequest limits
app.post("/api/tokens/diagnose", async (c) => {
  const body = await c.req.json<{
    offset?: number;
    batch_size?: number;
    active_only?: boolean;
    delay_ms?: number;
  }>().catch(() => ({}) as {
    offset?: number;
    batch_size?: number;
    active_only?: boolean;
    delay_ms?: number;
  });

  const offset = Math.max(0, Number(body.offset) || 0);
  const batchSize = Math.min(DIAGNOSE_BATCH_SIZE, Math.max(1, Number(body.batch_size) || DIAGNOSE_BATCH_SIZE));
  const delayMs = Math.min(1000, Math.max(0, Number(body.delay_ms) || 250));
  const activeOnly = body.active_only !== false;

  const tokens = (await listTokens(c.env.DB)).filter((token) => !activeOnly || token.status === "active");
  const batch = tokens.slice(offset, offset + batchSize);
  const results: Array<{
    token_id: string;
    token_name: string;
    token_status: string;
    ok: boolean;
    code: DiagnosticCode;
    message: string;
    detail: string;
    checked_at: string;
    probe: "app_chat_rest" | "imagine_ws";
    images_received: number;
  }> = [];
  const summary = emptyDiagnosticSummary();

  for (let i = 0; i < batch.length; i++) {
    const token = batch[i]!;
    const result = await runBestEffortDiagnostic(token);

    results.push({
      token_id: token.id,
      token_name: token.name,
      token_status: token.status,
      ...result,
    });
    summary[result.code] += 1;

    if (i < batch.length - 1 && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  const processed = Math.min(tokens.length, offset + batch.length);
  const done = processed >= tokens.length;

  return c.json({
    success: true,
    total: tokens.length,
    processed,
    batch_size: batch.length,
    done,
    next_offset: done ? null : processed,
    summary,
    results,
  });
});

// Delete token
app.delete("/api/tokens/:id", async (c) => {
  const id = c.req.param("id");
  const deleted = await deleteToken(c.env.DB, id);

  if (!deleted) {
    return c.json({ success: false, error: "Token not found" }, 404);
  }

  const stats = await getTokenStats(c.env.DB);
  return c.json({ success: true, total: stats.total });
});

// Batch delete tokens
app.post("/api/tokens/batch-delete", async (c) => {
  const body = await c.req.json<{ ids: string[] }>();
  const { ids } = body;

  if (!ids || ids.length === 0) {
    return c.json({ success: false, error: "No token IDs provided" }, 400);
  }

  // Collect names before deleting (for local file cleanup)
  const deletedNames: string[] = [];
  let deletedCount = 0;

  for (const id of ids) {
    const token = await getToken(c.env.DB, id);
    if (token) {
      deletedNames.push(token.name);
      const ok = await deleteToken(c.env.DB, id);
      if (ok) deletedCount++;
    }
  }

  const stats = await getTokenStats(c.env.DB);
  return c.json({
    success: true,
    deleted: deletedCount,
    deleted_names: deletedNames,
    total: stats.total,
  });
});

// Clear all tokens
app.delete("/api/tokens", async (c) => {
  await clearAllTokens(c.env.DB);
  return c.json({ success: true, total: 0 });
});

// Enable NSFW for all tokens (batch mode to avoid subrequest limits)
// Process max 20 tokens per request in PARALLEL to maximize speed
// Each token needs 2 subrequests, so 20 * 2 = 40 < 50 limit
app.post("/api/tokens/enable-nsfw", async (c) => {
  const body = await c.req.json<{ offset?: number }>().catch(() => ({ offset: 0 }));
  const offset = body.offset || 0;
  const BATCH_SIZE = 20; // Parallel execution: 20 * 2 = 40 subrequests < 50 limit

  const tokens = await listTokens(c.env.DB);
  const tokensToProcess = tokens.filter((t) => !t.nsfw_enabled);

  if (tokensToProcess.length === 0) {
    return c.json({
      success: true,
      message: "所有 Token 都已开启 NSFW",
      total: 0,
      processed: 0,
      skipped: tokens.length,
      done: true,
    });
  }

  // Get current batch
  const batch = tokensToProcess.slice(offset, offset + BATCH_SIZE);

  // Process all tokens in parallel for maximum speed
  const batchResults = await Promise.all(
    batch.map(async (token) => {
      const result = await enableNsfw(token.sso, token.sso_rw);
      return { token, result };
    })
  );

  // Update database and collect results
  const results: { name: string; success: boolean; message: string }[] = [];
  let successCount = 0;
  let failCount = 0;

  for (const { token, result } of batchResults) {
    if (result.success) {
      successCount++;
      await setTokenNsfw(c.env.DB, token.id, true);
    } else {
      failCount++;
    }

    results.push({
      name: token.name,
      success: result.success,
      message: result.message,
    });
  }

  const newOffset = offset + batch.length;
  const done = newOffset >= tokensToProcess.length;

  return c.json({
    success: true,
    results,
    success_count: successCount,
    fail_count: failCount,
    processed: newOffset,
    total: tokensToProcess.length,
    skipped: tokens.length - tokensToProcess.length,
    done,
    next_offset: done ? null : newOffset,
  });
});

// Enable NSFW for single token
app.post("/api/tokens/:id/enable-nsfw", async (c) => {
  const id = c.req.param("id");
  const token = await getToken(c.env.DB, id);

  if (!token) {
    return c.json({ success: false, error: "Token not found" }, 404);
  }

  const result = await enableNsfw(token.sso, token.sso_rw);

  if (result.success) {
    await setTokenNsfw(c.env.DB, id, true);
  }

  return c.json({
    success: result.success,
    message: result.message,
    token_name: token.name,
  });
});

// Reset quota for single token
app.post("/api/tokens/:id/reset-quota", async (c) => {
  const id = c.req.param("id");
  const success = await resetTokenQuota(c.env.DB, id);

  if (!success) {
    return c.json({ success: false, error: "Token not found" }, 404);
  }

  return c.json({ success: true, message: "配额已重置" });
});

// Reset all token quotas
app.post("/api/tokens/reset-all-quotas", async (c) => {
  const count = await resetAllQuotas(c.env.DB);
  return c.json({ success: true, reset_count: count, message: `已重置 ${count} 个 Token 的配额` });
});

// Sync single token usage via Rate Limits API
app.post("/api/tokens/:id/sync-usage", async (c) => {
  const id = c.req.param("id");
  const result = await syncTokenUsage(c.env.DB, id);
  return c.json({ success: true, ...result });
});

// Refresh all cooling tokens
app.post("/api/tokens/refresh-cooling", async (c) => {
  const result = await refreshCoolingTokens(c.env.DB);
  return c.json({
    success: true,
    ...result,
    message: `检查 ${result.checked} 个冷却 Token，恢复 ${result.recovered} 个，过期 ${result.expired} 个`,
  });
});

export { app as tokenRoutes };
