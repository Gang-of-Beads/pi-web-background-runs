import type { PluginSessionCommandOutcome } from "@gang-of-beads/pi-web-plugin-api/plugin-api";
import type { TaskInput } from "./backgroundTaskRows.js";
import { tasksAt, tasksFrom, type TasksView } from "./tasksRead.js";

/**
 * The page's read of what this package's extension publishes on PI WEB's extension bus
 * (`context.session.bus`, PI WEB after 2.202611.10).
 *
 * The extension says what its tasks are now, and stops them. It knows the tasks of its own run only:
 * a session opened again after its runtime closed starts with none, while the task records still
 * hold what the session ran before. So the list is the records' read with the extension's word laid
 * over it, task by task. Where the extension says nothing (an older PI WEB, a runtime that is not
 * open) the records' read stands alone.
 */

export const TASKS_CHANNEL = "background-runs:tasks";
export const STOP_CHANNEL = "background-runs:stop";
export const OUTPUT_CHANNEL = "background-runs:output";
export const CLOCK_CHANNEL = "background-runs:clock";

type BusState = { readonly known: false } | { readonly known: true; readonly value: unknown };

/** The part of `PluginSessionBus` this page uses; declared here so the package builds against plugin-api releases older than the bus. */
export interface SessionBus {
  state(channel: string): BusState;
  request(channel: string, input?: unknown): Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSessionBus(value: unknown): value is SessionBus {
  return isRecord(value) && typeof value["state"] === "function" && typeof value["request"] === "function";
}

/** The bus of the session a panel shows, or none on a host without one. */
export function sessionBusOf(session: unknown): SessionBus | undefined {
  const bus: unknown = isRecord(session) ? session["bus"] : undefined;
  return isSessionBus(bus) ? bus : undefined;
}

/**
 * The published tasks as the panel's view. One value is held, for one session.
 */
export class PublishedTasks {
  private held: { key: string; json: string; tasks: readonly TaskInput[] } | undefined;
  /** How far the machine's clock is ahead of this device's, asked once a session; 0 until it answers. */
  private clock: { key: string; aheadMs: number } | undefined;

  constructor(private readonly changed: () => void = () => undefined) {}

  private aheadMs(key: string, bus: SessionBus): number {
    if (this.clock?.key === key) return this.clock.aheadMs;
    const asked = { key, aheadMs: 0 };
    this.clock = asked;
    const sentAt = Date.now();
    bus.request(CLOCK_CHANNEL).then((answer) => {
      const machineNow: unknown = isRecord(answer) ? answer["now"] : undefined;
      if (typeof machineNow !== "number") return;
      const receivedAt = Date.now();
      asked.aheadMs = machineNow - (sentAt + receivedAt) / 2;
      this.changed();
    }, () => undefined);
    return 0;
  }

  /** The view for a session, or undefined when its extension published nothing this page can read. */
  viewFor(key: string, bus: SessionBus | undefined, now: number): TasksView | undefined {
    const state = bus?.state(TASKS_CHANNEL);
    if (bus === undefined || state === undefined || !state.known) return undefined;
    const json = JSON.stringify(state.value);
    if (this.held?.key !== key || this.held.json !== json) {
      const tasks = tasksFrom({ known: true, tasks: isRecord(state.value) ? state.value["tasks"] : undefined });
      if (tasks === undefined) return undefined;
      this.held = { key, json, tasks };
    }
    const machineNow = now + this.aheadMs(key, bus);
    return { tasks: this.held.tasks.map((task) => runningSince(task, machineNow)), read: "read", readAt: now };
  }

  /** What the extension asks the reader to do about its installation, if anything. */
  notice(key: string, bus: SessionBus | undefined): string | undefined {
    const state = this.held?.key === key ? bus?.state(TASKS_CHANNEL) : undefined;
    const words: unknown = state?.known === true && isRecord(state.value) ? state.value["notice"] : undefined;
    return typeof words === "string" ? words : undefined;
  }

  /** Whether the extension published this task for this session: only such a task can be asked of it. */
  knows(key: string, taskId: string): boolean {
    return this.held?.key === key && this.held.tasks.some((task) => task.id === taskId);
  }
}

/**
 * The list a session shows: every task of the records' read, each as the extension says it now when
 * it publishes that task, and before them the tasks the records' read has not met yet.
 */
export function overRecords(published: TasksView, records: TasksView | undefined, now: number): TasksView {
  if (records === undefined) return published;
  const fresh = new Map(published.tasks.map((task) => [task.id, task]));
  const recorded = tasksAt(records, now);
  const met = new Set(recorded.map((task) => task.id));
  return { tasks: [...published.tasks.filter((task) => !met.has(task.id)), ...recorded.map((task) => fresh.get(task.id) ?? task)], read: "read", readAt: now };
}

/**
 * A running task's elapsed time. The published duration was measured when the extension last read
 * its tasks, which may be long before this page read the value, so it cannot be counted on from;
 * the start time can, against the machine's clock.
 */
function runningSince(task: TaskInput, now: number): TaskInput {
  const startedAt = task.status === "running" && task.startedAt !== undefined ? Date.parse(task.startedAt) : Number.NaN;
  return Number.isNaN(startedAt) ? task : { ...task, durationMs: Math.max(task.durationMs ?? 0, now - startedAt) };
}

/** The extension's answer to an output request, in the shape the server half's `tasks.output` answers. */
export function outputAnswer(result: unknown): unknown {
  return isRecord(result) ? { known: true, ...result } : undefined;
}

/** A request that may have been carried out with its answer lost: only the list says whether the task stopped. */
function answerLost(error: unknown): boolean {
  const code: unknown = isRecord(error) ? error["code"] : undefined;
  return code === "timeout" || code === "unreachable" || code === "session-changed" || (error instanceof Error && error.message.startsWith("NO_ANSWER"));
}

/** What a stop through the bus came to, in the words a session command's outcome uses, so the row says it the same way. */
export function stopOutcome(settled: { readonly error?: unknown }): PluginSessionCommandOutcome {
  if (!("error" in settled)) return { kind: "ran", notices: [{ level: "info", message: "Stopped" }] };
  if (answerLost(settled.error)) return { kind: "unknown", words: "" };
  const words = settled.error instanceof Error ? settled.error.message : "The task could not be stopped.";
  return { kind: "ran", notices: [{ level: "error", message: words }] };
}
