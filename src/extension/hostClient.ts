/**
 * A client of pi-background-tasks' host interface (its `docs/api/eventbus-host-v1.md`): the surface
 * that package offers a front end for listing, following and stopping its tasks, on `pi.events`.
 *
 * It holds one lease per activation and numbers its requests as the service requires. Nothing here
 * knows PI WEB: it answers "what are the tasks" and "stop this one" to whoever asks.
 */

export const HOST_REQUEST_CHANNEL = "pi-background-tasks:host:request:v1";
export const HOST_RESPONSE_CHANNEL = "pi-background-tasks:host:response:v1";
export const HOST_CHANGED_CHANNEL = "pi-background-tasks:host:changed:v1";
const REQUEST_SCHEMA = "pi-background-tasks.host-request.v1";
const ANSWER_TIMEOUT_MS = 15_000;

export interface PiEvents {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

/** A refusal by the host interface; `code` is its own (`NOT_FOUND`, `LEASE_INVALID`, ...), or `NO_ANSWER`. */
export class HostRefusal extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "HostRefusal";
  }
}

interface Lease { readonly leaseId: string; readonly activationId: string; sequence: number }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class BackgroundTaskHostClient {
  private lease: Lease | undefined;
  private leasing: Promise<Lease> | undefined;
  private requests = 0;

  constructor(private readonly events: PiEvents, private readonly clientId: string, private readonly timeoutMs = ANSWER_TIMEOUT_MS) {}

  /** The change feed: `ready`, `changed` or `closed`, each a reason to read again or to stop. */
  onChanged(listener: (kind: string) => void): () => void {
    return this.events.on(HOST_CHANGED_CHANNEL, (frame) => {
      const kind = isRecord(frame) ? frame["kind"] : undefined;
      if (kind === "closed" || kind === "ready") this.forgetLease();
      if (typeof kind === "string") listener(kind);
    });
  }

  /** The service closed or started again: its lease is gone with it. */
  forgetLease(): void {
    this.lease = undefined;
    this.leasing = undefined;
  }

  list(limit: number): Promise<unknown> {
    return this.leased("list", { limit });
  }

  stop(taskId: string): Promise<unknown> {
    return this.leased("stop", { taskId });
  }

  logs(taskId: string, maxBytes: number): Promise<unknown> {
    return this.leased("logs", { taskId, maxBytes, tail: true });
  }

  detail(taskId: string): Promise<unknown> {
    return this.leased("detail", { taskId });
  }

  /** A leased operation; a lease the service no longer knows is taken again, once. */
  private async leased(operation: string, payload: Record<string, unknown>, retried = false): Promise<unknown> {
    const lease = await this.currentLease();
    lease.sequence += 1;
    try {
      return await this.ask(operation, { ...payload, leaseId: lease.leaseId, activationId: lease.activationId, sequence: lease.sequence });
    } catch (error) {
      const stale = error instanceof HostRefusal && (error.code === "LEASE_INVALID" || error.code === "ACTIVATION_MISMATCH");
      if (!stale || retried) throw error;
      this.forgetLease();
      return this.leased(operation, payload, true);
    }
  }

  private currentLease(): Promise<Lease> {
    if (this.lease !== undefined) return Promise.resolve(this.lease);
    this.leasing ??= this.ask("subscribe", { clientId: this.clientId }).then((result) => {
      if (!isRecord(result) || typeof result["leaseId"] !== "string" || typeof result["activationId"] !== "string") throw new HostRefusal("NO_ANSWER", "The background task service did not grant a lease.");
      this.lease = { leaseId: result["leaseId"], activationId: result["activationId"], sequence: 0 };
      return this.lease;
    }).finally(() => { this.leasing = undefined; });
    return this.leasing;
  }

  private ask(operation: string, payload: Record<string, unknown>): Promise<unknown> {
    this.requests += 1;
    const requestId = `${this.clientId}-${String(Date.now())}-${String(this.requests)}`;
    return new Promise((resolve, reject) => {
      const settle = (run: () => void): void => {
        clearTimeout(timer);
        stopListening();
        run();
      };
      const timer = setTimeout(() => { settle(() => { reject(new HostRefusal("NO_ANSWER", `The background task service did not answer ${operation}.`)); }); }, this.timeoutMs);
      const stopListening = this.events.on(HOST_RESPONSE_CHANNEL, (frame) => {
        if (!isRecord(frame) || frame["request_id"] !== requestId) return;
        const error = frame["error"];
        if (frame["ok"] === true) settle(() => { resolve(frame["result"]); });
        else settle(() => { reject(new HostRefusal(isRecord(error) && typeof error["code"] === "string" ? error["code"] : "OPERATION_FAILED", isRecord(error) && typeof error["message"] === "string" ? error["message"] : "The background task service refused.")); });
      });
      this.events.emit(HOST_REQUEST_CHANNEL, { schema_version: REQUEST_SCHEMA, request_id: requestId, operation, payload });
    });
  }
}
