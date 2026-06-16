-- ============================================================
-- 湘阁里辣 · 等位拿号叫号系统 - Supabase 建表脚本
-- 在 Supabase SQL Editor 中执行
-- 复用现有 Supabase 项目，不创建新项目
-- ============================================================

-- 1. 排队主表
CREATE TABLE IF NOT EXISTS queue (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL,
  queue_number TEXT NOT NULL,       -- A001 / B015
  type CHAR(1) NOT NULL CHECK (type IN ('A', 'B', 'C')),
  daily_seq INTEGER NOT NULL,       -- 当日序号，用于自动递增和排序
  name TEXT NOT NULL,
  phone TEXT DEFAULT '',
  people INTEGER NOT NULL DEFAULT 2,
  note TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting', 'called', 'seated', 'skipped', 'cancelled')),
  called_at TIMESTAMPTZ,
  called_count INTEGER DEFAULT 0,
  seated_at TIMESTAMPTZ,
  created_by TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ
);

-- 2. 排队历史归档表（超过7天的数据移到这里，便于长期存档）
CREATE TABLE IF NOT EXISTS queue_history (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL,
  queue_number TEXT NOT NULL,
  type CHAR(1) NOT NULL,
  daily_seq INTEGER NOT NULL,
  name TEXT NOT NULL,
  phone TEXT DEFAULT '',
  people INTEGER NOT NULL DEFAULT 2,
  note TEXT DEFAULT '',
  status TEXT NOT NULL,
  called_at TIMESTAMPTZ,
  called_count INTEGER DEFAULT 0,
  seated_at TIMESTAMPTZ,
  created_by TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. 索引
CREATE INDEX IF NOT EXISTS idx_queue_store_status ON queue(store_id, status);
CREATE INDEX IF NOT EXISTS idx_queue_store_date ON queue(store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_queue_number ON queue(queue_number);
CREATE INDEX IF NOT EXISTS idx_queue_archived ON queue(archived_at);
CREATE INDEX IF NOT EXISTS idx_queue_type ON queue(store_id, type);
CREATE INDEX IF NOT EXISTS idx_queue_history_store ON queue_history(store_id, archived_at DESC);
CREATE INDEX IF NOT EXISTS idx_queue_history_archived ON queue_history(archived_at);

-- 4. 启用 RLS（行级安全），确保数据不跨店泄漏
ALTER TABLE queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE queue_history ENABLE ROW LEVEL SECURITY;

-- 使用 service_role key 的 API 不受 RLS 限制，所有操作在后端完成

-- 5. 创建清理函数：自动归档 7 天前的排队数据
CREATE OR REPLACE FUNCTION archive_old_queue() RETURNS INTEGER AS $$
DECLARE
  moved_count INTEGER;
BEGIN
  -- 将 7 天前的活跃排队移到历史表
  INSERT INTO queue_history
    (id, store_id, queue_number, type, daily_seq, name, phone, people,
     note, status, called_at, called_count, seated_at,
     created_by, created_at, updated_at, archived_at)
  SELECT id, store_id, queue_number, type, daily_seq, name, phone, people,
         note, status, called_at, called_count, seated_at,
         created_by, created_at, updated_at, NOW()
  FROM queue
  WHERE created_at < NOW() - INTERVAL '7 days'
    AND id NOT IN (SELECT id FROM queue_history);
  
  GET DIAGNOSTICS moved_count = ROW_COUNT;
  
  -- 从主表删除
  DELETE FROM queue WHERE created_at < NOW() - INTERVAL '7 days';
  
  RETURN moved_count;
END;
$$ LANGUAGE plpgsql;
