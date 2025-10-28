import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: any };
import fs from "node:fs";
import path from "node:path";
const file = process.env.DB_FILE ?? "./data/wingops.db";
fs.mkdirSync(path.dirname(file), { recursive: true });
export const db: any = new DatabaseSync(file);
db.exec(
  `CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','supervisor','agent')),password_hash TEXT NOT NULL,created_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,title TEXT NOT NULL,description TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('open','accepted','in_progress','submitted','approved','rejected')),owner_id TEXT NOT NULL,assignee_id TEXT REFERENCES users(id),due_at TEXT NOT NULL,created_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id),name TEXT NOT NULL,mime TEXT NOT NULL,object_key TEXT NOT NULL,sha256 TEXT,size_bytes INTEGER,uploaded_at TEXT); CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,actor_id TEXT NOT NULL,type TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,event_id TEXT NOT NULL,topic TEXT NOT NULL,payload TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,published_at TEXT); CREATE INDEX IF NOT EXISTS events_task_created_idx ON events(task_id,created_at DESC); CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox(published_at,created_at);`,
);
for (const statement of [
  "ALTER TABLE attachments ADD COLUMN sha256 TEXT",
  "ALTER TABLE attachments ADD COLUMN size_bytes INTEGER",
]) {
  try {
    db.exec(statement);
  } catch {
    // Existing local databases already carry these columns.
  }
}
