import { BackgroundTaskHostClient, HostRefusal, type PiEvents } from "./hostClient.js";

/**
 * What PI WEB shows of pi-background-tasks, published by an extension instead of read around one
 * (PI WEB's docs/design/extension-bus.md: the owner of a fact publishes it).
 *
 * The bridge follows the host interface's change feed and publishes, on the channels this package
 * declares under `piWeb.bus`:
 * - `background-runs:tasks`, state: the newest tasks, as the Background page draws them;
 * - `piweb:states:background-runs`, state: "N background runs" while any runs, which is what keeps
 *   the session reading busy in the lists;
 * and answers `background-runs:stop`, `background-runs:output` requests through that interface.
 * In the terminal nobody listens, and each publish is one no-op emit.
 */

export const TASKS_CHANNEL = "background-runs:tasks";
export const SESSION_STATES_CHANNEL = "piweb:states:background-runs";
export const STOP_CHANNEL = "background-runs:stop";
export const OUTPUT_CHANNEL = "background-runs:output";

const LISTED = 50;
const OUTPUT_BYTES = 32_768;
const COMMAND_CHARS = 2_000;

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
  const name = typeof task["name"] === "string" && task["name"] !== "" ? task["name"] : typeof task["command"] === "string" ? task["command"].slice(0, 80) : task["id"];
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

/** The session state PI WEB reads: busy while tasks run, nothing otherwise. */
export function runningState(running: number): unknown[] {
  if (running === 0) return [];
  return [{ id: "runs", label: `${String(running)} background ${running === 1 ? "run" : "runs"}`, tone: "accent", busy: true, count: running }];
}

interface BusRequest { readonly id: unknown; readonly input: unknown }

function busRequest(data: unknown): BusRequest | undefined {
  return isRecord(data) ? { id: data["id"], input: data["input"] } : undefined;
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

  const publish = async (): Promise<void> => {
    if (reading) { again = true; return; }
    reading = true;
    try {
      const listed = await host.list(LISTED);
      const views = isRecord(listed) && Array.isArray(listed["tasks"]) ? listed["tasks"] : [];
      const at = now();
      const tasks = views.flatMap((view: unknown) => { const task = publishedTask(view, at); return task === undefined ? [] : [task]; });
      events.emit(TASKS_CHANNEL, { tasks, more: isRecord(listed) && typeof listed["nextCursor"] === "string" });
      events.emit(SESSION_STATES_CHANNEL, runningState(tasks.filter((task) => task.status === "running").length));
    } catch {
      // No answer is not "no tasks": what was published stays, and the next change reads again.
    } finally {
      reading = false;
      if (again) { again = false; void publish(); }
    }
  };

  const answer = (channel: string, handle: (taskId: string) => Promise<unknown>): (() => void) => events.on(`${channel}:request`, (data) => {
    const request = busRequest(data);
    if (request === undefined) return;
    const taskId = taskIdOf(request.input);
    const reply = (body: Record<string, unknown>): void => { events.emit(`${channel}:response`, { id: request.id, ...body }); };
    if (taskId === undefined) { reply({ error: "A task id is needed." }); return; }
    handle(taskId).then((result) => { reply({ result }); }, (error: unknown) => { reply({ error: error instanceof HostRefusal ? `${error.code}: ${error.message}` : "The background task service failed." }); });
  });

  const unsubscribes = [
    host.onChanged((kind) => { if (kind !== "closed") void publish(); }),
    answer(STOP_CHANNEL, async (taskId) => { await host.stop(taskId); void publish(); return { stopped: true }; }),
    answer(OUTPUT_CHANNEL, async (taskId) => {
      const logs = await host.logs(taskId, OUTPUT_BYTES);
      const task = isRecord(logs) && isRecord(logs["task"]) ? logs["task"] : {};
      const command = typeof task["command"] === "string" ? task["command"] : "";
      return {
        text: isRecord(logs) && typeof logs["text"] === "string" ? logs["text"] : "",
        totalBytes: isRecord(logs) && typeof logs["totalBytes"] === "number" ? logs["totalBytes"] : 0,
        truncated: isRecord(logs) && logs["truncated"] === true,
        command: command.slice(0, COMMAND_CHARS),
        commandCut: command.length > COMMAND_CHARS,
      };
    }),
  ];

  return {
    refresh: () => { void publish(); },
    stop: () => { for (const unsubscribe of unsubscribes) unsubscribe(); },
  };
}
