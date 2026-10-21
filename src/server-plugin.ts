import type { JsonValue, PiWebServerPlugin, ServerPluginActivationContext } from "@gang-of-beads/pi-web-plugin-api/server-plugin-api";
import { isAbsolute } from "node:path";
import { listBackgroundTasks, OUTPUT_READ_LIMIT_BYTES, processStartProbe, readTaskOutput, runningTasksForSession, type BackgroundTaskInfo, type ProbeProcessStart, type TaskOutputRead } from "./server/tasks.js";

/**
 * Background runs' server half: everything PI WEB knows about pi-background-tasks (`bg_run`)
 * lives here, not in core (design plugin-lifecycle-and-subagents section 3).
 *
 * The extension keeps a registry and each task's output under the project folder
 * (`.pi/tasks`, `.pi/delegate`). The plugin declares those directories, so while it runs the
 * daemon watches them to recount and the Files and Git panels ignore their churn; it counts a
 * session's running tasks into "N background runs"; it lists a session's tasks for its
 * panel; and it reads the end of one of those tasks' output for the row that opens. Turned off, none of that happens (owner, 2026-10-09: this is the plugin's behaviour).
 *
 * The session is named by its working directory and transcript path, which the browser holds.
 */

function sessionFrom(input: unknown): { cwd: string; sessionFile: string } | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const cwd: unknown = Reflect.get(input, "cwd");
  const sessionFile: unknown = Reflect.get(input, "sessionFile");
  if (typeof cwd !== "string" || !isAbsolute(cwd)) return undefined;
  if (typeof sessionFile !== "string" || !isAbsolute(sessionFile) || !sessionFile.endsWith(".jsonl")) return undefined;
  return { cwd, sessionFile };
}

/** The task a `tasks.output` read names, by the id the tool gives it; anything else names no task. */
function taskIdFrom(input: unknown): string | undefined {
  const taskId: unknown = typeof input === "object" && input !== null ? Reflect.get(input, "taskId") : undefined;
  return typeof taskId === "string" && /^[A-Za-z0-9_-]+$/.test(taskId) ? taskId : undefined;
}

function tailBytesFrom(input: unknown): number {
  const tailBytes: unknown = typeof input === "object" && input !== null ? Reflect.get(input, "tailBytes") : undefined;
  return typeof tailBytes === "number" && Number.isFinite(tailBytes) && tailBytes > 0 ? tailBytes : OUTPUT_READ_LIMIT_BYTES;
}

/** The longest command an open row shows, in characters (code points); an open running row reads every two seconds. */
const COMMAND_SHOWN_CHARS = 4096;

/** A task's command for its open row, cut on a character boundary; a cut one says so rather than carrying a mark in the text. */
function commandAsJson(command: string): { command?: string; commandCut?: true } {
  if (command === "") return {};
  if (command.length <= COMMAND_SHOWN_CHARS) return { command };
  const characters = Array.from(command);
  return characters.length <= COMMAND_SHOWN_CHARS ? { command } : { command: characters.slice(0, COMMAND_SHOWN_CHARS).join(""), commandCut: true };
}

/** What the panel draws of each task, and nothing more: a command line can be long, so it rides the open row's output read. */
function tasksAsJson(tasks: readonly BackgroundTaskInfo[]): JsonValue {
  return tasks.map((task) => ({
    id: task.id,
    name: task.name,
    status: task.status,
    ...(task.startedAt === undefined ? {} : { startedAt: task.startedAt }),
    ...(task.durationMs === undefined ? {} : { durationMs: task.durationMs }),
    ...(task.exitCode === undefined ? {} : { exitCode: task.exitCode }),
  }));
}

function outputAsJson(read: TaskOutputRead): JsonValue {
  if (!read.known) return read.reason === "no-output-file" ? { known: false, reason: read.reason, ...commandAsJson(read.command) } : { known: false, reason: read.reason };
  return { known: true, text: read.text, totalBytes: read.totalBytes, truncated: read.truncated, ...commandAsJson(read.command) };
}

/** When a pid's process was born, read with `ps` through the host's bounded command helper. */
function probeWith(context: ServerPluginActivationContext, signal: AbortSignal): ProbeProcessStart {
  return processStartProbe((args, env) => context.execFile({ file: "ps", args, env, signal }));
}

const plugin: PiWebServerPlugin = {
  apiVersion: 1,
  name: "Background Runs",
  activate: (context) => ({
    agentFacts: {
      workPaths: [{ root: "cwd", path: ".pi/tasks" }, { root: "cwd", path: ".pi/delegate" }],
    },
    backgroundWork: async (session, signal) => ({ running: await runningTasksForSession(session.cwd, session.sessionFile, probeWith(context, signal)) }),
    operations: {
      "tasks.list": async (input, { signal }): Promise<JsonValue> => {
        const session = sessionFrom(input);
        if (session === undefined) return { known: false, reason: "no-session" };
        return { known: true, tasks: tasksAsJson(await listBackgroundTasks(session.cwd, session.sessionFile, Date.now(), probeWith(context, signal))) };
      },
      "tasks.output": async (input): Promise<JsonValue> => {
        const session = sessionFrom(input);
        if (session === undefined) return { known: false, reason: "no-session" };
        const taskId = taskIdFrom(input);
        if (taskId === undefined) return { known: false, reason: "not-owned" };
        return outputAsJson(await readTaskOutput(session.cwd, session.sessionFile, taskId, tailBytesFrom(input)));
      },
    },
  }),
};

export default plugin;
