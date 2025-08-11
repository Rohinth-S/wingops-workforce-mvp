import { describe, expect, it } from "vitest";
import { createPostgresRepositoryFromExecutor } from "../src/repository.js";

describe("WingOps Postgres repository contract", () => {
  it("uses prefixed UUID tables and JSONB event metadata", async () => {
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    const executor = {
      query: async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        if (text.startsWith("SELECT id,email"))
          return {
            rows: [
              {
                id: "u1",
                email: "agent@example.test",
                role: "agent",
                password_hash: "scrypt$demo$hash",
              },
            ],
          };
        return { rows: [] };
      },
    };
    const repo = createPostgresRepositoryFromExecutor(executor);
    expect((await repo.getUserByEmail("agent@example.test"))?.id).toBe("u1");
    await repo.createTask({
      id: "t1",
      title: "Review",
      description: "Review evidence",
      status: "open",
      ownerId: "u2",
      assigneeId: null,
      dueAt: "2026-12-01T12:00:00.000Z",
    });
    await repo.addEvent({
      taskId: "t1",
      actorId: "u2",
      type: "task.created",
      metadata: { source: "test" },
    });
    expect(calls.some((call) => call.text.includes("wingops_users"))).toBe(
      true,
    );
    expect(calls.some((call) => call.text.includes("wingops_tasks"))).toBe(
      true,
    );
    expect(
      calls.some(
        (call) =>
          call.text.includes("wingops_events") &&
          call.text.includes("metadata"),
      ),
    ).toBe(true);
    expect(
      calls.every((call) => !call.text.includes("agent@example.test")),
    ).toBe(true);
  });
});
