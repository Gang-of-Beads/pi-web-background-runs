import { open, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

/**
 * Background-task runs, read from the registry the task tool leaves on disk.
 *
 * The tool is a pi extension that runs a shell command outside the turn that
 * started it, and it reports progress to the terminal UI only. In a browser
 * the work was therefore invisible: a deploy could run for ten minutes with
 * nothing on screen, which is exactly when someone wants to look.
 *
 * Attribution is the interesting part. The tool names its directory
 *
 *   <cwd>/.pi/tasks/<sessionId ?? "session-<pid>">-<pid>/<taskId>.json
 *
 * and older versions of the tool never supplied that sessionId, so the name
 * collapsed to the pid of the *server* process. One PI WEB server hosts every
 * session, so all sessions shared one directory and the records carry no
 * session field. Reading that directory alone would show every session the
 * same list.
 *
 * So the directory supplies the state and the transcript supplies the
 * ownership: a task belongs to the session whose transcript mentions its
 * output path, which the tool writes into its own result when the task starts.
 * That is exact, survives a restart, and needs no cooperation from the tool.
 * Newer versions of the tool do name the directory after the session, and a
 * task started from its slash command leaves no output path in the transcript,
 * so a directory named after the session proves ownership too.
 *
 * But the transcript's proof is perishable: compaction rewrites the session
 * file and the Output lines are exactly what it deletes, so a task that ran
 * longer than one compaction cycle lost its owner and vanished from every
 * list. Ownership that was observed is therefore recorded, once, in a durable
 * per-workspace file beside the registry, and later lists attribute from the
 * record. First writer wins: a session that merely quotes another session's
 * output path must not be able to claim its task.
 */

/** The extension's registry directory, relative to the session's working directory. */
const TASKS_SUBDIR = ".pi/tasks";

/** One background task, as the panel lists it. */
export interface BackgroundTaskInfo {
  readonly id: string;
  readonly name: string;
  readonly command: string;
  /**
   * The tool's own status, except that a running record whose process is gone or was replaced reads
   * "lost", and one whose process could not be checked, or that names no process, reads "unknown".
   */
  readonly status: string;
  readonly startedAt?: string | undefined;
  readonly endedAt?: string | undefined;
  /** Wall-clock milliseconds: final when finished, elapsed while running. */
  readonly durationMs?: number | undefined;
  readonly exitCode?: number | undefined;
  readonly bytesWritten: number;
  readonly hasOutput: boolean;
}

/**
 * How many of a session's tasks are still running: the running ids in the workspace's registry
 * that the session's transcript started. With none running anywhere, no transcript is read.
 */
export async function runningTasksForSession(cwd: string, transcriptPath: string, probeProcessStart: ProbeProcessStart): Promise<number> {
  const running = await runningTaskIds(cwd, probeProcessStart);
  if (running.size === 0) return 0;
  const owned = await ownedTaskIds(cwd, transcriptPath);
  return [...running].filter((id) => owned.has(id)).length;
}

interface StoredTask {
  id?: unknown;
  name?: unknown;
  command?: unknown;
  status?: unknown;
  outputPath?: unknown;
  startTime?: unknown;
  endTime?: unknown;
  exitCode?: unknown;
  pid?: unknown;
  bytesWritten?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** How far a process's start may sit from the task's own start and still be the task's process. */
const PID_REUSE_TOLERANCE_MS = 60_000;

/**
 * Runs `ps` with these arguments and environment overrides: the host's bounded command helper, so
 * the plugin spawns nothing itself.
 */
export type RunPs = (
  args: readonly string[],
  env: Readonly<Record<string, string>>,
) => Promise<{ readonly exitCode: number | null; readonly stdout: string }>;

/**
 * What `ps` said about a pid: the process was born at a time, there is no such process, or there
 * was no answer to read. The last is not the second: a probe that could not tell is no evidence
 * that the process died.
 */
export type ProcessStart =
  | { readonly kind: "born"; readonly atMs: number }
  | { readonly kind: "gone" }
  | { readonly kind: "unreadable" };

export type ProbeProcessStart = (pid: number) => Promise<ProcessStart>;

/**
 * How long a process has run, as `ps -o etime=` prints it: `[[dd-]hh:]mm:ss`, digits on procps
 * (Linux, Termux) and BSD `ps` (macOS) alike, under every locale.
 *
 * The start time used to be read from `lstart`, which needs the machine's boot time. Android does not
 * let an app read `/proc/stat`, so Termux's procps counted from 1970 and printed every process as born
 * in January 1970: every task still running on a phone read as ended with no exit code, and the
 * Background count left it out (2026-10-29). Elapsed time needs no boot time.
 */
const ELAPSED = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/u;

function elapsedSeconds(text: string): number | undefined {
  const match = ELAPSED.exec(text);
  if (match === null) return undefined;
  const [, days = "0", hours = "0", minutes = "0", seconds = "0"] = match;
  return ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds);
}

/**
 * One `ps` answer, classified. A non-zero exit is how `ps -p` says the pid has no process; no exit
 * code (killed, timed out) or an exit 0 whose elapsed time does not parse answered nothing.
 */
export function classifyPsStart(exitCode: number | null, stdout: string, nowMs: number): ProcessStart {
  if (exitCode === null) return { kind: "unreadable" };
  if (exitCode !== 0) return { kind: "gone" };
  const seconds = elapsedSeconds(stdout.trim());
  return seconds === undefined ? { kind: "unreadable" } : { kind: "born", atMs: nowMs - seconds * 1000 };
}

/**
 * When the process behind a pid was born, asked of `ps`. A `ps` that cannot run at all (none on
 * Windows, an aborted read) answered nothing, so it is unreadable rather than gone.
 *
 * A task killed by a machine restart keeps `status: "running"` in its file forever, because nothing
 * runs to correct it. Reporting that as running would show a spinner for a task that died days ago,
 * so a running record is only believed while its process exists.
 */
export function processStartProbe(runPs: RunPs, now: () => number = Date.now): ProbeProcessStart {
  return async (pid) => {
    try {
      const { exitCode, stdout } = await runPs(["-p", String(pid), "-o", "etime="], {});
      return classifyPsStart(exitCode, stdout, now());
    } catch {
      return { kind: "unreadable" };
    }
  };
}

/** What a record that says "running" is shown as, once its process has been asked about. */
export type RunningRecordStatus = "running" | "lost" | "unknown";

/**
 * Whether a running record's pid still belongs to the task's own process.
 *
 * Operating systems recycle pids within days: measured live, a web server
 * task that died on August 24 still reported running on August 29 because pid
 * 69946 had been handed to /usr/libexec/microstackshot. A process's start
 * time is its identity: the task's own process started when the task started
 * (exec does not reset it), so a start time more than a minute later belongs
 * to whoever inherited the number. A pid with no process is lost; a probe
 * that could not read the start time proves neither, and stays unknown.
 */
export function runningRecordStatus(start: ProcessStart, startedAtMs: number | undefined): RunningRecordStatus {
  switch (start.kind) {
    case "gone":
      return "lost";
    case "unreadable":
      return "unknown";
    case "born":
      if (startedAtMs === undefined) return "running";
      return Math.abs(start.atMs - startedAtMs) <= PID_REUSE_TOLERANCE_MS ? "running" : "lost";
  }
}

/**
 * A running record's status. One with no pid names no process to check, so whether it still runs is
 * unknown: pi-background-tasks' managed (fusion) runs carry no pid for their whole life.
 */
async function probedRunningStatus(task: StoredTask, probeProcessStart: ProbeProcessStart): Promise<RunningRecordStatus> {
  const pid = asNumber(task.pid);
  if (pid === undefined) return "unknown";
  return runningRecordStatus(await probeProcessStart(pid), asNumber(task.startTime));
}

/**
 * Task ids this session started, taken from the output paths in its transcript.
 *
 * The transcript is read incrementally. Its callers run on every recount of a
 * session's background work and every read of its task list, and reading a
 * long-lived session's file in full each time -
 * hundreds of megabytes, regex-swept, per session, every few seconds - was
 * the event-loop stall behind "pi web is always stuck": 67k calls averaging
 * 2.4s each, with everything else queued behind them. A transcript only
 * grows, and bytes already scanned cannot produce new ids, so a watermark
 * per transcript remembers how far the scan got and only the growth is read,
 * with a small overlap so a line torn across the boundary is still seen. A
 * file that shrank was replaced, and is rescanned from the start.
 *
 * The tool reports "Output: .pi/tasks/<dir>/<id>.output" when a task starts, and that line is what
 * lands in the transcript, so the ids are read from it.
 */
export async function taskIdsForSession(transcriptPath: string): Promise<Set<string>> {
  let size: number;
  try {
    size = (await stat(transcriptPath)).size;
  } catch {
    return new Set();
  }
  const state = transcriptScans.get(transcriptPath);
  if (state?.scannedBytes === size) return new Set(state.ids);
  const fromScratch = state === undefined || size < state.scannedBytes;
  const start = fromScratch ? 0 : Math.max(0, state.scannedBytes - SCAN_OVERLAP_BYTES);
  let text: string;
  try {
    text = await readTranscriptSlice(transcriptPath, start, size);
  } catch {
    return new Set(state === undefined ? [] : state.ids);
  }
  const ids = fromScratch ? new Set<string>() : state.ids;
  const pattern = /\.pi[/\\]tasks[/\\][^"'\s]+?[/\\]([A-Za-z0-9_-]+)\.output/g;
  for (const match of text.matchAll(pattern)) {
    const id = match[1];
    if (id !== undefined) ids.add(id);
  }
  if (transcriptScans.size >= SCAN_CACHE_LIMIT && !transcriptScans.has(transcriptPath)) transcriptScans.clear();
  transcriptScans.set(transcriptPath, { scannedBytes: size, ids });
  return new Set(ids);
}

interface TranscriptScanState {
  scannedBytes: number;
  ids: Set<string>;
}

const transcriptScans = new Map<string, TranscriptScanState>();
/** Enough to re-see a task line torn across the previous scan's end. */
const SCAN_OVERLAP_BYTES = 4096;
/** A bound on cached transcripts; overflow rescans once rather than growing forever. */
const SCAN_CACHE_LIMIT = 500;

/** Tests reset the watermark cache so each fixture starts unseen. */
export function resetTranscriptScanCache(): void {
  transcriptScans.clear();
}

async function readTranscriptSlice(path: string, start: number, end: number): Promise<string> {
  if (end <= start) return "";
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(end - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Ownership that was proven once, kept forever: taskId → transcript file name.
 *
 * The file lives beside the registry it describes, which is gitignored runtime
 * state ({@link TASKS_SUBDIR} is already ignored), and is keyed by the
 * transcript's base name — the one identity this reader is handed. A missing
 * or unreadable file means nothing was recorded yet, not an error: the
 * transcript scan still works, and the next sighting re-records.
 */
function attributionPath(cwd: string): string {
  return join(cwd, TASKS_SUBDIR, "attribution.json");
}

async function readAttributions(cwd: string): Promise<Map<string, string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(attributionPath(cwd), "utf8"));
    const attributions = new Map<string, string>();
    if (typeof parsed !== "object" || parsed === null) return attributions;
    for (const [id, owner] of Object.entries(parsed)) {
      const ownerFile = asString(owner);
      if (id !== "" && ownerFile !== undefined) attributions.set(id, ownerFile);
    }
    return attributions;
  } catch {
    return new Map();
  }
}

/**
 * Atomic replace, so a read landing mid-write cannot hand back a torn file. A failed write costs only
 * durability until the next sighting records again; it never fails the read that keeps it.
 */
async function writeAttributions(cwd: string, attributions: Map<string, string>): Promise<void> {
  const path = attributionPath(cwd);
  const staged = `${path}.${String(process.pid)}.tmp`;
  try {
    await writeFile(staged, JSON.stringify(Object.fromEntries(attributions), null, 2));
    await rename(staged, path);
  } catch {
    return;
  }
}

/**
 * Parsed registry files, reused while their stat is unchanged. The registry
 * accumulates hundreds of records, almost all of them finished tasks whose
 * files will never change again; re-reading and re-parsing every one of them
 * on every poll was the cost that remained after the transcript watermark.
 * An unchanged size and mtime answers from the cache; anything else re-reads.
 */
interface CachedTaskRecord {
  sizeBytes: number;
  mtimeMs: number;
  task: StoredTask;
}

const taskRecordCache = new Map<string, CachedTaskRecord>();
const TASK_RECORD_CACHE_LIMIT = 5000;

/** Tests reset the cache so each fixture starts unseen. */
export function resetTaskRecordCache(): void {
  taskRecordCache.clear();
}

/**
 * One registry file, parsed. A file torn mid-write, or whose writer crashed before it was parsed, is
 * held as an empty record and not cached, so the next read sees it once the writer finishes. Every
 * consumer reads fields through asString/asNumber, so an empty record is safe: it claims no running
 * process and lists as status "unknown" under the identity anyone can prove, the file name. Dropping
 * it instead answered "this session never started anything" for a task the reader had started.
 */
async function readTaskRecordFile(full: string): Promise<StoredTask | undefined> {
  let sizeBytes: number;
  let mtimeMs: number;
  try {
    const info = await stat(full);
    sizeBytes = info.size;
    mtimeMs = info.mtimeMs;
  } catch {
    return undefined;
  }
  const cached = taskRecordCache.get(full);
  if (cached?.sizeBytes === sizeBytes && cached.mtimeMs === mtimeMs) return cached.task;
  let task: StoredTask;
  try {
    const parsed: unknown = JSON.parse(await readFile(full, "utf8"));
    task = typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
  if (taskRecordCache.size >= TASK_RECORD_CACHE_LIMIT && !taskRecordCache.has(full)) taskRecordCache.clear();
  taskRecordCache.set(full, { sizeBytes, mtimeMs, task });
  return task;
}

/** Every task record under a workspace, regardless of which session started it. */
export async function readTaskRecords(cwd: string): Promise<Map<string, { task: StoredTask; file: string }>> {
  const root = join(cwd, TASKS_SUBDIR);
  const records = new Map<string, { task: StoredTask; file: string }>();
  let dirs: string[];
  try {
    dirs = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return records;
  }
  for (const dir of dirs) {
    let files: string[];
    try {
      files = (await readdir(join(root, dir))).filter((name) => name.endsWith(".json"));
    } catch {
      continue;
    }
    for (const file of files) {
      const full = join(root, dir, file);
      const task = await readTaskRecordFile(full);
      if (task === undefined) continue;
      const id = asString(task.id) ?? basename(file, ".json");
      records.set(id, { task, file: full });
    }
  }
  return records;
}

/**
 * Ids of task records under this workspace whose process is running right now,
 * regardless of which session started them.
 *
 * Deliberately cheap: the registry files are small, and the answer is almost
 * always the empty set. Only a non-empty answer justifies reading a transcript
 * to find out which session owns the task, which is the expensive half of
 * {@link listBackgroundTasks} and far too costly to repeat on a timer.
 */
export async function runningTaskIds(
  cwd: string,
  probeProcessStart: ProbeProcessStart,
): Promise<Set<string>> {
  const running = new Set<string>();
  for (const [id, record] of await readTaskRecords(cwd)) {
    if (asString(record.task.status) !== "running") continue;
    if (await probedRunningStatus(record.task, probeProcessStart) !== "running") continue;
    running.add(id);
  }
  return running;
}

/**
 * The task ids a session owns. What its transcript proves is recorded first, then ownership
 * is read from the record. The key is the transcript's base name, the one session identity this
 * reader is handed; first writer wins, so a session that quotes another's output path cannot
 * claim a task it did not start, and the record outvotes a quoted mention.
 */
async function ownedTaskIds(cwd: string, transcriptPath: string): Promise<Set<string>> {
  const ids = new Set([...await taskIdsForSession(transcriptPath), ...await taskIdsInSessionDirectory(cwd, transcriptSessionId(transcriptPath))]);
  const session = basename(transcriptPath);
  const attributions = await readAttributions(cwd);
  let recorded = false;
  for (const id of ids) {
    if (!attributions.has(id)) {
      attributions.set(id, session);
      recorded = true;
    }
  }
  if (recorded) await writeAttributions(cwd, attributions);
  const owned = new Set(ids);
  for (const [id, owner] of attributions) {
    if (owner === session) owned.add(id);
    else owned.delete(id);
  }
  return owned;
}

/** The session id a pi transcript is named after: `<timestamp>_<sessionId>.jsonl`. */
function transcriptSessionId(transcriptPath: string): string | undefined {
  return /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/u.exec(basename(transcriptPath))?.[1];
}

/** Task ids whose registry directory the tool named after this session (`<sessionId>-<pid>`). */
async function taskIdsInSessionDirectory(cwd: string, sessionId: string | undefined): Promise<Set<string>> {
  const ids = new Set<string>();
  if (sessionId === undefined) return ids;
  for (const [id, record] of await readTaskRecords(cwd)) {
    if (basename(dirname(record.file)).startsWith(`${sessionId}-`)) ids.add(id);
  }
  return ids;
}

/** The most a read of a task's output answers: the panel's Whole log (design-b3s3-v2 §4.4). */
export const OUTPUT_READ_LIMIT_BYTES = 1024 * 1024;

export type TaskOutputRead =
  | { readonly known: true; readonly text: string; readonly totalBytes: number; readonly truncated: boolean; readonly command: string }
  | { readonly known: false; readonly reason: "not-owned" }
  | { readonly known: false; readonly reason: "no-output-file"; readonly command: string };

/**
 * The end of one task's output file, and the command the task runs ("" when its record names none),
 * for its row in the panel.
 *
 * Only a task this session owns is read (the ownership `listBackgroundTasks` uses), and only a file
 * under the workspace's registry directory: the path comes from a record on disk, and a record that
 * points elsewhere must not turn this operation into a reader of any file the daemon can open. A cut
 * text starts after the first newline in the tail, so the first line shown is not half a line; a tail
 * with no newline (one long line) is shown from the cut point.
 */
export async function readTaskOutput(cwd: string, transcriptPath: string, taskId: string, tailBytes: number): Promise<TaskOutputRead> {
  if (!(await ownedTaskIds(cwd, transcriptPath)).has(taskId)) return { known: false, reason: "not-owned" };
  const task = (await readTaskRecords(cwd)).get(taskId)?.task;
  const outputPath = asString(task?.outputPath);
  const registry = resolve(cwd, TASKS_SUBDIR) + sep;
  const file = outputPath === undefined ? undefined : resolve(cwd, outputPath);
  if (file?.startsWith(registry) !== true) return { known: false, reason: "no-output-file", command: asString(task?.command) ?? "" };
  const handle = await open(file, "r").catch(() => undefined);
  if (handle === undefined) return { known: false, reason: "no-output-file", command: asString(task?.command) ?? "" };
  try {
    const totalBytes = (await handle.stat()).size;
    const limit = Math.min(Math.max(1, Math.floor(tailBytes)), OUTPUT_READ_LIMIT_BYTES);
    const start = Math.max(0, totalBytes - limit);
    const buffer = Buffer.alloc(totalBytes - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const read = buffer.subarray(0, bytesRead);
    const lineStart = start === 0 ? 0 : read.indexOf(0x0a) + 1;
    return { known: true, text: read.toString("utf8", lineStart), totalBytes, truncated: start > 0 || lineStart > 0, command: asString(task?.command) ?? "" };
  } finally {
    await handle.close();
  }
}

/**
 * A session's tasks, newest first, the one someone opened the panel to check being the recent one.
 *
 * A "running" record whose process is gone died without being able to record it (a restart, an
 * OOM kill) and is reported as lost rather than spinning forever; one whose process could not be
 * checked, or that names none, is reported as unknown, neither running nor lost. Only a running record is probed:
 * spawning `ps` for every finished task ever recorded, on every read, was a process storm for
 * answers that cannot change.
 */
export async function listBackgroundTasks(
  cwd: string,
  transcriptPath: string,
  now: number,
  probeProcessStart: ProbeProcessStart,
): Promise<BackgroundTaskInfo[]> {
  const [owned, records] = await Promise.all([ownedTaskIds(cwd, transcriptPath), readTaskRecords(cwd)]);
  const tasks: BackgroundTaskInfo[] = [];
  for (const id of owned) {
    const record = records.get(id);
    if (record === undefined) continue;
    const { task } = record;
    const rawStatus = asString(task.status) ?? "unknown";
    const startedAt = asNumber(task.startTime);
    const endedAt = asNumber(task.endTime);
    const status = rawStatus === "running" ? await probedRunningStatus(task, probeProcessStart) : rawStatus;
    tasks.push({
      id,
      name: asString(task.name) ?? id,
      command: asString(task.command) ?? "",
      status,
      startedAt: startedAt === undefined ? undefined : new Date(startedAt).toISOString(),
      endedAt: endedAt === undefined ? undefined : new Date(endedAt).toISOString(),
      durationMs: startedAt === undefined ? undefined : (endedAt ?? now) - startedAt,
      exitCode: asNumber(task.exitCode),
      bytesWritten: asNumber(task.bytesWritten) ?? 0,
      hasOutput: asString(task.outputPath) !== undefined,
    });
  }
  tasks.sort((left, right) => (right.startedAt ?? "").localeCompare(left.startedAt ?? ""));
  return tasks;
}
