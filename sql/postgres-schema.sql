-- Managed Supabase Postgres schema for WingOps.
-- API uses a server-side service role; RLS is enabled as defense in depth.
CREATE TABLE IF NOT EXISTS wingops_users (id uuid PRIMARY KEY, email text UNIQUE NOT NULL, role text NOT NULL CHECK (role IN ('admin','supervisor','agent')), password_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS wingops_tasks (id uuid PRIMARY KEY, title text NOT NULL, description text NOT NULL, status text NOT NULL, owner_id uuid NOT NULL REFERENCES wingops_users(id), assignee_id uuid REFERENCES wingops_users(id), due_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS wingops_attachments (id uuid PRIMARY KEY, task_id uuid NOT NULL REFERENCES wingops_tasks(id), name text NOT NULL, mime text NOT NULL, object_key text NOT NULL, uploaded_at timestamptz);
CREATE TABLE IF NOT EXISTS wingops_events (id uuid PRIMARY KEY, task_id uuid NOT NULL REFERENCES wingops_tasks(id), actor_id uuid NOT NULL REFERENCES wingops_users(id), type text NOT NULL, metadata jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE wingops_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE wingops_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE wingops_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE wingops_events ENABLE ROW LEVEL SECURITY;
