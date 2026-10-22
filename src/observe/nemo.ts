import type { LincoDb } from "../db/database.js";

/** Trace bundle a later NeMo Agent Toolkit run can diff. NeMo is not imported here. */
export function toNemoTrace(db: LincoDb, taskId: string) {
  const task = db.getTask(taskId);
  if (!task) throw new Error(`unknown task ${taskId}`);
  return {
    schema: "linco.observe.v1",
    source: "linco-harness",
    task,
    usage: db.usageSummary(taskId),
    traces: db.listTraces(taskId),
    approvals: db.listApprovals(taskId),
  };
}
