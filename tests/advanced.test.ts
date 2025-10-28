import { beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { db } from "../src/db.js";
import { createLocalRepository } from "../src/repository.js";

beforeEach(() => {
  for (const table of ["outbox", "events", "attachments", "tasks", "users"])
    db.prepare(`DELETE FROM ${table}`).run();
});

describe("WingOps operational workflows", () => {
  it("allows only one agent to claim an open task", async () => {
    const repo = createLocalRepository();
    for (const id of ["agent-a", "agent-b"])
      await repo.createUser({ id, email: `${id}@test.local`, role: "agent", passwordHash: "hash" });
    const taskId = crypto.randomUUID();
    await repo.createTask({
      id: taskId,
      title: "Inspect route",
      description: "Inspect route evidence and record findings",
      status: "open",
      ownerId: "owner",
      assigneeId: null,
      dueAt: "2026-12-05T12:00:00.000Z",
    });
    const claims = await Promise.all([
      repo.acceptTask(taskId, "agent-a"),
      repo.acceptTask(taskId, "agent-b"),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect((await repo.getTask(taskId))?.assignee_id).toBe(
      claims[0] ? "agent-a" : "agent-b",
    );
  });

  it("stores attachment hashes and emits an auditable outbox event", async () => {
    const repo = createLocalRepository();
    const taskId = crypto.randomUUID();
    await repo.createTask({
      id: taskId,
      title: "Verify package",
      description: "Verify package photo and document chain of custody",
      status: "open",
      ownerId: "owner",
      assigneeId: null,
      dueAt: "2026-12-05T12:00:00.000Z",
    });
    const hash = "a".repeat(64);
    const attachmentId = crypto.randomUUID();
    await repo.addAttachment({
      id: attachmentId,
      taskId,
      name: "evidence.pdf",
      mime: "application/pdf",
      objectKey: `wingops/${taskId}/evidence.pdf`,
      sha256: hash,
      sizeBytes: 4096,
    });
    const attachment = await repo.getAttachment(
      (db.prepare("SELECT id FROM attachments LIMIT 1").get() as { id: string }).id,
      taskId,
    );
    expect(attachment.sha256).toBe(hash);
    expect(attachment.size_bytes).toBe(4096);
    expect(await repo.verifyAttachment(attachmentId, taskId, hash, 4096)).toBe(true);
    expect((await repo.getAttachment(attachmentId, taskId))?.uploaded_at).toBeTruthy();
    expect(await repo.verifyAttachment(attachmentId, taskId, "b".repeat(64), 4096)).toBe(false);

    await repo.addEvent({
      taskId,
      actorId: "owner",
      type: "attachment.verified",
      metadata: { sha256: hash },
    });
    expect((await repo.listEvents(taskId, { type: "attachment.verified" }))).toHaveLength(1);
    const pending = await repo.listOutbox({ pendingOnly: true });
    expect(pending).toHaveLength(1);
    expect(await repo.markOutboxPublished(pending[0].id)).toBe(true);
    expect(await repo.listOutbox({ pendingOnly: true })).toHaveLength(0);
  });

  it("supports filtered task pages and supervisor metrics", async () => {
    const repo = createLocalRepository();
    await repo.createUser({ id: "agent-a", email: "agent-a@test.local", role: "agent", passwordHash: "hash" });
    for (let index = 0; index < 3; index++) {
      await repo.createTask({
        id: crypto.randomUUID(),
        title: `Parcel ${index}`,
        description: "Review parcel evidence",
        status: index === 0 ? "in_progress" : "open",
        ownerId: "owner",
        assigneeId: index === 0 ? "agent-a" : null,
        dueAt: "2026-12-05T12:00:00.000Z",
      });
    }
    const page = await repo.listTaskPage("supervisor", "owner", {
      status: "open",
      search: "Parcel",
      page: 1,
      pageSize: 1,
    });
    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(1);
    const metrics = await repo.metrics("supervisor", "owner");
    expect(metrics.total).toBe(3);
    expect(metrics.byStatus.open).toBe(2);
  });
});
