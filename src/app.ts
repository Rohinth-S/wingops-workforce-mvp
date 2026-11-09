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
  (await getRepository()).addEvent({ actorId, taskId, type, metadata });
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
app.get("/tasks", auth, async (req: A, res) =>
  res.json(
    await (await getRepository()).listTasks(req.user!.role, req.user!.sub),
  ),
);
app.post("/tasks/:id/accept", auth, allow("agent"), async (req: A, res) => {
  const repo = await getRepository();
  const t = await repo.getTask(String(req.params.id));
  if (!t) return res.status(404).json({ error: "task not found" });
  if (t.status !== "open")
    return res.status(409).json({ error: "task is not open" });
  await repo.acceptTask(t.id, req.user!.sub);
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
app.get("/tasks/:id/events", auth, async (req, res) =>
  res.json(await (await getRepository()).listEvents(String(req.params.id))),
);
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "internal error" });
});
export default app;
