-- Token 配额管理增强：consumed mode + API 同步
ALTER TABLE tokens ADD COLUMN consumed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tokens ADD COLUMN last_sync_at INTEGER;
ALTER TABLE tokens ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tokens ADD COLUMN last_fail_reason TEXT NOT NULL DEFAULT '';
