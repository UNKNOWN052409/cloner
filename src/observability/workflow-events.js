// Tiny workflow event emitter for the swarm build viewer (observability
// realignment): typed build events on the EXISTING global bus
// (src/events.js — the same ring buffer the /ws catchup replay ships). Every
// emission is tagged with the job id via withJobScope so per-job bridges and
// the platform WS gate can attribute it.
//
//   workflow.stage      { stage, status, progress? }   — REAL stage boundaries
//     (progress 0..1 while running, 1 on completion; status: running | completed
//     | completed-with-errors | failed | paused)
//   workflow.todo.add   { id, label, unit }            — one todo per unit of
//     work: one per discovered route, per component batch, per verification pass
//   workflow.todo.done  { id, label, unit, ok, note? } — every add gets a done;
//     ok:false + note carries the honest failure reason
//   workflow.agent      { label, unit }                — labeled build units as
//     they are produced ("page-002", "header.component", "tokens.css")
import { bus, withJobScope } from "../events.js";

export function createWorkflowEmitter({ jobId = null } = {}) {
  const open = new Map(); // todoId -> { id, label, unit } until its done event

  const emit = (type, data) => (jobId ? withJobScope(jobId, () => bus.emit(type, data)) : bus.emit(type, data));

  function stage(stageName, status, progress = null) {
    emit("workflow.stage", { stage: stageName, status, ...(progress == null ? {} : { progress }) });
  }

  function todoAdd(id, label, unit, agent = null) {
    open.set(id, { id, label, unit, agent });
    emit("workflow.todo.add", { id, label, unit });
    return id;
  }

  function todoDone(id, note = null) {
    const t = open.get(id);
    if (!t) return false; // unknown id — no add, no done (never invents closure)
    open.delete(id);
    // agent: the viewer credits the drawing agent from data.agent — default to
    // the unit's own label when the caller did not name a specific agent.
    emit("workflow.todo.done", { ...t, agent: t.agent || t.label, ok: !note, ...(note ? { note } : {}) });
    return true;
  }

  function agent(label, unit) {
    // Superset shape so the swarm viewer's reducer registers the agent from
    // data.id || data.agentId and names it from data.name || data.agent || id
    // (QA round: the bare { label, unit } shape never registered live agents).
    emit("workflow.agent", { id: label, agentId: label, name: label, label, unit });
  }

  // honest failure path: every still-open todo gets an ok:false done with the
  // reason (the viewer never sees a todo stuck open forever)
  function closeOpenTodos(note = "stage failed before completion") {
    const ids = [...open.keys()];
    for (const i of ids) todoDone(i, note);
    return ids.length;
  }

  const openTodos = () => [...open.values()];

  return { stage, todoAdd, todoDone, agent, closeOpenTodos, openTodos };
}
