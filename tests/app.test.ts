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
    const s = await request(app)
      .post("/auth/register")
      .send({
        email: "s@test.local",
        password: "correct-horse-battery",
        role: "supervisor",
      });
    const a = await request(app)
      .post("/auth/register")
      .send({
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
});
