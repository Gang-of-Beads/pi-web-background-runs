import type { TaskInput, TasksRead } from "./backgroundTaskRows.js";

/** The session a read is for: its working directory and transcript, which the server reads from. */
export interface TaskScope {
  readonly cwd: string;
  readonly sessionFile: string;
}

export interface TasksView {
  readonly tasks: readonly TaskInput[];
  readonly read: TasksRead;
  /** This page's clock when the tasks were read (`Date.now()`). */
  readonly readAt: number;
}

const UNREAD: TasksView = { tasks: [], read: "unread", readAt: 0 };

/**
 * The tasks as of `now` on this page: a running task's elapsed time advances by the time since the
 * read, so it moves on screen without another read. It counts on from the machine's own measure from
 * the task's start, so a page whose clock differs from the machine's still shows the right time.
 * A finished task keeps its final duration.
 */
export function tasksAt(view: TasksView, now: number): readonly TaskInput[] {
  const sinceRead = Math.max(0, now - view.readAt);
  return view.tasks.map((task) => task.status === "running" && task.durationMs !== undefined ? { ...task, durationMs: task.durationMs + sinceRead } : task);
}

/**
 * The panel's read of one session's tasks.
 *
 * A read is asked when the session on screen changes or when one of the facts that move with its
 * tasks does (the caller's key: the session's background run count and whether its turn runs). A
 * list belongs to the session it was
 * read for and never shows under another; only the latest read may land; a failed read keeps the
 * list it had for the same session and says the read failed.
 */
export class TasksReader {
  private sessionFile: string | undefined;
  private key: string | undefined;
  private view: TasksView = UNREAD;
  private issued = 0;

  constructor(
    private readonly ask: (scope: TaskScope) => Promise<unknown>,
    private readonly changed: () => void,
  ) {}

  /** The session on screen and its key; reads when either is new. */
  follow(scope: TaskScope, key: string): void {
    if (this.sessionFile !== scope.sessionFile) {
      this.sessionFile = scope.sessionFile;
      this.view = UNREAD;
      this.key = undefined;
    }
    if (this.key === key) return;
    this.key = key;
    this.read(scope);
  }

  /** Something outside the key changed (the session's work settled): the next follow reads. */
  forget(): void {
    this.key = undefined;
  }

  viewFor(sessionFile: string): TasksView {
    return this.sessionFile === sessionFile ? this.view : UNREAD;
  }

  private read(scope: TaskScope): void {
    this.issued += 1;
    const seq = this.issued;
    const current = (): boolean => seq === this.issued && scope.sessionFile === this.sessionFile;
    this.ask(scope).then(
      (answer) => {
        if (!current()) return;
        const tasks = tasksFrom(answer);
        this.view = tasks === undefined ? { ...this.view, read: "failed" } : { tasks, read: "read", readAt: Date.now() };
        this.changed();
      },
      () => {
        if (!current()) return;
        this.view = { ...this.view, read: "failed" };
        this.changed();
      },
    );
  }
}

/** The tasks in a `tasks.list` answer; undefined when the answer is not one, which is a failed read. */
function tasksFrom(answer: unknown): readonly TaskInput[] | undefined {
  if (!isRecord(answer) || answer["known"] !== true || !Array.isArray(answer["tasks"])) return undefined;
  return answer["tasks"].flatMap((entry: unknown) => {
    if (!isRecord(entry)) return [];
    const { id, name, status, startedAt, durationMs, exitCode } = entry;
    if (typeof id !== "string" || typeof name !== "string" || typeof status !== "string") return [];
    return [{
      id,
      name,
      status,
      ...(typeof startedAt === "string" ? { startedAt } : {}),
      ...(typeof durationMs === "number" ? { durationMs } : {}),
      ...(typeof exitCode === "number" ? { exitCode } : {}),
    }];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** What one task's row knows of its output: the list's read states, and why there is none when the machine said so. */
export interface OutputView {
  readonly read: "reading" | "ready" | "failed";
  readonly text: string;
  readonly totalBytes: number;
  readonly truncated: boolean;
  readonly missing?: "no-session" | "not-owned" | "no-output-file";
}

const OUTPUT_UNREAD: OutputView = { read: "reading", text: "", totalBytes: 0, truncated: false };

/** How often an open running row reads its output again. */
export const OUTPUT_POLL_MS = 2000;

interface OutputEntry {
  view: OutputView;
  inFlight: boolean;
  answeredAt: number | undefined;
  answeredRunning: boolean;
}

/**
 * The output reads of the rows that are open, each under its caller's key (machine, session, task),
 * so no row can show another session's output.
 *
 * A read is asked only when the row is drawn (`refresh`), so nothing is read while the page is off
 * screen. An open running row reads again {@link OUTPUT_POLL_MS} after its last answer; a finished
 * row reads once, and once more if its last answer came while it still ran. A failed read keeps the
 * text it had; a machine's "there is none" replaces it. Closing a row forgets its read.
 */
export class TaskOutputReads {
  private readonly entries = new Map<string, OutputEntry>();

  constructor(private readonly changed: (pollAgainInMs?: number) => void) {}

  view(key: string): OutputView {
    return this.entries.get(key)?.view ?? OUTPUT_UNREAD;
  }

  refresh(key: string, running: boolean, now: number, ask: () => Promise<unknown>): void {
    const entry = this.entries.get(key) ?? { view: OUTPUT_UNREAD, inFlight: false, answeredAt: undefined, answeredRunning: false };
    this.entries.set(key, entry);
    if (entry.inFlight || !outputReadDue(entry, running, now)) return;
    entry.inFlight = true;
    const land = (view: OutputView): void => {
      if (this.entries.get(key) !== entry) return;
      entry.inFlight = false;
      entry.view = view;
      entry.answeredAt = Date.now();
      entry.answeredRunning = running;
      this.changed(running ? OUTPUT_POLL_MS : undefined);
    };
    ask().then(
      (answer) => { land(outputFrom(answer) ?? { ...entry.view, read: "failed" }); },
      () => { land({ ...entry.view, read: "failed" }); },
    );
  }

  forget(key: string): void {
    this.entries.delete(key);
  }
}

function outputReadDue(entry: OutputEntry, running: boolean, now: number): boolean {
  if (entry.answeredAt === undefined) return true;
  if (running) return now - entry.answeredAt >= OUTPUT_POLL_MS;
  return entry.answeredRunning;
}

/** The view a `tasks.output` answer gives; undefined when the answer is not one, which is a failed read. */
export function outputFrom(answer: unknown): OutputView | undefined {
  if (!isRecord(answer)) return undefined;
  const { known, text, totalBytes, truncated, reason } = answer;
  if (known === true && typeof text === "string" && typeof totalBytes === "number" && typeof truncated === "boolean") {
    return { read: "ready", text, totalBytes, truncated };
  }
  if (known === false && (reason === "no-session" || reason === "not-owned" || reason === "no-output-file")) {
    return { read: "failed", text: "", totalBytes: 0, truncated: false, missing: reason };
  }
  return undefined;
}
