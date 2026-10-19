import type { PluginListAction, PluginListModel, PluginListRead, PluginListRow, PluginRowExpansion, PluginSessionCommandOutcome } from "@gang-of-beads/pi-web-plugin-api/plugin-api";

/**
 * What the background list shows for each task, decided in one place.
 *
 * The first list this plugin drew was bare spans, so a row read "Install pi-web .26 when
 * publishedlost" - name and status run together, four hundred of them, over the transcript.
 * The rows are now a pure classification the element only renders: the tool's status maps to
 * a named tone and a reader's word through one table, running work comes first, and a long
 * history is cut to the newest rows with the rest counted rather than silently dropped.
 */

export type TaskTone = "running" | "done" | "problem" | "unknown";

export type TasksRead = "unread" | "read" | "failed";

export interface TaskInput {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly startedAt?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly exitCode?: number | undefined;
}

export interface TaskRow {
  readonly id: string;
  readonly name: string;
  readonly tone: TaskTone;
  readonly label: string;
  readonly detail: string;
  readonly startedAt?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly exitCode?: number | undefined;
}

export interface TaskList {
  readonly running: readonly TaskRow[];
  readonly finished: readonly TaskRow[];
  readonly hiddenFinished: number;
}

const STATUS: Record<string, { tone: TaskTone; label: string }> = {
  running: { tone: "running", label: "running" },
  completed: { tone: "done", label: "done" },
  failed: { tone: "problem", label: "failed" },
  killed: { tone: "problem", label: "stopped" },
  lost: { tone: "problem", label: "lost" },
  unknown: { tone: "unknown", label: "unknown" },
};

export const FINISHED_SHOWN = 30;

export function taskPresentation(status: string): { tone: TaskTone; label: string } {
  return STATUS[status] ?? { tone: "unknown", label: status === "" ? "unknown" : status };
}

export function durationLabel(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ${String(seconds % 60)}s`;
  return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}m`;
}

function row(task: TaskInput): TaskRow {
  const presentation = taskPresentation(task.status);
  const parts = [durationLabel(task.durationMs), task.exitCode === undefined ? undefined : `exit ${String(task.exitCode)}`];
  return { id: task.id, name: task.name, ...presentation, detail: parts.filter((part) => part !== undefined).join(" · "), startedAt: task.startedAt, durationMs: task.durationMs, exitCode: task.exitCode };
}

function newestFirst(left: TaskInput, right: TaskInput): number {
  return (right.startedAt ?? "").localeCompare(left.startedAt ?? "");
}

export function backgroundTaskList(tasks: readonly TaskInput[], shown = FINISHED_SHOWN): TaskList {
  const running = tasks.filter((task) => task.status === "running").sort(newestFirst).map(row);
  const finished = tasks.filter((task) => task.status !== "running").sort(newestFirst);
  return {
    running,
    finished: finished.slice(0, shown).map(row),
    hiddenFinished: Math.max(0, finished.length - shown),
  };
}

/**
 * The page the host draws for this session's runs (owner, 2026-10-06: mockup A).
 *
 * Running work is one group and finished work another. A running row carries a
 * green "running"; a finished row its exit code as a plain value, or, when it
 * failed, the failure as a red status. The detail line is when it started and
 * how long it ran. An empty page is "none" only once the session was read;
 * before that it is still reading, and after a failed read it is unknown, with
 * any rows from an earlier read kept under the stale line.
 */
const LIST_READ: Readonly<Record<TasksRead, PluginListRead>> = { unread: "reading", read: "ready", failed: "failed" };

const LIST_WORDS = {
  empty: "This session has started no background runs.",
  reading: "Reading this session's background runs…",
  failed: "This machine could not read the background runs.",
  stale: "Could not refresh - showing the last read.",
} as const;

type RowSide = Pick<PluginListRow, "status" | "value">;

const exitWord = (row: TaskRow): string | undefined => row.exitCode === undefined ? undefined : `exit ${String(row.exitCode)}`;

const ROW_SIDE: Readonly<Record<TaskTone, (row: TaskRow) => RowSide>> = {
  running: (row) => ({ status: { label: row.label, tone: "good" } }),
  done: (row) => ({ value: exitWord(row) ?? row.label }),
  problem: (row) => ({ status: { label: exitWord(row) ?? row.label, tone: "problem" } }),
  unknown: (row) => ({ status: { label: row.label, tone: "neutral" } }),
};

export type ClockTime = (iso: string) => string | undefined;

const dayNumber = (date: Date): number => date.getFullYear() * 10_000 + date.getMonth() * 100 + date.getDate();

/** A time of day when it is today, else the date with it: a release check is cached for hours and a run may be yesterday's. */
export const localClockTime: ClockTime = (iso) => {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return undefined;
  const at = new Date(time);
  return dayNumber(at) === dayNumber(new Date())
    ? at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : at.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

function rowDetail(row: TaskRow, clock: ClockTime, startedWord: string): string {
  const started = row.startedAt === undefined ? undefined : clock(row.startedAt);
  const parts = [started === undefined ? undefined : `${startedWord}${started}`, durationLabel(row.durationMs)];
  return parts.filter((part) => part !== undefined).join(" · ");
}

/** What a host with rows that open adds to the list: each row's body, and Stop all beside "Running" while it has rows. */
export interface ListControls {
  readonly expansion?: (row: TaskRow) => PluginRowExpansion;
  readonly stopAll?: (running: readonly TaskRow[]) => PluginListAction;
}

function listRow(row: TaskRow, clock: ClockTime, startedWord: string, controls: ListControls): PluginListRow {
  const expansion = controls.expansion?.(row);
  return { id: row.id, title: row.name, ...ROW_SIDE[row.tone](row), detail: rowDetail(row, clock, startedWord), ...(expansion === undefined ? {} : { expansion }) };
}

export function backgroundListModel(tasks: readonly TaskInput[], read: TasksRead, clock: ClockTime = localClockTime, controls: ListControls = {}): PluginListModel {
  const list = backgroundTaskList(tasks);
  const hidden = list.hiddenFinished;
  const stopAll = list.running.length === 0 ? undefined : controls.stopAll?.(list.running);
  return {
    read: LIST_READ[read],
    words: LIST_WORDS,
    groups: [
      { id: "running", heading: "Running", rows: list.running.map((row) => listRow(row, clock, "started ", controls)), ...(stopAll === undefined ? {} : { headingAction: stopAll }) },
      { id: "finished", heading: "Finished", rows: list.finished.map((row) => listRow(row, clock, "", controls)) },
    ],
    notes: hidden === 0 ? [] : [`${String(hidden)} older ${hidden === 1 ? "run" : "runs"} not shown`],
  };
}

/**
 * What a row says after Stop (design-b3s3-v2 §4.4), decided from the command's outcome and whether the
 * list still reads the task running. A command that ran without a word claims no success: the note waits for the list.
 * The extension refuses a task that is no longer running with an error notice, which is what a second
 * device's Stop meets once the first one stopped it.
 */
export type StopNote = "pending" | "said" | "already-stopped" | "ran-still-running" | "refused" | "waiting" | "unknown";

/** A Stop still in flight is `undefined`. */
export type StopOutcome = PluginSessionCommandOutcome | undefined;

export function stopNote(outcome: StopOutcome, stillRunning: boolean): StopNote {
  if (outcome === undefined) return "pending";
  if (outcome.kind !== "ran") return outcome.kind;
  const last = outcome.notices.at(-1);
  if (!stillRunning && (last === undefined || last.level === "error")) return "already-stopped";
  return last === undefined ? "ran-still-running" : "said";
}

export type NoteTone = "info" | "warning" | "error";

export interface NoteLine {
  readonly words: string;
  readonly tone: NoteTone;
}

export const STOP_NOTE_LINE: Readonly<Record<StopNote, (outcome: StopOutcome) => NoteLine>> = {
  "pending": () => ({ words: "Stopping…", tone: "info" }),
  "said": (outcome) => {
    const last = outcome?.kind === "ran" ? outcome.notices.at(-1) : undefined;
    return { words: last?.message ?? "", tone: last?.level ?? "info" };
  },
  "already-stopped": () => ({ words: "Already stopped", tone: "info" }),
  "ran-still-running": () => ({ words: "The command ran; the task still reads running.", tone: "warning" }),
  "refused": (outcome) => ({ words: outcome?.kind === "refused" ? outcome.words : "", tone: "error" }),
  "waiting": () => ({ words: "No answer yet from the session; the list shows what happened.", tone: "info" }),
  "unknown": () => ({ words: "No answer from the machine; the list shows what happened.", tone: "warning" }),
};

/** A byte count the way the Whole log and the tail say it: "8 KiB", "12.4 MiB". */
export function byteSize(bytes: number): string {
  const units: readonly [number, string][] = [[1024 * 1024, "MiB"], [1024, "KiB"]];
  for (const [size, unit] of units) {
    if (bytes >= size) return `${String(Math.round((bytes / size) * 10) / 10)} ${unit}`;
  }
  return `${String(bytes)} bytes`;
}
