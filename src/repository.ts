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
export type TaskPage = {
  items: TaskRow[];
  page: number;
  pageSize: number;
  total: number;
  pages: number;
};
export type TaskListOptions = {
  status?: string;
  assigneeId?: string;
  search?: string;
  page?: number;
  pageSize?: number;
};
export type EventListOptions = {
  before?: string;
  limit?: number;
  type?: string;
};
export type OutboxRow = {
  id: string;
  event_id: string;
  topic: string;
  payload: string;
  attempts: number;
  created_at: string;
  published_at: string | null;
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
  listTaskPage(
    role: Role,
    userId: string,
    options: TaskListOptions,
  ): Promise<TaskPage>;
  getTask(id: string): Promise<TaskRow | undefined>;
  /** Atomically claims an open task; false means another agent won the race. */
  acceptTask(id: string, agentId: string): Promise<boolean>;
  updateTaskStatus(id: string, status: string): Promise<void>;
  addAttachment(i: {
    id: string;
    taskId: string;
    name: string;
    mime: string;
    objectKey: string;
    sha256?: string;
    sizeBytes?: number;
  }): Promise<void>;
  getAttachment(id: string, taskId: string): Promise<any | undefined>;
  verifyAttachment(id: string, taskId: string, sha256: string, sizeBytes: number): Promise<boolean>;
  listEvents(taskId: string, options?: EventListOptions): Promise<any[]>;
  addEvent(i: {
    taskId: string;
    actorId: string;
    type: string;
    metadata: unknown;
  }): Promise<void>;
  listOutbox(options?: { pendingOnly?: boolean; limit?: number }): Promise<OutboxRow[]>;
  markOutboxPublished(id: string): Promise<boolean>;
  metrics(role: Role, userId: string): Promise<{
    total: number;
    byStatus: Record<string, number>;
    overdue: number;
    unassigned: number;
  }>;
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
  async listTaskPage(role: Role, userId: string, options: TaskListOptions) {
    const page = Math.max(1, Math.floor(options.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Math.floor(options.pageSize ?? 25)));
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (role === "agent") {
      clauses.push("(assignee_id=? OR (assignee_id IS NULL AND status='open'))");
      values.push(userId);
    }
    if (options.status) {
      clauses.push("status=?");
      values.push(options.status);
    }
    if (options.assigneeId) {
      clauses.push("assignee_id=?");
      values.push(options.assigneeId);
    }
    if (options.search) {
      clauses.push("(title LIKE ? OR description LIKE ?)");
      const term = `%${options.search}%`;
      values.push(term, term);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const total = Number(
      (db.prepare(`SELECT COUNT(*) AS count FROM tasks${where}`).get(...values) as { count: number }).count,
    );
    const items = db
      .prepare(`SELECT * FROM tasks${where} ORDER BY due_at, created_at LIMIT ? OFFSET ?`)
      .all(...values, pageSize, (page - 1) * pageSize) as TaskRow[];
    return { items, page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)) };
  }
  async getTask(id: string) {
    return db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as
      | TaskRow
      | undefined;
  }
  async acceptTask(id: string, agentId: string) {
    const result = db
      .prepare(
        "UPDATE tasks SET assignee_id=?,status='accepted' WHERE id=? AND status='open' AND assignee_id IS NULL",
      )
      .run(agentId, id);
    return Number(result.changes) === 1;
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
    sha256?: string;
    sizeBytes?: number;
  }) {
    db.prepare(
      "INSERT INTO attachments (id,task_id,name,mime,object_key,sha256,size_bytes,uploaded_at) VALUES (?,?,?,?,?,?,?,NULL)",
    ).run(
      i.id,
      i.taskId,
      i.name,
      i.mime,
      i.objectKey,
      i.sha256 ?? null,
      i.sizeBytes ?? null,
    );
  }
  async getAttachment(id: string, taskId: string) {
    return db
      .prepare("SELECT * FROM attachments WHERE id=? AND task_id=?")
      .get(id, taskId);
  }
  async verifyAttachment(id: string, taskId: string, sha256: string, sizeBytes: number) {
    const result = db
      .prepare("UPDATE attachments SET uploaded_at=? WHERE id=? AND task_id=? AND sha256=? AND size_bytes=?")
      .run(new Date().toISOString(), id, taskId, sha256.toLowerCase(), sizeBytes);
    return Number(result.changes) === 1;
  }
  async listEvents(taskId: string, options: EventListOptions = {}) {
    const clauses = ["task_id=?"];
    const values: unknown[] = [taskId];
    if (options.before) {
      clauses.push("created_at<?");
      values.push(options.before);
    }
    if (options.type) {
      clauses.push("type=?");
      values.push(options.type);
    }
    const paged = options.before !== undefined || options.type !== undefined || options.limit !== undefined;
    const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 100)));
    return db
      .prepare(`SELECT * FROM events WHERE ${clauses.join(" AND ")} ORDER BY created_at ${paged ? "DESC" : "ASC"} LIMIT ?`)
      .all(...values, limit);
  }
  async addEvent(i: {
    taskId: string;
    actorId: string;
    type: string;
    metadata: unknown;
  }) {
    const eventId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    db.prepare("INSERT INTO events VALUES (?,?,?,?,?,?)").run(
      eventId,
      i.taskId,
      i.actorId,
      i.type,
      JSON.stringify(i.metadata),
      createdAt,
    );
    db.prepare("INSERT INTO outbox (id,event_id,topic,payload,attempts,created_at) VALUES (?,?,?,?,0,?)").run(
      crypto.randomUUID(), eventId, `wingops.${i.type}`, JSON.stringify({ eventId, ...i, createdAt }), createdAt,
    );
  }
  async listOutbox(options: { pendingOnly?: boolean; limit?: number } = {}) {
    const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 50)));
    return db
      .prepare(
        `SELECT * FROM outbox${options.pendingOnly ? " WHERE published_at IS NULL" : ""} ORDER BY created_at LIMIT ?`,
      )
      .all(limit) as OutboxRow[];
  }
  async markOutboxPublished(id: string) {
    const result = db
      .prepare("UPDATE outbox SET published_at=? WHERE id=? AND published_at IS NULL")
      .run(new Date().toISOString(), id);
    return Number(result.changes) === 1;
  }
  async metrics(role: Role, userId: string) {
    const scope = role === "agent" ? " WHERE assignee_id=?" : "";
    const scopeValues = role === "agent" ? [userId] : [];
    const rows = db
      .prepare(`SELECT status,COUNT(*) AS count FROM tasks${scope} GROUP BY status`)
      .all(...scopeValues) as Array<{ status: string; count: number }>;
    const byStatus = Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
    const total = Object.values(byStatus).reduce((sum, count) => sum + count, 0);
    const overdue = Number(
      (db
        .prepare(`SELECT COUNT(*) AS count FROM tasks${scope ? `${scope} AND` : " WHERE"} due_at < datetime('now') AND status NOT IN ('approved','rejected')`)
        .get(...scopeValues) as { count: number }).count,
    );
    const unassigned = Number(
      (db.prepare(`SELECT COUNT(*) AS count FROM tasks${scope ? `${scope} AND` : " WHERE"} assignee_id IS NULL`).get(...scopeValues) as { count: number }).count,
    );
    return { total, byStatus, overdue, unassigned };
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
  async listTaskPage(role: Role, userId: string, options: TaskListOptions) {
    const page = Math.max(1, Math.floor(options.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Math.floor(options.pageSize ?? 25)));
    const values: unknown[] = [];
    const clauses: string[] = [];
    const bind = (value: unknown) => {
      values.push(value);
      return `$${values.length}`;
    };
    if (role === "agent") {
      clauses.push(`(assignee_id=${bind(userId)} OR (assignee_id IS NULL AND status='open'))`);
    }
    if (options.status) clauses.push(`status=${bind(options.status)}`);
    if (options.assigneeId) clauses.push(`assignee_id=${bind(options.assigneeId)}`);
    if (options.search) {
      const term = `%${options.search}%`;
      clauses.push(`(title ILIKE ${bind(term)} OR description ILIKE ${bind(term)})`);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const count = await this.executor.query(
      `SELECT COUNT(*)::int AS count FROM wingops_tasks${where}`,
      [...values],
    );
    const limitParam = bind(pageSize);
    const offsetParam = bind((page - 1) * pageSize);
    const rows = await this.executor.query(
      `SELECT * FROM wingops_tasks${where} ORDER BY due_at, created_at LIMIT ${limitParam} OFFSET ${offsetParam}`,
      values,
    );
    const total = Number(count.rows[0]?.count ?? 0);
    return { items: rows.rows as TaskRow[], page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)) };
  }
  async getTask(id: string) {
    const r = await this.executor.query(
      "SELECT * FROM wingops_tasks WHERE id=$1",
      [id],
    );
    return r.rows[0] as TaskRow | undefined;
  }
  async acceptTask(id: string, agentId: string) {
    const result = await this.executor.query(
      "UPDATE wingops_tasks SET assignee_id=$1,status='accepted' WHERE id=$2 AND status='open' AND assignee_id IS NULL RETURNING id",
      [agentId, id],
    );
    return result.rows.length === 1;
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
    sha256?: string;
    sizeBytes?: number;
  }) {
    await this.executor.query(
      "INSERT INTO wingops_attachments (id,task_id,name,mime,object_key,sha256,size_bytes,uploaded_at) VALUES ($1,$2,$3,$4,$5,$6,$7,NULL)",
      [i.id, i.taskId, i.name, i.mime, i.objectKey, i.sha256 ?? null, i.sizeBytes ?? null],
    );
  }
  async getAttachment(id: string, taskId: string) {
    const r = await this.executor.query(
      "SELECT * FROM wingops_attachments WHERE id=$1 AND task_id=$2",
      [id, taskId],
    );
    return r.rows[0];
  }
  async verifyAttachment(id: string, taskId: string, sha256: string, sizeBytes: number) {
    const r = await this.executor.query(
      "UPDATE wingops_attachments SET uploaded_at=NOW() WHERE id=$1 AND task_id=$2 AND sha256=$3 AND size_bytes=$4 RETURNING id",
      [id, taskId, sha256.toLowerCase(), sizeBytes],
    );
    return r.rows.length === 1;
  }
  async listEvents(taskId: string, options: EventListOptions = {}) {
    const values: unknown[] = [taskId];
    const clauses = ["task_id=$1"];
    if (options.before) {
      values.push(options.before);
      clauses.push(`created_at < $${values.length}`);
    }
    if (options.type) {
      values.push(options.type);
      clauses.push(`type = $${values.length}`);
    }
    values.push(Math.min(100, Math.max(1, Math.floor(options.limit ?? 100))));
    const paged = options.before !== undefined || options.type !== undefined || options.limit !== undefined;
    const r = await this.executor.query(
      `SELECT * FROM wingops_events WHERE ${clauses.join(" AND ")} ORDER BY created_at ${paged ? "DESC" : "ASC"} LIMIT $${values.length}`,
      values,
    );
    return r.rows;
  }
  async addEvent(i: {
    taskId: string;
    actorId: string;
    type: string;
    metadata: unknown;
  }) {
    const eventId = crypto.randomUUID();
    const payload = JSON.stringify(i.metadata);
    await this.executor.query(
      "INSERT INTO wingops_events (id,task_id,actor_id,type,metadata,created_at) VALUES ($1,$2,$3,$4,$5,NOW())",
      [
        eventId,
        i.taskId,
        i.actorId,
        i.type,
        payload,
      ],
    );
    await this.executor.query(
      "INSERT INTO wingops_outbox (id,event_id,topic,payload,attempts,created_at) VALUES ($1,$2,$3,$4,0,NOW())",
      [crypto.randomUUID(), eventId, `wingops.${i.type}`, JSON.stringify({ eventId, ...i })],
    );
  }
  async listOutbox(options: { pendingOnly?: boolean; limit?: number } = {}) {
    const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 50)));
    const r = await this.executor.query(
      `SELECT * FROM wingops_outbox${options.pendingOnly ? " WHERE published_at IS NULL" : ""} ORDER BY created_at LIMIT $1`,
      [limit],
    );
    return r.rows as OutboxRow[];
  }
  async markOutboxPublished(id: string) {
    const r = await this.executor.query(
      "UPDATE wingops_outbox SET published_at=NOW(), attempts=attempts+1 WHERE id=$1 AND published_at IS NULL RETURNING id",
      [id],
    );
    return r.rows.length === 1;
  }
  async metrics(role: Role, userId: string) {
    const values: unknown[] = [];
    const where = role === "agent" ? ` WHERE assignee_id=$1` : "";
    if (role === "agent") values.push(userId);
    const rows = await this.executor.query(
      `SELECT status,COUNT(*)::int AS count FROM wingops_tasks${where} GROUP BY status`,
      values,
    );
    const byStatus = Object.fromEntries(rows.rows.map((row) => [row.status, Number(row.count)]));
    const count = await this.executor.query(
      `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE due_at < NOW() AND status NOT IN ('approved','rejected'))::int AS overdue, COUNT(*) FILTER (WHERE assignee_id IS NULL)::int AS unassigned FROM wingops_tasks${where}`,
      values,
    );
    const row = count.rows[0] ?? {};
    return { total: Number(row.total ?? 0), byStatus, overdue: Number(row.overdue ?? 0), unassigned: Number(row.unassigned ?? 0) };
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
