import type { Env } from "../env";
import { dbAll, dbFirst, dbRun } from "../db";
import { nowMs } from "../utils/time";

export interface LogRow {
  id: string;
  timestamp: number;
  ip: string;
  action: string;
  token_id: string;
  duration: number;
  status: number;
  error: string;
}

export interface LogInfo {
  id: string;
  timestamp: string;
  ip: string;
  action: string;
  token_id: string;
  token_name: string;
  duration: number;
  status: number;
  error: string;
}

export interface LogFilters {
  page?: number | undefined;
  limit?: number | undefined;
  token_id?: string | undefined;
  action?: string | undefined;
  status?: string | undefined; // "success" | "error" | "all"
  start_time?: number | undefined;
  end_time?: number | undefined;
}

/**
 * 写入一条使用日志
 */
export async function addLog(
  db: Env["DB"],
  params: {
    ip: string;
    action: string;
    token_id: string;
    duration: number;
    status: number;
    error?: string;
  }
): Promise<void> {
  const id = crypto.randomUUID();
  const timestamp = nowMs();

  await dbRun(
    db,
    `INSERT INTO request_logs (id, timestamp, ip, action, token_id, duration, status, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      timestamp,
      params.ip,
      params.action,
      params.token_id,
      params.duration,
      params.status,
      params.error || "",
    ]
  );
}

/**
 * 分页查询日志（支持筛选）
 */
export async function listLogs(
  db: Env["DB"],
  filters: LogFilters = {}
): Promise<{ logs: LogInfo[]; total: number; page: number; limit: number }> {
  const page = Math.max(filters.page || 1, 1);
  const limit = Math.min(Math.max(filters.limit || 50, 1), 200);
  const offset = (page - 1) * limit;

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.token_id) {
    conditions.push("r.token_id = ?");
    params.push(filters.token_id);
  }
  if (filters.action) {
    conditions.push("r.action = ?");
    params.push(filters.action);
  }
  if (filters.status === "success") {
    conditions.push("r.status >= 200 AND r.status < 400");
  } else if (filters.status === "error") {
    conditions.push("(r.status >= 400 OR r.status = 0)");
  }
  if (filters.start_time) {
    conditions.push("r.timestamp >= ?");
    params.push(filters.start_time);
  }
  if (filters.end_time) {
    conditions.push("r.timestamp <= ?");
    params.push(filters.end_time);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // 总数
  const countResult = await dbFirst<{ c: number }>(
    db,
    `SELECT COUNT(*) as c FROM request_logs r ${whereClause}`,
    params
  );
  const total = countResult?.c ?? 0;

  // 查询日志（JOIN tokens 获取 token_name）
  const queryParams = [...params, limit, offset];
  const rows = await dbAll<LogRow & { token_name: string | null }>(
    db,
    `SELECT r.id, r.timestamp, r.ip, r.action, r.token_id, r.duration, r.status, r.error,
            t.name as token_name
     FROM request_logs r
     LEFT JOIN tokens t ON r.token_id = t.id
     ${whereClause}
     ORDER BY r.timestamp DESC
     LIMIT ? OFFSET ?`,
    queryParams
  );

  const logs: LogInfo[] = rows.map((row) => ({
    id: row.id,
    timestamp: new Date(row.timestamp).toISOString(),
    ip: row.ip,
    action: row.action,
    token_id: row.token_id,
    token_name: row.token_name || row.token_id.slice(0, 8) + "...",
    duration: row.duration,
    status: row.status,
    error: row.error,
  }));

  return { logs, total, page, limit };
}

/**
 * 统计概览
 */
export async function getLogStats(
  db: Env["DB"]
): Promise<{
  total: number;
  success: number;
  error: number;
  today: number;
  actions: { action: string; count: number }[];
}> {
  const total = await dbFirst<{ c: number }>(
    db,
    "SELECT COUNT(*) as c FROM request_logs"
  );
  const success = await dbFirst<{ c: number }>(
    db,
    "SELECT COUNT(*) as c FROM request_logs WHERE status >= 200 AND status < 400"
  );
  const error = await dbFirst<{ c: number }>(
    db,
    "SELECT COUNT(*) as c FROM request_logs WHERE status >= 400 OR status = 0"
  );

  // 今日 (过去 24 小时)
  const oneDayAgo = nowMs() - 24 * 60 * 60 * 1000;
  const today = await dbFirst<{ c: number }>(
    db,
    "SELECT COUNT(*) as c FROM request_logs WHERE timestamp >= ?",
    [oneDayAgo]
  );

  // 各操作类型计数
  const actions = await dbAll<{ action: string; c: number }>(
    db,
    "SELECT action, COUNT(*) as c FROM request_logs GROUP BY action ORDER BY c DESC LIMIT 10"
  );

  return {
    total: total?.c ?? 0,
    success: success?.c ?? 0,
    error: error?.c ?? 0,
    today: today?.c ?? 0,
    actions: actions.map((a) => ({ action: a.action, count: a.c })),
  };
}

/**
 * 清空日志
 */
export async function clearLogs(db: Env["DB"]): Promise<void> {
  await dbRun(db, "DELETE FROM request_logs");
}
