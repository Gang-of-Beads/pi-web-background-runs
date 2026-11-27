import { describe, expect, it } from "vitest";
import { outputAnswer, overRecords, PublishedTasks, sessionBusOf, stopOutcome, TASKS_CHANNEL, type SessionBus } from "./sessionBus.js";

function busWith(value: unknown): SessionBus {
  return { state: (channel) => (channel === TASKS_CHANNEL && value !== undefined ? { known: true, value } : { known: false }), request: () => Promise.resolve(undefined) };
}

describe("the page's read of the extension bus", () => {
  it("finds a bus only on a session that carries one", () => {
    const bus = busWith({ tasks: [] });
    expect([sessionBusOf({ id: "s", bus }), sessionBusOf({ id: "s" }), sessionBusOf(undefined), sessionBusOf({ bus: { state: 1 } })]).toEqual([bus, undefined, undefined, undefined]);
  });

  it("gives the published tasks, a running one timed from its start, and nothing where nothing was published", () => {
    const published = new PublishedTasks();
    const started = "2026-01-01T00:00:00.000Z";
    const at = Date.parse(started) + 90_000;
    const value = { tasks: [{ id: "b1", name: "build", status: "running", startedAt: started, durationMs: 5 }, { id: "b2", name: "test", status: "completed", startedAt: started, durationMs: 7_000, exitCode: 0 }] };
    expect([
      published.viewFor("m/s", busWith(value), at),
      published.viewFor("m/s", busWith(undefined), at),
      published.viewFor("m/s", undefined, at),
      published.viewFor("m/s", busWith({ tasks: "nope" }), at),
    ]).toEqual([
      { read: "read", readAt: at, tasks: [{ id: "b1", name: "build", status: "running", startedAt: started, durationMs: 90_000 }, { id: "b2", name: "test", status: "completed", startedAt: started, durationMs: 7_000, exitCode: 0 }] },
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("lays the extension's word over the records' read, task by task", () => {
    const records = { read: "read" as const, readAt: 1_000, tasks: [{ id: "b2", name: "serve", status: "running", durationMs: 10 }, { id: "b1", name: "old", status: "killed", durationMs: 5 }] };
    const published = { read: "read" as const, readAt: 3_000, tasks: [{ id: "b3", name: "new", status: "running", durationMs: 1 }, { id: "b2", name: "serve", status: "completed", durationMs: 40, exitCode: 0 }] };
    expect([overRecords(published, records, 3_000).tasks, overRecords(published, undefined, 3_000)]).toEqual([
      [{ id: "b3", name: "new", status: "running", durationMs: 1 }, { id: "b2", name: "serve", status: "completed", durationMs: 40, exitCode: 0 }, { id: "b1", name: "old", status: "killed", durationMs: 5 }],
      published,
    ]);
  });

  it("says a stop and an output read in the words the rows already use", () => {
    expect([stopOutcome({}), stopOutcome({ error: new Error("NOT_FOUND: no such task") }), stopOutcome({ error: Object.assign(new Error("late"), { code: "timeout" }) }), outputAnswer({ text: "a", totalBytes: 1, truncated: false }), outputAnswer("x")]).toEqual([
      { kind: "ran", notices: [{ level: "info", message: "Stopped" }] },
      { kind: "ran", notices: [{ level: "error", message: "NOT_FOUND: no such task" }] },
      { kind: "unknown", words: "" },
      { known: true, text: "a", totalBytes: 1, truncated: false },
      undefined,
    ]);
  });
});
