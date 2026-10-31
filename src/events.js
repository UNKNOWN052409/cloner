// Global event bus + ring buffer so the dashboard can catch up on connect.
// Concurrent jobs share the bus — emissions are tagged with the CURRENT job id
// (AsyncLocalStorage, correct under interleaved awaits) so per-job bridges can
// filter foreign traffic instead of leaking it into their own logs.
import { EventEmitter } from "node:events";
import { AsyncLocalStorage } from "node:async_hooks";

const jobScope = new AsyncLocalStorage();

class Bus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);
    this.buffer = [];
    this.cap = 500;
    this.runMeta = null; // { mode, title, outDir, runId }
  }
  emit(type, data = {}) {
    const evt = { type, data, t: Date.now(), job: jobScope.getStore() || null };
    this.buffer.push(evt);
    if (this.buffer.length > this.cap) this.buffer.shift();
    return super.emit(type, evt);
  }
  catchUp() {
    return { meta: this.runMeta, events: this.buffer };
  }
  reset() {
    this.buffer = [];
    this.runMeta = null;
  }
}

export const bus = new Bus();

// run fn with all bus emissions inside tagged as jobId (nested awaits keep
// the tag; concurrent jobs each carry their own)
export function withJobScope(jobId, fn) {
  return jobScope.run(jobId, fn);
}
