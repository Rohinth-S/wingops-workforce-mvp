import { describe, expect, it } from "vitest";
import { assessTaskSla, buildEscalationQueue } from "../src/sla.js";

const task = (id: string, dueAt: string, status = "in_progress") => ({
  id,
  title: id,
  description: "Review evidence",
  status,
  owner_id: "owner",
  assignee_id: "agent",
  due_at: dueAt,
  created_at: "2026-01-01T00:00:00.000Z",
});

describe("WingOps SLA escalation", () => {
  it("classifies overdue, at-risk, on-track, and terminal work", () => {
    const now = new Date("2026-12-01T12:00:00.000Z");
    expect(assessTaskSla(task("late", "2026-12-01T11:00:00.000Z"), now).band).toBe("overdue");
    expect(assessTaskSla(task("soon", "2026-12-01T12:30:00.000Z"), now).band).toBe("at_risk");
    expect(assessTaskSla(task("later", "2026-12-01T16:00:00.000Z"), now).band).toBe("on_track");
    expect(assessTaskSla(task("done", "2026-12-01T11:00:00.000Z", "approved"), now).band).toBe("terminal");
  });

  it("orders escalation queue by urgency and emits counters", () => {
    const now = new Date("2026-12-01T12:00:00.000Z");
    const queue = buildEscalationQueue([
      task("at-risk", "2026-12-01T12:30:00.000Z"),
      task("overdue", "2026-12-01T10:00:00.000Z"),
      task("on-track", "2026-12-01T15:00:00.000Z"),
    ], now);
    expect(queue.total).toBe(2);
    expect(queue.overdue).toBe(1);
    expect(queue.atRisk).toBe(1);
    expect(queue.items[0].task.id).toBe("overdue");
    expect(queue.items[0].assessment.escalation).toBe("page_supervisor");
  });
});
