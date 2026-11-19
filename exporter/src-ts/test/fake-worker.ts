// A stand-in for one pooled worker thread: records the posted messages and
// lets a test deliver the protocol events by hand.

import type { WorkerListener, WorkerPort } from "../app/wasm/pool.js";

interface Listener {
  fn: WorkerListener;
  once: boolean;
}

export class FakeWorker implements WorkerPort {
  __id?: number;
  __alive = true;
  readonly posted: unknown[] = [];
  terminations = 0;

  private listeners = new Map<string, Listener[]>();

  on(event: string, listener: WorkerListener): this {
    this.add(event, listener, false);
    return this;
  }

  once(event: string, listener: WorkerListener): this {
    this.add(event, listener, true);
    return this;
  }

  off(event: string, listener: WorkerListener): this {
    const list = this.listeners.get(event) ?? [];
    this.listeners.set(
      event,
      list.filter((item) => item.fn !== listener),
    );
    return this;
  }

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  // A real terminate resolves after the thread exits, never synchronously;
  // tests raise "exit" themselves when they need that part of the protocol.
  terminate(): number {
    this.terminations += 1;
    this.__alive = false;
    return 0;
  }

  emit(event: string, ...args: unknown[]): void {
    const list = [...(this.listeners.get(event) ?? [])];
    for (const item of list) {
      if (item.once) this.off(event, item.fn);
      item.fn(...args);
    }
  }

  listenerCount(event: string): number {
    return (this.listeners.get(event) ?? []).length;
  }

  private add(event: string, fn: WorkerListener, once: boolean): void {
    const list = this.listeners.get(event) ?? [];
    list.push({ fn, once });
    this.listeners.set(event, list);
  }
}
