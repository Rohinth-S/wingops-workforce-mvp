-- Managed Supabase Postgres schema for WingOps.
-- API uses a server-side service role; RLS is enabled as defense in depth.
CREATE TABLE IF NOT EXISTS wingops_users (id uuid PRIMARY KEY, email text UNIQUE NOT NULL, role text NOT NULL CHECK (role IN ('admin','supervisor','agent')), password_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS wingops_tasks (id uuid PRIMARY KEY, title text NOT NULL, description text NOT NULL, status text NOT NULL, owner_id uuid NOT NULL REFERENCES wingops_users(id), assignee_id uuid REFERENCES wingops_users(id), due_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS wingops_attachments (id uuid PRIMARY KEY, task_id uuid NOT NULL REFERENCES wingops_tasks(id), name text NOT NULL, mime text NOT NULL, object_key text NOT NULL, sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'), size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes > 0), uploaded_at timestamptz);
ALTER TABLE wingops_attachments ADD COLUMN IF NOT EXISTS sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$');
ALTER TABLE wingops_attachments ADD COLUMN IF NOT EXISTS size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes > 0);
CREATE TABLE IF NOT EXISTS wingops_events (id uuid PRIMARY KEY, task_id uuid NOT NULL REFERENCES wingops_tasks(id), actor_id uuid NOT NULL REFERENCES wingops_users(id), type text NOT NULL, metadata jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS wingops_outbox (id uuid PRIMARY KEY, event_id uuid NOT NULL REFERENCES wingops_events(id), topic text NOT NULL, payload jsonb NOT NULL, attempts integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz);
CREATE INDEX IF NOT EXISTS wingops_events_task_created_idx ON wingops_events(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS wingops_outbox_pending_idx ON wingops_outbox(published_at, created_at);
ALTER TABLE wingops_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE wingops_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE wingops_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE wingops_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE wingops_outbox ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_role_full_access ON wingops_users FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_role_full_access ON wingops_tasks FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_role_full_access ON wingops_attachments FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_role_full_access ON wingops_events FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_role_full_access ON wingops_outbox FOR ALL TO service_role USING (true) WITH CHECK (true);
