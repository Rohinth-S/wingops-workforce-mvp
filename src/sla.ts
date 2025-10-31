import type { TaskRow } from "./repository.js";

export type SlaBand = "overdue" | "at_risk" | "on_track" | "terminal";
export type SlaAssessment = {
  taskId: string;
  band: SlaBand;
  minutesFromDue: number;
  escalation: "page_supervisor" | "notify_owner" | "none";
};

const terminalStatuses = new Set(["approved", "rejected"]);

export function assessTaskSla(task: TaskRow, now = new Date(), atRiskMinutes = 60): SlaAssessment {
  if (terminalStatuses.has(task.status)) return { taskId: task.id, band: "terminal", minutesFromDue: 0, escalation: "none" };
  const minutesFromDue = Math.floor((now.getTime() - new Date(task.due_at).getTime()) / 60_000);
  if (minutesFromDue > 0) return { taskId: task.id, band: "overdue", minutesFromDue, escalation: "page_supervisor" };
  if (minutesFromDue >= -atRiskMinutes) return { taskId: task.id, band: "at_risk", minutesFromDue, escalation: "notify_owner" };
  return { taskId: task.id, band: "on_track", minutesFromDue, escalation: "none" };
}

export function buildEscalationQueue(tasks: TaskRow[], now = new Date(), atRiskMinutes = 60) {
  const assessments = tasks
    .map((task) => ({ task, assessment: assessTaskSla(task, now, atRiskMinutes) }))
    .filter(({ assessment }) => assessment.band === "overdue" || assessment.band === "at_risk")
    .sort((a, b) => b.assessment.minutesFromDue - a.assessment.minutesFromDue);
  return {
    items: assessments,
    total: assessments.length,
    overdue: assessments.filter(({ assessment }) => assessment.band === "overdue").length,
    atRisk: assessments.filter(({ assessment }) => assessment.band === "at_risk").length,
  };
}
