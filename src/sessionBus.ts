import type { PluginSessionCommandOutcome } from "@gang-of-beads/pi-web-plugin-api/plugin-api";
import type { TaskInput } from "./backgroundTaskRows.js";
import { tasksFrom, type TasksView } from "./tasksRead.js";

/**
 * The page's read of what this package's extension publishes on PI WEB's extension bus
 * (`context.session.bus`, PI WEB after 2.202611.10).
 *
 * The bus is the first source: the extension owns its tasks and says what they are. Where it says
 * nothing (an older PI WEB, a session whose runtime is not open, a pi-background-tasks installed on
 * its own without this package's bridge) the state is unknown, and the page falls back to the
 * server half's read of the task records.
 *
 * shortcut: a running task's elapsed time is this device's clock against the machine's start time, so
 * the two clocks' difference shows in it; upgrade by publishing the machine's clock when that matters.
 */

export const TASKS_CHANNEL = "background-runs:tasks";
export const STOP_CHANNEL = "background-runs:stop";
export const OUTPUT_CHANNEL = "background-runs:output";

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

  /** The view for a session, or undefined when its extension published nothing this page can read. */
  viewFor(key: string, bus: SessionBus | undefined, now: number): TasksView | undefined {
    const state = bus?.state(TASKS_CHANNEL);
    if (state === undefined || !state.known) return undefined;
    /** The extension lists its newest 50. Past that a long-running task would drop off the list unseen, and the task records hold every one. */
    if (isRecord(state.value) && state.value["more"] === true) return undefined;
    const json = JSON.stringify(state.value);
    if (this.held?.key !== key || this.held.json !== json) {
      const tasks = tasksFrom({ known: true, tasks: isRecord(state.value) ? state.value["tasks"] : undefined });
      if (tasks === undefined) return undefined;
      this.held = { key, json, tasks };
    }
    return { tasks: this.held.tasks.map((task) => runningSince(task, now)), read: "read", readAt: now };
  }
}

/**
 * A running task's elapsed time on this page's clock. The published duration was measured when the
 * extension last read its tasks, which may be long before this page read the value, so it cannot be
 * counted on from; the start time can, at the cost of the two clocks' difference.
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
  return code === "timeout" || code === "unreachable" || (error instanceof Error && error.message.startsWith("NO_ANSWER"));
}

/** What a stop through the bus came to, in the words a session command's outcome uses, so the row says it the same way. */
export function stopOutcome(settled: { readonly error?: unknown }): PluginSessionCommandOutcome {
  if (!("error" in settled)) return { kind: "ran", notices: [{ level: "info", message: "Stopped" }] };
  if (answerLost(settled.error)) return { kind: "unknown", words: "" };
  const words = settled.error instanceof Error ? settled.error.message : "The task could not be stopped.";
  return { kind: "ran", notices: [{ level: "error", message: words }] };
}
