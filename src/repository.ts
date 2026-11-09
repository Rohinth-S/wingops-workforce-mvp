import { Pool } from "pg";
import crypto from "node:crypto";
import { db } from "./db.js";

export type Role = "admin" | "supervisor" | "agent";
export type UserRow = {
  id: string;
  email: string;
  role: Role;
  password_hash: string;
};
export type TaskRow = {
  id: string;
  title: string;
  description: string;
  status: string;
  owner_id: string;
  assignee_id: string | null;
  due_at: string;
  created_at: string;
};
export type QueryExecutor = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }>;
};

export interface WingOpsRepository {
  createUser(i: {
    id: string;
    email: string;
    role: Role;
    passwordHash: string;
  }): Promise<void>;
  getUserByEmail(email: string): Promise<UserRow | undefined>;
  getAgent(id: string): Promise<{ id: string; role: Role } | undefined>;
  createTask(i: {
    id: string;
    title: string;
    description: string;
    status: string;
    ownerId: string;
    assigneeId: string | null;
    dueAt: string;
  }): Promise<void>;
  listTasks(role: Role, userId: string): Promise<TaskRow[]>;
  getTask(id: string): Promise<TaskRow | undefined>;
  acceptTask(id: string, agentId: string): Promise<void>;
  updateTaskStatus(id: string, status: string): Promise<void>;
  addAttachment(i: {
    id: string;
    taskId: string;
    name: string;
    mime: string;
    objectKey: string;
  }): Promise<void>;
  getAttachment(id: string, taskId: string): Promise<any | undefined>;
  listEvents(taskId: string): Promise<any[]>;
  addEvent(i: {
    taskId: string;
    actorId: string;
    type: string;
    metadata: unknown;
  }): Promise<void>;
  close(): Promise<void>;
}

class LocalRepository implements WingOpsRepository {
  async createUser(i: {
    id: string;
    email: string;
    role: Role;
    passwordHash: string;
  }) {
    db.prepare("INSERT INTO users VALUES (?,?,?,?,?)").run(
      i.id,
      i.email,
      i.role,
      i.passwordHash,
      new Date().toISOString(),
    );
  }
  async getUserByEmail(email: string) {
    return db
      .prepare("SELECT id,email,role,password_hash FROM users WHERE email=?")
      .get(email) as UserRow | undefined;
  }
  async getAgent(id: string) {
    return db.prepare("SELECT id,role FROM users WHERE id=?").get(id) as
      | { id: string; role: Role }
      | undefined;
  }
  async createTask(i: {
    id: string;
    title: string;
    description: string;
    status: string;
    ownerId: string;
    assigneeId: string | null;
    dueAt: string;
  }) {
    db.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?)").run(
      i.id,
      i.title,
      i.description,
      i.status,
      i.ownerId,
      i.assigneeId,
      i.dueAt,
      new Date().toISOString(),
    );
  }
  async listTasks(role: Role, userId: string) {
    return (
      role === "agent"
        ? db
            .prepare(
              "SELECT * FROM tasks WHERE assignee_id=? OR (assignee_id IS NULL AND status='open') ORDER BY due_at",
            )
            .all(userId)
        : db.prepare("SELECT * FROM tasks ORDER BY due_at").all()
    ) as TaskRow[];
  }
  async getTask(id: string) {
    return db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as
      | TaskRow
      | undefined;
  }
  async acceptTask(id: string, agentId: string) {
    db.prepare(
      "UPDATE tasks SET assignee_id=?,status='accepted' WHERE id=?",
    ).run(agentId, id);
  }
  async updateTaskStatus(id: string, status: string) {
    db.prepare("UPDATE tasks SET status=? WHERE id=?").run(status, id);
  }
  async addAttachment(i: {
    id: string;
    taskId: string;
    name: string;
    mime: string;
    objectKey: string;
  }) {
    db.prepare("INSERT INTO attachments VALUES (?,?,?,?,?,NULL)").run(
      i.id,
      i.taskId,
      i.name,
      i.mime,
      i.objectKey,
    );
  }
  async getAttachment(id: string, taskId: string) {
    return db
      .prepare("SELECT * FROM attachments WHERE id=? AND task_id=?")
      .get(id, taskId);
  }
  async listEvents(taskId: string) {
    return db
      .prepare("SELECT * FROM events WHERE task_id=? ORDER BY created_at")
      .all(taskId);
  }
  async addEvent(i: {
    taskId: string;
    actorId: string;
    type: string;
    metadata: unknown;
  }) {
    db.prepare("INSERT INTO events VALUES (?,?,?,?,?,?)").run(
      crypto.randomUUID(),
      i.taskId,
      i.actorId,
      i.type,
      JSON.stringify(i.metadata),
      new Date().toISOString(),
    );
  }
  async close() {}
}

class PostgresRepository implements WingOpsRepository {
  constructor(
    private readonly executor: QueryExecutor,
    private readonly pool?: Pool,
  ) {}
  async createUser(i: {
    id: string;
    email: string;
    role: Role;
    passwordHash: string;
  }) {
    await this.executor.query(
      "INSERT INTO wingops_users (id,email,role,password_hash,created_at) VALUES ($1,$2,$3,$4,NOW())",
      [i.id, i.email, i.role, i.passwordHash],
    );
  }
  async getUserByEmail(email: string) {
    const r = await this.executor.query(
      "SELECT id,email,role,password_hash FROM wingops_users WHERE email=$1",
      [email],
    );
    return r.rows[0] as UserRow | undefined;
  }
  async getAgent(id: string) {
    const r = await this.executor.query(
      "SELECT id,role FROM wingops_users WHERE id=$1",
      [id],
    );
    return r.rows[0] as { id: string; role: Role } | undefined;
  }
  async createTask(i: {
    id: string;
    title: string;
    description: string;
    status: string;
    ownerId: string;
    assigneeId: string | null;
    dueAt: string;
  }) {
    await this.executor.query(
      "INSERT INTO wingops_tasks (id,title,description,status,owner_id,assignee_id,due_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())",
      [
        i.id,
        i.title,
        i.description,
        i.status,
        i.ownerId,
        i.assigneeId,
        i.dueAt,
      ],
    );
  }
  async listTasks(role: Role, userId: string) {
    const r =
      role === "agent"
        ? await this.executor.query(
            "SELECT * FROM wingops_tasks WHERE assignee_id=$1 OR (assignee_id IS NULL AND status='open') ORDER BY due_at",
            [userId],
          )
        : await this.executor.query(
            "SELECT * FROM wingops_tasks ORDER BY due_at",
          );
    return r.rows as TaskRow[];
  }
  async getTask(id: string) {
    const r = await this.executor.query(
      "SELECT * FROM wingops_tasks WHERE id=$1",
      [id],
    );
    return r.rows[0] as TaskRow | undefined;
  }
  async acceptTask(id: string, agentId: string) {
    await this.executor.query(
      "UPDATE wingops_tasks SET assignee_id=$1,status='accepted' WHERE id=$2",
      [agentId, id],
    );
  }
  async updateTaskStatus(id: string, status: string) {
    await this.executor.query(
      "UPDATE wingops_tasks SET status=$1 WHERE id=$2",
      [status, id],
    );
  }
  async addAttachment(i: {
    id: string;
    taskId: string;
    name: string;
    mime: string;
    objectKey: string;
  }) {
    await this.executor.query(
      "INSERT INTO wingops_attachments (id,task_id,name,mime,object_key,uploaded_at) VALUES ($1,$2,$3,$4,$5,NULL)",
      [i.id, i.taskId, i.name, i.mime, i.objectKey],
    );
  }
  async getAttachment(id: string, taskId: string) {
    const r = await this.executor.query(
      "SELECT * FROM wingops_attachments WHERE id=$1 AND task_id=$2",
      [id, taskId],
    );
    return r.rows[0];
  }
  async listEvents(taskId: string) {
    const r = await this.executor.query(
      "SELECT * FROM wingops_events WHERE task_id=$1 ORDER BY created_at",
      [taskId],
    );
    return r.rows;
  }
  async addEvent(i: {
    taskId: string;
    actorId: string;
    type: string;
    metadata: unknown;
  }) {
    await this.executor.query(
      "INSERT INTO wingops_events (id,task_id,actor_id,type,metadata,created_at) VALUES ($1,$2,$3,$4,$5,NOW())",
      [
        crypto.randomUUID(),
        i.taskId,
        i.actorId,
        i.type,
        JSON.stringify(i.metadata),
      ],
    );
  }
  async close() {
    await this.pool?.end();
  }
}

const POSTGRES_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS wingops_users (id UUID PRIMARY KEY,email TEXT UNIQUE NOT NULL,role TEXT NOT NULL,password_hash TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());",
  "CREATE TABLE IF NOT EXISTS wingops_tasks (id UUID PRIMARY KEY,title TEXT NOT NULL,description TEXT NOT NULL,status TEXT NOT NULL,owner_id UUID NOT NULL REFERENCES wingops_users(id),assignee_id UUID REFERENCES wingops_users(id),due_at TIMESTAMPTZ NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());",
  "CREATE TABLE IF NOT EXISTS wingops_attachments (id UUID PRIMARY KEY,task_id UUID NOT NULL REFERENCES wingops_tasks(id),name TEXT NOT NULL,mime TEXT NOT NULL,object_key TEXT NOT NULL,uploaded_at TIMESTAMPTZ);",
  "CREATE TABLE IF NOT EXISTS wingops_events (id UUID PRIMARY KEY,task_id UUID NOT NULL REFERENCES wingops_tasks(id),actor_id UUID NOT NULL REFERENCES wingops_users(id),type TEXT NOT NULL,metadata JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());",
  "ALTER TABLE wingops_users ENABLE ROW LEVEL SECURITY;",
  "ALTER TABLE wingops_tasks ENABLE ROW LEVEL SECURITY;",
  "ALTER TABLE wingops_attachments ENABLE ROW LEVEL SECURITY;",
  "ALTER TABLE wingops_events ENABLE ROW LEVEL SECURITY;",
].join("\n");

export function createLocalRepository(): WingOpsRepository {
  return new LocalRepository();
}
export function createPostgresRepositoryFromExecutor(executor: QueryExecutor) {
  return new PostgresRepository(executor);
}
export async function createRepository(): Promise<WingOpsRepository> {
  const connectionString = process.env.DB_URL ?? process.env.SUPABASE_DB_URL;
  if (!connectionString) return new LocalRepository();
  const pool = new Pool({
    connectionString,
    ssl:
      process.env.PGSSLMODE === "disable"
        ? undefined
        : { rejectUnauthorized: false },
    max: 10,
  });
  return new PostgresRepository(pool, pool);
}
