import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import crypto from "node:crypto";
import { z } from "zod";
import { createSignedUpload } from "./storage.js";
import {
  hashPassword,
  verifyPassword,
  sign,
  read,
  Claims,
  Role,
} from "./security.js";
import { createLocalRepository, WingOpsRepository } from "./repository.js";

const app = express();
const corsOrigins = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);
app.use(
  cors({
    origin: (origin, callback) => {
      if (
        !origin ||
        (process.env.NODE_ENV !== "production" && corsOrigins.length === 0) ||
        corsOrigins.includes(origin)
      )
        callback(null, true);
      else callback(new Error("origin not allowed"));
    },
  }),
);
app.use(express.json({ limit: "2mb" }));

type A = Request & { user?: Claims };
let repositoryPromise: Promise<WingOpsRepository> = Promise.resolve(
  createLocalRepository(),
);
export function setRepository(repository: WingOpsRepository) {
  repositoryPromise = Promise.resolve(repository);
}
export async function getRepository() {
  return repositoryPromise;
}
async function event(
  actorId: string,
  taskId: string,
  type: string,
  metadata: unknown = {},
) {
  await (await getRepository()).addEvent({ actorId, taskId, type, metadata });
}
function auth(req: A, res: Response, next: NextFunction) {
  const h = req.header("authorization");
  if (!h?.startsWith("Bearer "))
    return res.status(401).json({ error: "missing token" });
  try {
    req.user = read(h.slice(7));
    next();
  } catch {
    return res.status(401).json({ error: "invalid token" });
  }
}
function allow(...roles: Role[]) {
  return (req: A, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role))
      return res.status(403).json({ error: "forbidden" });
    next();
  };
}
function intQuery(value: unknown, fallback: number, max = 100) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(max, Math.max(1, Math.floor(parsed)))
    : fallback;
}

app.get("/health", (_, res) =>
  res.json({
    service: "wingops",
    status: "ok",
    persistence:
      process.env.DB_URL || process.env.SUPABASE_DB_URL ? "postgres" : "sqlite",
  }),
);
const reg = z.object({
  email: z.string().email(),
  password: z.string().min(12),
  role: z.enum(["admin", "supervisor", "agent"]).default("agent"),
});
app.post("/auth/register", async (req, res) => {
  const p = reg.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: p.error.flatten() });
  const id = crypto.randomUUID();
  try {
    await (
      await getRepository()
    ).createUser({
      id,
      email: p.data.email.toLowerCase(),
      role: p.data.role,
      passwordHash: hashPassword(p.data.password),
    });
    res.status(201).json({ id, email: p.data.email, role: p.data.role });
  } catch {
    res.status(409).json({ error: "email exists" });
  }
});
app.post("/auth/login", async (req, res) => {
  const p = z
    .object({ email: z.string().email(), password: z.string() })
    .safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "invalid credentials" });
  const u = await (
    await getRepository()
  ).getUserByEmail(p.data.email.toLowerCase());
  if (!u || !verifyPassword(p.data.password, u.password_hash))
    return res.status(401).json({ error: "invalid credentials" });
  res.json({
    token: sign({ sub: u.id, email: u.email, role: u.role }),
    user: { id: u.id, email: u.email, role: u.role },
  });
});
const task = z.object({
  title: z.string().min(3).max(120),
  description: z.string().min(10).max(4000),
  dueAt: z.string().datetime(),
  assigneeId: z.string().optional(),
});
app.post("/tasks", auth, allow("admin", "supervisor"), async (req: A, res) => {
  const p = task.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: p.error.flatten() });
  const repo = await getRepository();
  if (p.data.assigneeId) {
    const a = await repo.getAgent(p.data.assigneeId);
    if (!a || a.role !== "agent")
      return res.status(422).json({ error: "assignee must be an agent" });
  }
  const id = crypto.randomUUID();
  const status = p.data.assigneeId ? "accepted" : "open";
  await repo.createTask({
    id,
    title: p.data.title,
    description: p.data.description,
    status,
    ownerId: req.user!.sub,
    assigneeId: p.data.assigneeId ?? null,
    dueAt: p.data.dueAt,
  });
  await event(req.user!.sub, id, "task.created", p.data);
  res.status(201).json({ id, ...p.data, status });
});
app.get("/tasks", auth, async (req: A, res) => {
  const hasPage = req.query.page !== undefined || req.query.pageSize !== undefined ||
    req.query.search !== undefined || req.query.status !== undefined || req.query.assigneeId !== undefined;
  const repo = await getRepository();
  if (!hasPage) return res.json(await repo.listTasks(req.user!.role, req.user!.sub));
  const page = await repo.listTaskPage(req.user!.role, req.user!.sub, {
    page: intQuery(req.query.page, 1, 10_000),
    pageSize: intQuery(req.query.pageSize, 25),
    search: typeof req.query.search === "string" ? req.query.search : undefined,
    status: typeof req.query.status === "string" ? req.query.status : undefined,
    assigneeId: typeof req.query.assigneeId === "string" ? req.query.assigneeId : undefined,
  });
  res.json(page);
});
app.post("/tasks/:id/accept", auth, allow("agent"), async (req: A, res) => {
  const repo = await getRepository();
  const t = await repo.getTask(String(req.params.id));
  if (!t) return res.status(404).json({ error: "task not found" });
  if (t.status !== "open")
    return res.status(409).json({ error: "task is not open" });
  const claimed = await repo.acceptTask(t.id, req.user!.sub);
  if (!claimed)
    return res.status(409).json({ error: "task was claimed by another agent" });
  await event(req.user!.sub, t.id, "task.accepted");
  res.json({ id: t.id, status: "accepted", assigneeId: req.user!.sub });
});
const next = z.object({
  status: z.enum(["in_progress", "submitted", "approved", "rejected"]),
  note: z.string().max(1000).optional(),
});
app.post("/tasks/:id/status", auth, async (req: A, res) => {
  const p = next.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: p.error.flatten() });
  const repo = await getRepository();
  const t = await repo.getTask(String(req.params.id));
  if (!t) return res.status(404).json({ error: "task not found" });
  if (req.user!.role === "agent" && t.assignee_id !== req.user!.sub)
    return res.status(403).json({ error: "not your task" });
  const allowed: Record<string, string[]> = {
    accepted: ["in_progress"],
    in_progress: ["submitted"],
    submitted: ["approved", "rejected"],
    rejected: ["in_progress"],
  };
  if (!allowed[t.status]?.includes(p.data.status))
    return res
      .status(409)
      .json({
        error: "invalid transition " + t.status + " -> " + p.data.status,
      });
  if (p.data.status === "submitted" && !p.data.note)
    return res.status(422).json({ error: "submission note required" });
  await repo.updateTaskStatus(t.id, p.data.status);
  await event(req.user!.sub, t.id, "task.status_changed", p.data);
  res.json({ id: t.id, status: p.data.status });
});
app.post("/tasks/:id/attachments", auth, async (req: A, res) => {
  const repo = await getRepository();
  const t = await repo.getTask(String(req.params.id));
  if (!t) return res.status(404).json({ error: "task not found" });
  if (req.user!.role === "agent" && t.assignee_id !== req.user!.sub)
    return res.status(403).json({ error: "not your task" });
  const p = z
    .object({
      name: z.string().regex(/^[\w.-]+$/),
      mime: z.enum(["image/jpeg", "image/png", "application/pdf"]),
      sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
      sizeBytes: z.number().int().positive().max(25 * 1024 * 1024),
    })
    .safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: p.error.flatten() });
  const id = crypto.randomUUID(),
    key = "wingops/" + t.id + "/" + id + "-" + p.data.name;
  await repo.addAttachment({
    id,
    taskId: t.id,
    name: p.data.name,
    mime: p.data.mime,
    objectKey: key,
    sha256: p.data.sha256.toLowerCase(),
    sizeBytes: p.data.sizeBytes,
  });
  try {
    const signed = await createSignedUpload(key, 600);
    res
      .status(201)
      .json({
        id,
        objectKey: key,
        uploadUrl: signed.uploadUrl,
        uploadToken: signed.token,
        expiresIn: signed.expiresIn,
        provider: signed.provider,
      });
  } catch (error) {
    console.error(error);
    res.status(502).json({ error: "storage provider unavailable" });
  }
});
app.get("/tasks/:id/events", auth, async (req: A, res) => {
  const hasPaging = req.query.limit !== undefined || req.query.before !== undefined || req.query.type !== undefined;
  const repo = await getRepository();
  const requestedLimit = intQuery(req.query.limit, 50);
  const items = await repo.listEvents(String(req.params.id), {
    limit: hasPaging ? requestedLimit : undefined,
    before: typeof req.query.before === "string" ? req.query.before : undefined,
    type: typeof req.query.type === "string" ? req.query.type : undefined,
  });
  if (!hasPaging) return res.json(items);
  res.json({ items, nextCursor: items.length === requestedLimit ? items[items.length - 1]?.created_at ?? null : null });
});
app.post("/tasks/:id/attachments/:attachmentId/verify", auth, async (req: A, res) => {
  const repo = await getRepository();
  const task = await repo.getTask(String(req.params.id));
  if (!task) return res.status(404).json({ error: "task not found" });
  if (req.user!.role === "agent" && task.assignee_id !== req.user!.sub)
    return res.status(403).json({ error: "not your task" });
  const p = z
    .object({
      sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
      sizeBytes: z.number().int().positive().max(25 * 1024 * 1024),
    })
    .safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: p.error.flatten() });
  const verified = await repo.verifyAttachment(
    String(req.params.attachmentId),
    task.id,
    p.data.sha256,
    p.data.sizeBytes,
  );
  if (!verified) return res.status(422).json({ error: "attachment integrity check failed" });
  await event(req.user!.sub, task.id, "attachment.verified", {
    attachmentId: String(req.params.attachmentId),
    sha256: p.data.sha256.toLowerCase(),
    sizeBytes: p.data.sizeBytes,
  });
  res.json({ verified: true, attachmentId: String(req.params.attachmentId) });
});
app.get("/metrics", auth, allow("admin", "supervisor"), async (req: A, res) =>
  res.json(await (await getRepository()).metrics(req.user!.role, req.user!.sub)),
);
app.get("/outbox", auth, allow("admin", "supervisor"), async (req, res) =>
  res.json(await (await getRepository()).listOutbox({
    pendingOnly: req.query.pendingOnly !== "false",
    limit: req.query.limit === undefined ? undefined : intQuery(req.query.limit, 50),
  })),
);
app.post("/outbox/:id/publish", auth, allow("admin", "supervisor"), async (req, res) => {
  const published = await (await getRepository()).markOutboxPublished(String(req.params.id));
  if (!published) return res.status(404).json({ error: "outbox event not found or already published" });
  res.status(204).send();
});
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "internal error" });
});
export default app;
