import { describe, expect, it } from "vitest";
import { HOST_CHANGED_CHANNEL, HOST_REQUEST_CHANNEL, HOST_RESPONSE_CHANNEL, type PiEvents } from "./hostClient.js";
import { OUTPUT_CHANNEL, publishedTask, startWebBridge, STOP_CHANNEL, TASKS_CHANNEL } from "./webBridge.js";

/** A pi event bus, and a task service on it that answers as pi-background-tasks' host interface does. */
function busWithService(tasks: Record<string, unknown>[]) {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  const emitted: { channel: string; data: unknown }[] = [];
  const events: PiEvents = {
    emit: (channel, data) => { emitted.push({ channel, data }); for (const handler of [...(handlers.get(channel) ?? [])]) handler(data); },
    on: (channel, handler) => {
      const set = handlers.get(channel) ?? new Set();
      handlers.set(channel, set);
      set.add(handler);
      return () => { set.delete(handler); };
    },
  };
  const operations: string[] = [];
  const stopped: unknown[] = [];
  events.on(HOST_REQUEST_CHANNEL, (data) => {
    const request = data as { request_id: string; operation: string; payload: Record<string, unknown> };
    operations.push(request.operation);
    const reply = (body: Record<string, unknown>): void => { queueMicrotask(() => { events.emit(HOST_RESPONSE_CHANNEL, { request_id: request.request_id, operation: request.operation, ...body }); }); };
    if (request.operation === "subscribe") { reply({ ok: true, result: { leaseId: "lease-1", activationId: "act-1" } }); return; }
    if (request.payload["leaseId"] !== "lease-1") { reply({ ok: false, error: { code: "LEASE_INVALID", message: "no such lease" } }); return; }
    if (request.operation === "list") { reply({ ok: true, result: { tasks: tasks.map((task) => ({ task, kind: "shell" })), nextCursor: null } }); return; }
    if (request.operation === "stop") {
      const known = tasks.some((task) => task["id"] === request.payload["taskId"]);
      if (known) stopped.push(request.payload["taskId"]);
      reply(known ? { ok: true, result: {} } : { ok: false, error: { code: "NOT_FOUND", message: "no such task" } });
      return;
    }
    reply({ ok: true, result: { task: tasks[0], text: "out", totalBytes: 3, truncated: false } });
  });
  const published = (): unknown => emitted.filter((entry) => entry.channel === TASKS_CHANNEL).at(-1)?.data;
  const asked = (channel: string, input: unknown): Promise<unknown> => new Promise((resolve) => {
    const stop = events.on(`${channel}:response`, (data) => { stop(); resolve(data); });
    events.emit(`${channel}:request`, { id: "q1", input });
  });
  return { events, operations, stopped, published, asked };
}

const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

describe("the bridge to PI WEB's bus", () => {
  it("draws a task from the service's view of it", () => {
    expect([
      publishedTask({ task: { id: "b1", name: "build", command: "npm run build", status: "completed", startTime: 1_000, endTime: 4_000, exitCode: 0 }, kind: "shell" }, 9_000),
      publishedTask({ task: { id: "b2", command: "sleep 9", status: "running", startTime: 1_000 }, kind: "shell" }, 9_000),
      publishedTask({ nothing: true }, 9_000),
    ]).toEqual([
      { id: "b1", name: "build", status: "completed", kind: "shell", startedAt: "1970-01-01T00:00:01.000Z", durationMs: 3_000, exitCode: 0 },
      { id: "b2", name: "sleep 9", status: "running", kind: "shell", startedAt: "1970-01-01T00:00:01.000Z", durationMs: 8_000 },
      undefined,
    ]);
  });

  it("publishes the tasks when asked and on every change, under one lease", async () => {
    const tasks = [{ id: "b1", name: "build", status: "running", startTime: 0 }];
    const { events, operations, published } = busWithService(tasks);
    const bridge = startWebBridge(events, () => 5_000);
    bridge.refresh();
    await settle();
    tasks.push({ id: "b2", name: "test", status: "running", startTime: 0 });
    events.emit(HOST_CHANGED_CHANNEL, { kind: "changed" });
    await settle();
    bridge.stop();
    events.emit(HOST_CHANGED_CHANNEL, { kind: "changed" });
    await settle();
    expect({ operations, names: (published() as { tasks: { name: string }[] }).tasks.map((task) => task.name) }).toEqual({ operations: ["subscribe", "list", "list"], names: ["build", "test"] });
  });

  it("takes a new lease when the service started again", async () => {
    const { events, operations } = busWithService([]);
    const bridge = startWebBridge(events);
    bridge.refresh();
    await settle();
    events.emit(HOST_CHANGED_CHANNEL, { kind: "ready" });
    await settle();
    bridge.stop();
    expect(operations).toEqual(["subscribe", "list", "subscribe", "list"]);
  });

  it("stops the task a request names and says why when it cannot", async () => {
    const { events, stopped, asked } = busWithService([{ id: "b1", name: "build", status: "running", startTime: 0 }]);
    const bridge = startWebBridge(events);
    const answers = [await asked(STOP_CHANNEL, { id: "b1" }), await asked(STOP_CHANNEL, { id: "nope" }), await asked(STOP_CHANNEL, {}), await asked(OUTPUT_CHANNEL, { id: "b1", tailBytes: 10 })];
    bridge.stop();
    expect({ stopped, answers }).toEqual({
      stopped: ["b1"],
      answers: [
        { id: "q1", result: { stopped: true } },
        { id: "q1", error: "NOT_FOUND: no such task" },
        { id: "q1", error: "A task id is needed." },
        { id: "q1", result: { text: "out", totalBytes: 3, truncated: false, command: "", commandCut: false } },
      ],
    });
  });
});
