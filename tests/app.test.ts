import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import app from "../src/app.js";
import { db } from "../src/db.js";
beforeEach(() => {
  for (const t of ["events", "attachments", "tasks", "users"])
    db.prepare(`DELETE FROM ${t}`).run();
});
describe("WingOps task workflow", () => {
  it("requires submission note and records events", async () => {
    const s = await request(app).post("/auth/register").send({
      email: "s@test.local",
      password: "correct-horse-battery",
      role: "supervisor",
    });
    const a = await request(app).post("/auth/register").send({
      email: "a@test.local",
      password: "correct-horse-battery",
      role: "agent",
    });
    const l = await request(app)
      .post("/auth/login")
      .send({ email: "s@test.local", password: "correct-horse-battery" });
    const t = await request(app)
      .post("/tasks")
      .set("Authorization", `Bearer ${l.body.token}`)
      .send({
        title: "Review delivery",
        description: "Review package evidence and approve delivery",
        dueAt: "2026-12-05T12:00:00.000Z",
        assigneeId: a.body.id,
      });
    const bad = await request(app)
      .post(`/tasks/${t.body.id}/status`)
      .set("Authorization", `Bearer ${l.body.token}`)
      .send({ status: "submitted" });
    expect(bad.status).toBe(409);
  });

  it("supports SLA escalation views and bulk status transitions", async () => {
    const supervisor = await request(app).post("/auth/register").send({
      email: "sla-supervisor@test.local",
      password: "correct-horse-battery",
      role: "supervisor",
    });
    const agent = await request(app).post("/auth/register").send({
      email: "sla-agent@test.local",
      password: "correct-horse-battery",
      role: "agent",
    });
    const login = await request(app).post("/auth/login").send({ email: "sla-supervisor@test.local", password: "correct-horse-battery" });
    const task = await request(app)
      .post("/tasks")
      .set("Authorization", `Bearer ${login.body.token}`)
      .send({ title: "Escalate overdue", description: "Review overdue delivery evidence", dueAt: "2026-01-01T12:00:00.000Z", assigneeId: agent.body.id });
    const escalations = await request(app)
      .get("/sla/escalations")
      .set("Authorization", `Bearer ${login.body.token}`);
    expect(escalations.status).toBe(200);
    expect(escalations.body.overdue).toBe(1);
    const bulk = await request(app)
      .post("/tasks/bulk-status")
      .set("Authorization", `Bearer ${login.body.token}`)
      .send({ taskIds: [task.body.id], status: "in_progress", dryRun: false });
    expect(bulk.status).toBe(200);
    expect(bulk.body.appliedCount).toBe(1);
    expect((await request(app).get(`/tasks/${task.body.id}/events`).set("Authorization", `Bearer ${login.body.token}`)).body).toEqual(expect.arrayContaining([expect.objectContaining({ type: "task.bulk_status_changed" })]));
  });
});
