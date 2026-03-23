import type { Env } from "../env";
import { dbAll, dbFirst, dbRun, dbBatch } from "../db";
import { nowMs } from "../utils/time";
import { md5 } from "../utils/crypto";
import { fetchRateLimits } from "../grok/rate-limits";

// 配额常量
const DEFAULT_QUOTA = 80;
const COOLING_WINDOW_MS = 20 * 60 * 60 * 1000; // 20 小时
const FAIL_THRESHOLD = 5;
const REFRESH_INTERVAL_MS = 8 * 60 * 60 * 1000; // 8 小时

export interface TokenRow {
  id: string;
  sso: string;
  sso_rw: string;
  user_id: string;
  cf_clearance: string;
  name: string;
  added_at: number;
  last_used: number | null;
  use_count: number;
  status: string;
  nsfw_enabled: number;
  quota: number;
  cooling_since: number | null;
  consumed: number;
  last_sync_at: number | null;
  fail_count: number;
  last_fail_reason: string;
}

export interface TokenInfo {
  id: string;
  name: string;
  sso_preview: string;
  has_sso_rw: boolean;
  has_user_id: boolean;
  has_cf_clearance: boolean;
  status: string;
  nsfw_enabled: boolean;
  use_count: number;
  last_used: string | null;
  added_at: string;
  quota: number;
  cooling_since: string | null;
  consumed: number;
  last_sync_at: string | null;
  fail_count: number;
  last_fail_reason: string;
}

export interface TokenExport {
  sso: string;
  sso_rw: string;
  cf_clearance: string;
  name: string;
  "x-userid": string;
}

function generateTokenId(sso: string): string {
  return md5(sso);
}

function cleanSso(sso: string): string {
  return sso.startsWith("sso=") ? sso.slice(4) : sso.trim();
}

const ALL_COLUMNS = "id, sso, sso_rw, user_id, cf_clearance, name, added_at, last_used, use_count, status, nsfw_enabled, quota, cooling_since, consumed, last_sync_at, fail_count, last_fail_reason";

export function tokenRowToInfo(row: TokenRow): TokenInfo {
  return {
    id: row.id,
    name: row.name || `${row.sso.slice(0, 8)}...`,
    sso_preview: row.sso.length > 20 ? `${row.sso.slice(0, 20)}...` : row.sso,
    has_sso_rw: Boolean(row.sso_rw),
    has_user_id: Boolean(row.user_id),
    has_cf_clearance: Boolean(row.cf_clearance),
    status: row.status,
    nsfw_enabled: Boolean(row.nsfw_enabled),
    use_count: row.use_count,
    last_used: row.last_used ? new Date(row.last_used).toISOString() : null,
    added_at: new Date(row.added_at).toISOString(),
    quota: row.quota ?? DEFAULT_QUOTA,
    cooling_since: row.cooling_since ? new Date(row.cooling_since).toISOString() : null,
    consumed: row.consumed ?? 0,
    last_sync_at: row.last_sync_at ? new Date(row.last_sync_at).toISOString() : null,
    fail_count: row.fail_count ?? 0,
    last_fail_reason: row.last_fail_reason ?? "",
  };
}

export function tokenRowToExport(row: TokenRow): TokenExport {
  return {
    sso: row.sso,
    sso_rw: row.sso_rw,
    cf_clearance: row.cf_clearance,
    name: row.name,
    "x-userid": row.user_id,
  };
}

export async function listTokens(db: Env["DB"]): Promise<TokenRow[]> {
  return dbAll<TokenRow>(
    db,
    `SELECT ${ALL_COLUMNS} FROM tokens ORDER BY added_at DESC`
  );
}

export async function getToken(db: Env["DB"], tokenId: string): Promise<TokenRow | null> {
  return dbFirst<TokenRow>(
    db,
    `SELECT ${ALL_COLUMNS} FROM tokens WHERE id = ?`,
    [tokenId]
  );
}

export async function countActiveTokens(db: Env["DB"]): Promise<number> {
  const row = await dbFirst<{ c: number }>(
    db,
    "SELECT COUNT(*) as c FROM tokens WHERE status = 'active'"
  );

  return row?.c ?? 0;
}

export async function getRandomToken(db: Env["DB"], excludeIds: string[] = []): Promise<TokenRow | null> {
  const placeholders = excludeIds.length > 0
    ? `AND id NOT IN (${excludeIds.map(() => "?").join(",")})`
    : "";

  // 获取所有 active 和 cooling 状态的 token
  const rows = await dbAll<TokenRow>(
    db,
    `SELECT ${ALL_COLUMNS} FROM tokens WHERE status IN ('active', 'cooling') ${placeholders}`,
    excludeIds
  );

  if (rows.length === 0) return null;

  const now = nowMs();
  let available: TokenRow[] = [];

  for (const row of rows) {
    if (row.status === "cooling") {
      // 检查冷却窗口是否已过期
      if (row.cooling_since && (now - row.cooling_since) >= COOLING_WINDOW_MS) {
        // 冷却期已过，自动恢复
        await dbRun(
          db,
          "UPDATE tokens SET status = 'active', quota = ?, cooling_since = NULL, consumed = 0, fail_count = 0 WHERE id = ?",
          [DEFAULT_QUOTA, row.id]
        );
        row.status = "active";
        row.quota = DEFAULT_QUOTA;
        row.cooling_since = null;
        row.consumed = 0;
        row.fail_count = 0;
        available.push(row);
      }
      // 冷却中的 token 跳过
    } else if (row.quota > 0) {
      available.push(row);
    }
  }

  // 没有可用 token → 尝试刷新冷却中的 token
  if (available.length === 0) {
    const refreshResult = await refreshCoolingTokens(db);
    if (refreshResult.recovered > 0) {
      // 重新查询
      const retryRows = await dbAll<TokenRow>(
        db,
        `SELECT ${ALL_COLUMNS} FROM tokens WHERE status = 'active' AND quota > 0 ${placeholders}`,
        excludeIds
      );
      available = retryRows;
    }
  }

  if (available.length === 0) return null;

  // Consumed Mode：优先选消耗最少的 token（均匀分配）
  const minConsumed = Math.min(...available.map(t => t.consumed));
  const candidates = available.filter(t => t.consumed === minConsumed);
  // 同等消耗下优先选配额最多的
  const maxQuota = Math.max(...candidates.map(t => t.quota));
  const topCandidates = candidates.filter(t => t.quota === maxQuota);
  const token = topCandidates[Math.floor(Math.random() * topCandidates.length)];
  if (!token) return null;

  // 更新使用统计
  await dbRun(db, "UPDATE tokens SET last_used = ?, use_count = use_count + 1 WHERE id = ?", [now, token.id]);

  return token;
}

export async function addToken(
  db: Env["DB"],
  sso: string,
  sso_rw: string = "",
  user_id: string = "",
  cf_clearance: string = "",
  name: string = ""
): Promise<TokenRow> {
  const cleanedSso = cleanSso(sso);
  const id = generateTokenId(cleanedSso);
  const now = nowMs();

  // Check if exists
  const existing = await getToken(db, id);
  if (existing) {
    // Update existing token
    const updates: string[] = [];
    const params: unknown[] = [];

    if (sso_rw) { updates.push("sso_rw = ?"); params.push(sso_rw); }
    if (user_id) { updates.push("user_id = ?"); params.push(user_id); }
    if (cf_clearance) { updates.push("cf_clearance = ?"); params.push(cf_clearance); }
    if (name) { updates.push("name = ?"); params.push(name); }

    if (updates.length > 0) {
      params.push(id);
      await dbRun(db, `UPDATE tokens SET ${updates.join(", ")} WHERE id = ?`, params);
    }

    return (await getToken(db, id))!;
  }

  // Insert new token
  await dbRun(
    db,
    `INSERT INTO tokens (id, sso, sso_rw, user_id, cf_clearance, name, added_at, use_count, status, nsfw_enabled, quota)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'active', 0, ?)`,
    [id, cleanedSso, sso_rw, user_id, cf_clearance, name || `${cleanedSso.slice(0, 8)}...`, now, DEFAULT_QUOTA]
  );

  return (await getToken(db, id))!;
}

export interface ParsedTokenInput {
  sso: string;
  sso_rw: string;
  user_id: string;
  cf_clearance: string;
  name: string;
}

function parseTokenJsonValue(value: unknown): ParsedTokenInput[] | null {
  if (Array.isArray(value)) {
    const result: ParsedTokenInput[] = [];
    for (const item of value) {
      const parsed = parseTokenJsonValue(item);
      if (parsed?.length) result.push(...parsed);
    }
    return result;
  }

  if (typeof value === "string") {
    const sso = value.startsWith("sso=") ? value.slice(4) : value.trim();
    return sso ? [{ sso, sso_rw: "", user_id: "", cf_clearance: "", name: "" }] : [];
  }

  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sso = String(obj.sso || "");
    if (!sso) return [];

    return [{
      sso,
      sso_rw: String(obj.sso_rw || obj["sso-rw"] || ""),
      user_id: String(obj.user_id || obj["x-userid"] || ""),
      cf_clearance: String(obj.cf_clearance || ""),
      name: String(obj.name || obj.email || ""),
    }];
  }

  return null;
}

export function parseTokensText(text: string): ParsedTokenInput[] {
  const result: ParsedTokenInput[] = [];
  const trimmed = text.trim();

  // Try JSON format
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = parseTokenJsonValue(JSON.parse(trimmed));
      if (parsed) return parsed;
    } catch {
      // Not valid JSON, continue with line parsing
    }
  }

  // Parse by lines
  for (const line of trimmed.split("\n")) {
    const cleaned = line.trim();
    if (!cleaned || cleaned.startsWith("#")) continue;

    let sso = "", sso_rw = "", user_id = "", cf_clearance = "", name = "";

    if (cleaned.includes(",")) {
      const parts = cleaned.split(",").map(p => p.trim());
      sso = parts[0] ?? "";
      sso_rw = parts[1] ?? "";
      user_id = parts[2] ?? "";
      cf_clearance = parts[3] ?? "";
      name = parts[4] ?? "";
    } else {
      sso = cleaned;
    }

    if (sso.startsWith("sso=")) sso = sso.slice(4);
    if (sso) result.push({ sso, sso_rw, user_id, cf_clearance, name });
  }

  return result;
}

// Batch import tokens with high performance (uses INSERT OR REPLACE)
export async function addTokensBulk(
  db: Env["DB"],
  items: ParsedTokenInput[]
): Promise<{ count: number }> {
  if (items.length === 0) return { count: 0 };

  const now = nowMs();
  const BATCH_SIZE = 50; // D1 batch limit
  let totalInserted = 0;

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const statements: { sql: string; params: unknown[] }[] = [];

    for (const item of batch) {
      const cleanedSso = cleanSso(item.sso);
      if (!cleanedSso) continue;

      const id = generateTokenId(cleanedSso);
      const name = item.name || `${cleanedSso.slice(0, 8)}...`;

      statements.push({
        sql: `INSERT INTO tokens (id, sso, sso_rw, user_id, cf_clearance, name, added_at, use_count, status, nsfw_enabled, quota)
              VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'active', 0, ${DEFAULT_QUOTA})
              ON CONFLICT(id) DO UPDATE SET
                sso_rw = CASE WHEN excluded.sso_rw != '' THEN excluded.sso_rw ELSE tokens.sso_rw END,
                user_id = CASE WHEN excluded.user_id != '' THEN excluded.user_id ELSE tokens.user_id END,
                cf_clearance = CASE WHEN excluded.cf_clearance != '' THEN excluded.cf_clearance ELSE tokens.cf_clearance END,
                name = CASE WHEN excluded.name != '' THEN excluded.name ELSE tokens.name END`,
        params: [id, cleanedSso, item.sso_rw, item.user_id, item.cf_clearance, name, now],
      });
    }

    if (statements.length > 0) {
      await dbBatch(db, statements);
      totalInserted += statements.length;
    }
  }

  return { count: totalInserted };
}

export async function addTokensBatch(
  db: Env["DB"],
  text: string
): Promise<{ count: number; tokens: TokenRow[] }> {
  const added: TokenRow[] = [];
  const trimmed = text.trim();

  // Try JSON format
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const items = parseTokenJsonValue(JSON.parse(trimmed));
      for (const item of items || []) {
        const token = await addToken(
          db,
          item.sso,
          item.sso_rw,
          item.user_id,
          item.cf_clearance,
          item.name
        );
        added.push(token);
      }
      return { count: added.length, tokens: added };
    } catch {
      // Not valid JSON, continue with line parsing
    }
  }

  // Parse by lines
  for (const line of trimmed.split("\n")) {
    const cleaned = line.trim();
    if (!cleaned || cleaned.startsWith("#")) continue;

    let sso = "", sso_rw = "", user_id = "", cf_clearance = "", name = "";

    if (cleaned.includes(",")) {
      // CSV format: sso,sso_rw,user_id,cf_clearance,name
      const parts = cleaned.split(",").map(p => p.trim());
      sso = parts[0] ?? "";
      sso_rw = parts[1] ?? "";
      user_id = parts[2] ?? "";
      cf_clearance = parts[3] ?? "";
      name = parts[4] ?? "";
    } else {
      sso = cleaned;
    }

    if (sso.startsWith("sso=")) sso = sso.slice(4);
    if (sso) {
      const token = await addToken(db, sso, sso_rw, user_id, cf_clearance, name);
      added.push(token);
    }
  }

  return { count: added.length, tokens: added };
}

export async function deleteToken(db: Env["DB"], tokenId: string): Promise<boolean> {
  const existing = await getToken(db, tokenId);
  if (!existing) return false;
  await dbRun(db, "DELETE FROM tokens WHERE id = ?", [tokenId]);
  return true;
}

export async function clearAllTokens(db: Env["DB"]): Promise<void> {
  await dbRun(db, "DELETE FROM tokens");
}

export async function setTokenNsfw(db: Env["DB"], tokenId: string, enabled: boolean): Promise<void> {
  await dbRun(db, "UPDATE tokens SET nsfw_enabled = ? WHERE id = ?", [enabled ? 1 : 0, tokenId]);
}

export async function getTokenStats(db: Env["DB"]): Promise<{ total: number; active: number; cooling: number }> {
  const total = await dbFirst<{ c: number }>(db, "SELECT COUNT(*) as c FROM tokens");
  const active = await dbFirst<{ c: number }>(db, "SELECT COUNT(*) as c FROM tokens WHERE status = 'active'");
  const cooling = await dbFirst<{ c: number }>(db, "SELECT COUNT(*) as c FROM tokens WHERE status = 'cooling'");
  return {
    total: total?.c ?? 0,
    active: active?.c ?? 0,
    cooling: cooling?.c ?? 0,
  };
}

// ===== 配额管理函数 =====

/**
 * 消耗 token 配额（本地预扣）
 * @param cost 消耗量（图片=1，视频=4，聊天=1）
 */
export async function consumeQuota(db: Env["DB"], tokenId: string, cost: number = 1): Promise<boolean> {
  const token = await getToken(db, tokenId);
  if (!token) return false;

  const newQuota = Math.max(0, token.quota - cost);
  const newConsumed = (token.consumed || 0) + cost;
  if (newQuota <= 0) {
    const now = nowMs();
    await dbRun(
      db,
      "UPDATE tokens SET quota = 0, consumed = ?, status = 'cooling', cooling_since = ? WHERE id = ?",
      [newConsumed, now, tokenId]
    );
  } else {
    await dbRun(db, "UPDATE tokens SET quota = ?, consumed = ? WHERE id = ?", [newQuota, newConsumed, tokenId]);
  }
  return true;
}

/**
 * 429 时标记 token 为冷却状态
 */
export async function markTokenCooling(db: Env["DB"], tokenId: string): Promise<void> {
  const now = nowMs();
  await dbRun(
    db,
    "UPDATE tokens SET status = 'cooling', quota = 0, cooling_since = ?, consumed = 0 WHERE id = ?",
    [now, tokenId]
  );
}

/**
 * 同步 token 用量（API 优先，失败 fallback 到本地预扣）
 * 对齐 grok2api 的 sync_usage
 */
export async function syncTokenUsage(
  db: Env["DB"],
  tokenId: string,
  fallbackCost: number = 1
): Promise<{ synced: boolean; remaining: number | null; error?: string }> {
  const token = await getToken(db, tokenId);
  if (!token) return { synced: false, remaining: null, error: "token_not_found" };

  const result = await fetchRateLimits(token.sso, token.sso_rw, token.user_id, token.cf_clearance);
  const now = nowMs();

  if (result.success && result.remainingTokens !== null) {
    // API 同步成功
    const newQuota = Math.max(0, result.remainingTokens);
    if (newQuota <= 0) {
      await dbRun(
        db,
        "UPDATE tokens SET quota = 0, status = 'cooling', cooling_since = ?, last_sync_at = ?, fail_count = 0 WHERE id = ?",
        [now, now, tokenId]
      );
    } else {
      await dbRun(
        db,
        "UPDATE tokens SET quota = ?, status = 'active', cooling_since = NULL, last_sync_at = ?, fail_count = 0 WHERE id = ?",
        [newQuota, now, tokenId]
      );
    }
    return { synced: true, remaining: newQuota };
  }

  // API 失败：处理特殊情况
  if (result.isExpired) {
    await recordTokenFail(db, tokenId, 401, "token_expired");
    return { synced: false, remaining: null, error: result.error || "token_expired" };
  }

  if (result.remainingTokens === 0) {
    // 429 confirmed
    await markTokenCooling(db, tokenId);
    return { synced: false, remaining: 0, error: "rate_limited_429" };
  }

  // 降级：本地预扣
  await consumeQuota(db, tokenId, fallbackCost);
  return { synced: false, remaining: null, error: result.error || "api_sync_failed_fallback_consumed" };
}

/**
 * 记录 token 失败（401 时累加 fail_count，达阈值标记 expired）
 */
export async function recordTokenFail(
  db: Env["DB"],
  tokenId: string,
  statusCode: number = 401,
  reason: string = ""
): Promise<void> {
  if (statusCode !== 401) return;

  const token = await getToken(db, tokenId);
  if (!token) return;

  const newFailCount = (token.fail_count || 0) + 1;
  const now = nowMs();

  if (newFailCount >= FAIL_THRESHOLD) {
    await dbRun(
      db,
      "UPDATE tokens SET status = 'expired', fail_count = ?, last_fail_reason = ? WHERE id = ?",
      [newFailCount, reason, tokenId]
    );
  } else {
    await dbRun(
      db,
      "UPDATE tokens SET fail_count = ?, last_fail_reason = ? WHERE id = ?",
      [newFailCount, reason, tokenId]
    );
  }
}

/**
 * 批量刷新冷却中的 token（调 API 查配额，有配额则恢复）
 * 对齐 grok2api 的 refresh_cooling_tokens
 */
export async function refreshCoolingTokens(
  db: Env["DB"]
): Promise<{ checked: number; recovered: number; expired: number }> {
  const now = nowMs();

  // 获取所有冷却中的 token
  const coolingTokens = await dbAll<TokenRow>(
    db,
    `SELECT ${ALL_COLUMNS} FROM tokens WHERE status = 'cooling'`
  );

  // 过滤需要刷新的（距上次同步超过刷新间隔，或从未同步过）
  const toRefresh = coolingTokens.filter(t => {
    if (!t.last_sync_at) return true;
    return (now - t.last_sync_at) >= REFRESH_INTERVAL_MS;
  });

  if (toRefresh.length === 0) {
    return { checked: 0, recovered: 0, expired: 0 };
  }

  let recovered = 0;
  let expired = 0;

  // 逐个刷新（Workers 环境不能太并发）
  for (const token of toRefresh) {
    const result = await fetchRateLimits(token.sso, token.sso_rw, token.user_id, token.cf_clearance);

    if (result.success && result.remainingTokens !== null) {
      const newQuota = Math.max(0, result.remainingTokens);
      if (newQuota > 0) {
        // 配额恢复，重新激活
        await dbRun(
          db,
          "UPDATE tokens SET quota = ?, status = 'active', cooling_since = NULL, consumed = 0, fail_count = 0, last_sync_at = ? WHERE id = ?",
          [newQuota, now, token.id]
        );
        recovered++;
      } else {
        // 还是没配额，更新同步时间
        await dbRun(
          db,
          "UPDATE tokens SET last_sync_at = ? WHERE id = ?",
          [now, token.id]
        );
      }
    } else if (result.isExpired) {
      // Token 过期
      await dbRun(
        db,
        "UPDATE tokens SET status = 'expired', last_fail_reason = 'token_expired', last_sync_at = ? WHERE id = ?",
        [now, token.id]
      );
      expired++;
    } else {
      // API 失败，更新同步时间防止频繁重试
      await dbRun(
        db,
        "UPDATE tokens SET last_sync_at = ? WHERE id = ?",
        [now, token.id]
      );
    }
  }

  return { checked: toRefresh.length, recovered, expired };
}

/**
 * 重置单个 token 配额
 */
export async function resetTokenQuota(db: Env["DB"], tokenId: string): Promise<boolean> {
  const token = await getToken(db, tokenId);
  if (!token) return false;
  await dbRun(
    db,
    "UPDATE tokens SET quota = ?, status = 'active', cooling_since = NULL, consumed = 0, fail_count = 0, last_fail_reason = '' WHERE id = ?",
    [DEFAULT_QUOTA, tokenId]
  );
  return true;
}

/**
 * 重置所有 token 配额
 */
export async function resetAllQuotas(db: Env["DB"]): Promise<number> {
  await dbRun(
    db,
    "UPDATE tokens SET quota = ?, status = 'active', cooling_since = NULL, consumed = 0, fail_count = 0, last_fail_reason = '' WHERE status IN ('active', 'cooling')",
    [DEFAULT_QUOTA]
  );
  const stats = await getTokenStats(db);
  return stats.total;
}
