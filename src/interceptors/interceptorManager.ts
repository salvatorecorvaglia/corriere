import type { InterceptorHandler, InterceptorOptions } from '../types';

/**
 * A list of interceptors. `V` is the value each receives — the config for request
 * interceptors, the response for response interceptors — and `R` what it may return.
 */
export class InterceptorManager<V = any, R = V> {
  private _handlers: Map<number, InterceptorHandler<V, R>>;
  private _nextId: number;

  constructor() {
    this._handlers = new Map();
    this._nextId = 0;
  }

  use(
    fulfilled?: ((value: V) => R | Promise<R>) | null,
    rejected?: ((error: any) => unknown) | null,
    options: InterceptorOptions = {},
  ): number {
    const id = this._nextId++;
    this._handlers.set(id, {
      fulfilled: fulfilled || null,
      rejected: rejected || null,
      synchronous: options.synchronous || false,
      runWhen: options.runWhen || null,
    });
    return id;
  }

  eject(id: number): void {
    this._handlers.delete(id);
  }

  clear(): void {
    this._handlers.clear();
  }

  forEach(fn: (handler: InterceptorHandler<V, R>) => void): void {
    for (const handler of this._handlers.values()) {
      fn(handler);
    }
  }

  get size(): number {
    return this._handlers.size;
  }

  /**
   * Snapshot view for backward-compat introspection. Slot index = interceptor ID;
   * ejected IDs appear as `null`. Reading this builds a fresh array each time —
   * prefer `forEach`/`size` in hot paths.
   */
  get handlers(): Array<InterceptorHandler<V, R> | null> {
    const max = this._nextId;
    const out: Array<InterceptorHandler<V, R> | null> = new Array(max);
    out.fill(null);
    for (const [id, handler] of this._handlers.entries()) {
      if (id < max) {
        out[id] = handler;
      }
    }
    return out;
  }
}

export default InterceptorManager;
