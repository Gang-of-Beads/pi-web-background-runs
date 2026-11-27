import { BackgroundTaskHostClient, HostRefusal, type PiEvents } from "./hostClient.js";

/**
 * What PI WEB shows of pi-background-tasks, published by an extension instead of read around one
 * (PI WEB's docs/design/extension-bus.md: the owner of a fact publishes it).
 *
 * The bridge follows the host interface's change feed and publishes, on the channels this package
 * declares under `piWeb.bus`:
 * `background-runs:tasks` (state: the newest tasks, as the Background page draws them), and answers
 * `background-runs:stop` and `background-runs:output` requests through that interface. In the
 * terminal nobody listens, and each publish is one no-op emit.
 *
 * It does not publish the session's "N background runs" state: a task can outlive the session's
 * runtime, where no extension is left to say so, and the plugin's server half counts those from the
 * task records.
 */

export const TASKS_CHANNEL = "background-runs:tasks";
export const STOP_CHANNEL = "background-runs:stop";
export const OUTPUT_CHANNEL = "background-runs:output";

const LISTED = 50;
/** The most output one answer asks the task service for. */
const OUTPUT_BYTES = 8_192;
/** PI WEB's bus takes 64 KiB a value, measured as JSON, where a control byte of coloured output costs six. */
const ANSWER_JSON_BYTES = 60_000;
export const CLOCK_CHANNEL = "background-runs:clock";
export const SESSION_STATES_CHANNEL = "piweb:states:background-runs";

/** An output answer that fits the bus: the oldest output goes first, and the answer says it was cut. */
function fitted<T extends { readonly text: string }>(answer: T): T {
  let text = answer.text;
  while (text !== "" && Buffer.byteLength(JSON.stringify({ ...answer, text })) > ANSWER_JSON_BYTES) text = text.slice(Math.ceil(text.length / 4));
  return text === answer.text ? answer : { ...answer, text, truncated: true };
}

/**
 * The session state for the running tasks that name no process (fusion and managed runs). PI WEB's
 * server half counts running tasks by checking their process, so it cannot count these; while the
 * session's runtime is open the extension says them itself.
 */
export function uncheckedRunsState(views: readonly unknown[]): readonly Record<string, unknown>[] {
  const count = views.filter((view) => isRecord(view) && isRecord(view["task"]) && view["task"]["status"] === "running" && typeof view["task"]["pid"] !== "number").length;
  return count === 0 ? [] : [{ id: "unchecked-runs", label: count === 1 ? "1 managed run" : `${String(count)} managed runs`, tone: "accent", busy: true, count }];
}
const COMMAND_CHARS = 4_096;

/** A task as the page draws it; `durationMs` is measured on this machine when the list was read. */
export interface PublishedTask {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly kind?: string;
  readonly startedAt?: string;
  readonly durationMs?: number;
  readonly exitCode?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The page's view of one task of a `list` answer; undefined for an entry that is not a task. */
export function publishedTask(view: unknown, now: number): PublishedTask | undefined {
  const task = isRecord(view) ? view["task"] : undefined;
  if (!isRecord(view) || !isRecord(task) || typeof task["id"] !== "string" || typeof task["status"] !== "string") return undefined;
  const name = typeof task["name"] === "string" && task["name"] !== "" ? task["name"].slice(0, 80) : typeof task["command"] === "string" ? task["command"].slice(0, 80) : task["id"];
  const startTime = typeof task["startTime"] === "number" ? task["startTime"] : undefined;
  const endTime = typeof task["endTime"] === "number" ? task["endTime"] : undefined;
  return {
    id: task["id"],
    name,
    status: task["status"],
    ...(typeof view["kind"] === "string" ? { kind: view["kind"] } : {}),
    ...(startTime === undefined ? {} : { startedAt: new Date(startTime).toISOString(), durationMs: Math.max(0, (endTime ?? now) - startTime) }),
    ...(typeof task["exitCode"] === "number" ? { exitCode: task["exitCode"] } : {}),
  };
}

interface BusRequest { readonly id: unknown; readonly input: unknown }

function busRequest(data: unknown): BusRequest | undefined {
  return isRecord(data) ? { id: data["id"], input: data["input"] } : undefined;
}

function tailBytesOf(input: unknown): number {
  const bytes = isRecord(input) ? input["tailBytes"] : undefined;
  return typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 1 ? Math.min(Math.floor(bytes), OUTPUT_BYTES) : OUTPUT_BYTES;
}

function taskIdOf(input: unknown): string | undefined {
  const id = isRecord(input) ? input["id"] : undefined;
  return typeof id === "string" && id !== "" ? id : undefined;
}

export interface WebBridge {
  /** Read the tasks and publish them now. */
  refresh(): void;
  stop(): void;
}

export function startWebBridge(events: PiEvents, now: () => number = Date.now): WebBridge {
  const host = new BackgroundTaskHostClient(events, "pi-web-background-runs");
  let reading = false;
  let again = false;
  let stopped = false;

  const publish = async (): Promise<void> => {
    if (stopped) return;
    if (reading) { again = true; return; }
    reading = true;
    try {
      const listed = await host.list(LISTED);
      const views = isRecord(listed) && Array.isArray(listed["tasks"]) ? listed["tasks"] : [];
      const at = now();
      const tasks = views.flatMap((view: unknown) => { const task = publishedTask(view, at); return task === undefined ? [] : [task]; });
      if (stopped) return;
      events.emit(SESSION_STATES_CHANNEL, uncheckedRunsState(views));
      events.emit(TASKS_CHANNEL, { tasks, more: isRecord(listed) && typeof listed["nextCursor"] === "string" });
    } catch {
      // No answer is not "no tasks": what was published stays, and the next change reads again.
    } finally {
      reading = false;
      if (again) { again = false; void publish(); }
    }
  };

  const answer = (channel: string, handle: (taskId: string, input: unknown) => Promise<unknown>): (() => void) => events.on(`${channel}:request`, (data) => {
    const request = busRequest(data);
    if (request === undefined) return;
    const taskId = taskIdOf(request.input);
    const reply = (body: Record<string, unknown>): void => { events.emit(`${channel}:response`, { id: request.id, ...body }); };
    if (taskId === undefined) { reply({ error: "A task id is needed." }); return; }
    handle(taskId, request.input).then((result) => { reply({ result }); }, (error: unknown) => { reply({ error: error instanceof HostRefusal ? `${error.code}: ${error.message}` : "The background task service failed." }); });
  });

  const unsubscribes = [
    host.onChanged((kind) => { if (kind !== "closed") void publish(); }),
    answer(STOP_CHANNEL, async (taskId) => { await host.stop(taskId); void publish(); return { stopped: true }; }),
    answer(OUTPUT_CHANNEL, async (taskId, input) => {
      const logs = await host.logs(taskId, tailBytesOf(input));
      const task = isRecord(logs) && isRecord(logs["task"]) ? logs["task"] : {};
      const command = typeof task["command"] === "string" ? task["command"] : "";
      return fitted({
        text: isRecord(logs) && typeof logs["text"] === "string" ? logs["text"] : "",
        totalBytes: isRecord(logs) && typeof logs["totalBytes"] === "number" ? logs["totalBytes"] : 0,
        truncated: isRecord(logs) && logs["truncated"] === true,
        command: command.slice(0, COMMAND_CHARS),
        commandCut: command.length > COMMAND_CHARS,
      });
    }),
    /** The machine's clock, so a page on another device counts a running task's time on it. */
    events.on(`${CLOCK_CHANNEL}:request`, (data) => {
      const request = busRequest(data);
      if (request !== undefined) events.emit(`${CLOCK_CHANNEL}:response`, { id: request.id, result: { now: now() } });
    }),
  ];

  return {
    refresh: () => { void publish(); },
    stop: () => { stopped = true; for (const unsubscribe of unsubscribes) unsubscribe(); },
  };
}
