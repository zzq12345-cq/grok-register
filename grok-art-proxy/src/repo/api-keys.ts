import type { Env } from "../env";
import { dbFirst, dbRun, dbAll } from "../db";
import { nowMs } from "../utils/time";

/**
 * API Key information returned from validation
 */
export interface ApiKeyInfo {
  id: string;
  key: string;
  name: string;
  enabled: boolean;
  rate_limit: number;
  daily_usage: number;
  created_at: number;
  last_used_at: number | null;
}

/**
 * API Key information for display (with masked key)
 */
export interface ApiKeyDisplayInfo {
  id: string;
  key: string;
  key_preview: string;
  name: string;
  enabled: boolean;
  rate_limit: number;
  daily_usage: number;
  daily_reset_at: string | null;
  usage_count: number;
  created_at: string;
  last_used_at: string | null;
}

/**
 * Raw API Key row from database
 */
export interface ApiKeyRow {
  id: string;
  key: string;
  name: string;
  enabled: number;
  rate_limit: number;
  daily_usage: number;
  usage_count: number;
  created_at: number;
  last_used_at: number | null;
  daily_reset_at: number | null;
}

/**
 * Convert database row to ApiKeyInfo (for validation)
 */
function rowToApiKeyInfo(row: ApiKeyRow): ApiKeyInfo {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    enabled: Boolean(row.enabled),
    rate_limit: row.rate_limit,
    daily_usage: row.daily_usage,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
  };
}

/**
 * Convert database row to ApiKeyDisplayInfo (for display)
 */
export function apiKeyRowToInfo(row: ApiKeyRow): ApiKeyDisplayInfo {
  return {
    id: row.id,
    key: row.key,
    key_preview: row.key.length > 12 ? `${row.key.slice(0, 8)}...${row.key.slice(-4)}` : row.key,
    name: row.name,
    enabled: Boolean(row.enabled),
    rate_limit: row.rate_limit,
    daily_usage: row.daily_usage,
    daily_reset_at: row.daily_reset_at ? new Date(row.daily_reset_at).toISOString() : null,
    usage_count: row.usage_count,
    created_at: new Date(row.created_at).toISOString(),
    last_used_at: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
  };
}

/**
 * Validate an API key and return its information if valid
 *
 * @param db - D1 database instance
 * @param apiKey - The API key to validate
 * @returns ApiKeyInfo if valid, null if not found
 */
export async function validateApiKey(
  db: Env["DB"],
  apiKey: string
): Promise<ApiKeyInfo | null> {
  const row = await dbFirst<ApiKeyRow>(
    db,
    "SELECT id, key, name, enabled, rate_limit, daily_usage, created_at, last_used_at FROM api_keys WHERE key = ?",
    [apiKey]
  );

  if (!row) {
    return null;
  }

  // Update last_used_at timestamp
  const now = nowMs();
  await dbRun(db, "UPDATE api_keys SET last_used_at = ? WHERE id = ?", [now, row.id]);

  return rowToApiKeyInfo(row);
}

/**
 * Increment daily usage counter for an API key
 *
 * @param db - D1 database instance
 * @param apiKeyId - The API key ID
 */
export async function incrementApiKeyUsage(
  db: Env["DB"],
  apiKeyId: string
): Promise<void> {
  await dbRun(
    db,
    "UPDATE api_keys SET daily_usage = daily_usage + 1, usage_count = usage_count + 1 WHERE id = ?",
    [apiKeyId]
  );
}

/**
 * Reset daily usage counters for all API keys
 * Should be called by a scheduled task at midnight
 *
 * @param db - D1 database instance
 */
export async function resetDailyUsage(db: Env["DB"]): Promise<void> {
  await dbRun(db, "UPDATE api_keys SET daily_usage = 0");
}

/**
 * Generate a random API key
 */
function generateApiKey(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const prefix = "sk-";
  let key = prefix;
  for (let i = 0; i < 48; i++) {
    key += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return key;
}

/**
 * Generate a unique ID for API key
 */
function generateId(): string {
  return `key_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * List all API keys
 *
 * @param db - D1 database instance
 * @returns Array of API key rows
 */
export async function listApiKeys(db: Env["DB"]): Promise<ApiKeyRow[]> {
  return dbAll<ApiKeyRow>(
    db,
    "SELECT id, key, name, enabled, rate_limit, daily_usage, usage_count, created_at, last_used_at, daily_reset_at FROM api_keys ORDER BY created_at DESC"
  );
}

/**
 * Get a single API key by ID
 *
 * @param db - D1 database instance
 * @param id - The API key ID
 * @returns ApiKeyRow if found, null otherwise
 */
export async function getApiKey(db: Env["DB"], id: string): Promise<ApiKeyRow | null> {
  return dbFirst<ApiKeyRow>(
    db,
    "SELECT id, key, name, enabled, rate_limit, daily_usage, usage_count, created_at, last_used_at, daily_reset_at FROM api_keys WHERE id = ?",
    [id]
  );
}

/**
 * Create a new API key
 *
 * @param db - D1 database instance
 * @param name - Optional name for the API key
 * @returns The created API key row
 */
export async function createApiKey(
  db: Env["DB"],
  name: string = ""
): Promise<ApiKeyRow> {
  const id = generateId();
  const key = generateApiKey();
  const now = nowMs();
  const keyName = name || `API Key ${new Date(now).toLocaleDateString()}`;

  await dbRun(
    db,
    `INSERT INTO api_keys (id, key, name, enabled, rate_limit, daily_usage, usage_count, created_at, last_used_at, daily_reset_at)
     VALUES (?, ?, ?, 1, 0, 0, 0, ?, NULL, NULL)`,
    [id, key, keyName, now]
  );

  return (await getApiKey(db, id))!;
}

/**
 * Delete an API key
 *
 * @param db - D1 database instance
 * @param id - The API key ID to delete
 * @returns true if deleted, false if not found
 */
export async function deleteApiKey(db: Env["DB"], id: string): Promise<boolean> {
  const existing = await getApiKey(db, id);
  if (!existing) return false;
  await dbRun(db, "DELETE FROM api_keys WHERE id = ?", [id]);
  return true;
}

/**
 * Toggle API key enabled status
 *
 * @param db - D1 database instance
 * @param id - The API key ID
 * @param enabled - The new enabled status
 * @returns true if updated, false if not found
 */
export async function toggleApiKey(
  db: Env["DB"],
  id: string,
  enabled: boolean
): Promise<boolean> {
  const existing = await getApiKey(db, id);
  if (!existing) return false;
  await dbRun(db, "UPDATE api_keys SET enabled = ? WHERE id = ?", [enabled ? 1 : 0, id]);
  return true;
}

/**
 * Get API key statistics
 *
 * @param db - D1 database instance
 * @returns Statistics object with total and enabled counts
 */
export async function getApiKeyStats(
  db: Env["DB"]
): Promise<{ total: number; enabled: number }> {
  const total = await dbFirst<{ c: number }>(db, "SELECT COUNT(*) as c FROM api_keys");
  const enabled = await dbFirst<{ c: number }>(
    db,
    "SELECT COUNT(*) as c FROM api_keys WHERE enabled = 1"
  );
  return {
    total: total?.c ?? 0,
    enabled: enabled?.c ?? 0,
  };
}
