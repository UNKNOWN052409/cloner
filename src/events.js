// Global event bus + ring buffer so the dashboard can catch up on connect.
import { EventEmitter } from "node:events";

class Bus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);
    this.buffer = [];
    this.cap = 500;
    this.runMeta = null; // { mode, title, outDir, runId }
  }
  emit(type, data = {}) {
    const evt = { type, data, t: Date.now() };
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
