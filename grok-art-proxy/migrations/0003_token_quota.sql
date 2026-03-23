-- Token 配额管理：添加配额追踪和冷却恢复字段
ALTER TABLE tokens ADD COLUMN quota INTEGER NOT NULL DEFAULT 80;
ALTER TABLE tokens ADD COLUMN cooling_since INTEGER;
