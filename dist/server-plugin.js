// src/server-plugin.ts
import { isAbsolute } from "node:path";

// src/server/tasks.ts
import { open, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
var TASKS_SUBDIR = ".pi/tasks";
async function runningTasksForSession(cwd, transcriptPath, probeProcessStart) {
  const running = await runningTaskIds(cwd, probeProcessStart);
  if (running.size === 0) return 0;
  const owned = await ownedTaskIds(cwd, transcriptPath);
  return [...running].filter((id) => owned.has(id)).length;
}
function asString(value) {
  return typeof value === "string" && value !== "" ? value : void 0;
}
function asNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
var PID_REUSE_TOLERANCE_MS = 6e4;
var PS_ENV = { LC_ALL: "C" };
function classifyPsStart(exitCode, stdout) {
  if (exitCode === null) return { kind: "unreadable" };
  if (exitCode !== 0) return { kind: "gone" };
  const atMs = new Date(stdout.trim()).getTime();
  return Number.isFinite(atMs) ? { kind: "born", atMs } : { kind: "unreadable" };
}
function processStartProbe(runPs) {
  return async (pid) => {
    try {
      const { exitCode, stdout } = await runPs(["-p", String(pid), "-o", "lstart="], PS_ENV);
      return classifyPsStart(exitCode, stdout);
    } catch {
      return { kind: "unreadable" };
    }
  };
}
function runningRecordStatus(start, startedAtMs) {
  switch (start.kind) {
    case "gone":
      return "lost";
    case "unreadable":
      return "unknown";
    case "born":
      if (startedAtMs === void 0) return "running";
      return Math.abs(start.atMs - startedAtMs) <= PID_REUSE_TOLERANCE_MS ? "running" : "lost";
  }
}
async function probedRunningStatus(task, probeProcessStart) {
  const pid = asNumber(task.pid);
  if (pid === void 0) return "unknown";
  return runningRecordStatus(await probeProcessStart(pid), asNumber(task.startTime));
}
async function taskIdsForSession(transcriptPath) {
  let size;
  try {
    size = (await stat(transcriptPath)).size;
  } catch {
    return /* @__PURE__ */ new Set();
  }
  const state = transcriptScans.get(transcriptPath);
  if (state?.scannedBytes === size) return new Set(state.ids);
  const fromScratch = state === void 0 || size < state.scannedBytes;
  const start = fromScratch ? 0 : Math.max(0, state.scannedBytes - SCAN_OVERLAP_BYTES);
  let text;
  try {
    text = await readTranscriptSlice(transcriptPath, start, size);
  } catch {
    return new Set(state === void 0 ? [] : state.ids);
  }
  const ids = fromScratch ? /* @__PURE__ */ new Set() : state.ids;
  const pattern = /\.pi[/\\]tasks[/\\][^"'\s]+?[/\\]([A-Za-z0-9_-]+)\.output/g;
  for (const match of text.matchAll(pattern)) {
    const id = match[1];
    if (id !== void 0) ids.add(id);
  }
  if (transcriptScans.size >= SCAN_CACHE_LIMIT && !transcriptScans.has(transcriptPath)) transcriptScans.clear();
  transcriptScans.set(transcriptPath, { scannedBytes: size, ids });
  return new Set(ids);
}
var transcriptScans = /* @__PURE__ */ new Map();
var SCAN_OVERLAP_BYTES = 4096;
var SCAN_CACHE_LIMIT = 500;
async function readTranscriptSlice(path, start, end) {
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
function attributionPath(cwd) {
  return join(cwd, TASKS_SUBDIR, "attribution.json");
}
async function readAttributions(cwd) {
  try {
    const parsed = JSON.parse(await readFile(attributionPath(cwd), "utf8"));
    const attributions = /* @__PURE__ */ new Map();
    if (typeof parsed !== "object" || parsed === null) return attributions;
    for (const [id, owner] of Object.entries(parsed)) {
      const ownerFile = asString(owner);
      if (id !== "" && ownerFile !== void 0) attributions.set(id, ownerFile);
    }
    return attributions;
  } catch {
    return /* @__PURE__ */ new Map();
  }
}
async function writeAttributions(cwd, attributions) {
  const path = attributionPath(cwd);
  const staged = `${path}.${String(process.pid)}.tmp`;
  try {
    await writeFile(staged, JSON.stringify(Object.fromEntries(attributions), null, 2));
    await rename(staged, path);
  } catch {
    return;
  }
}
var taskRecordCache = /* @__PURE__ */ new Map();
var TASK_RECORD_CACHE_LIMIT = 5e3;
async function readTaskRecordFile(full) {
  let sizeBytes;
  let mtimeMs;
  try {
    const info = await stat(full);
    sizeBytes = info.size;
    mtimeMs = info.mtimeMs;
  } catch {
    return void 0;
  }
  const cached = taskRecordCache.get(full);
  if (cached?.sizeBytes === sizeBytes && cached.mtimeMs === mtimeMs) return cached.task;
  let task;
  try {
    const parsed = JSON.parse(await readFile(full, "utf8"));
    task = typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
  if (taskRecordCache.size >= TASK_RECORD_CACHE_LIMIT && !taskRecordCache.has(full)) taskRecordCache.clear();
  taskRecordCache.set(full, { sizeBytes, mtimeMs, task });
  return task;
}
async function readTaskRecords(cwd) {
  const root = join(cwd, TASKS_SUBDIR);
  const records = /* @__PURE__ */ new Map();
  let dirs;
  try {
    dirs = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return records;
  }
  for (const dir of dirs) {
    let files;
    try {
      files = (await readdir(join(root, dir))).filter((name) => name.endsWith(".json"));
    } catch {
      continue;
    }
    for (const file of files) {
      const full = join(root, dir, file);
      const task = await readTaskRecordFile(full);
      if (task === void 0) continue;
      const id = asString(task.id) ?? basename(file, ".json");
      records.set(id, { task, file: full });
    }
  }
  return records;
}
async function runningTaskIds(cwd, probeProcessStart) {
  const running = /* @__PURE__ */ new Set();
  for (const [id, record] of await readTaskRecords(cwd)) {
    if (asString(record.task.status) !== "running") continue;
    if (await probedRunningStatus(record.task, probeProcessStart) !== "running") continue;
    running.add(id);
  }
  return running;
}
async function ownedTaskIds(cwd, transcriptPath) {
  const ids = /* @__PURE__ */ new Set([...await taskIdsForSession(transcriptPath), ...await taskIdsInSessionDirectory(cwd, transcriptSessionId(transcriptPath))]);
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
function transcriptSessionId(transcriptPath) {
  return /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/u.exec(basename(transcriptPath))?.[1];
}
async function taskIdsInSessionDirectory(cwd, sessionId) {
  const ids = /* @__PURE__ */ new Set();
  if (sessionId === void 0) return ids;
  for (const [id, record] of await readTaskRecords(cwd)) {
    if (basename(dirname(record.file)).startsWith(`${sessionId}-`)) ids.add(id);
  }
  return ids;
}
var OUTPUT_READ_LIMIT_BYTES = 1024 * 1024;
async function readTaskOutput(cwd, transcriptPath, taskId, tailBytes) {
  if (!(await ownedTaskIds(cwd, transcriptPath)).has(taskId)) return { known: false, reason: "not-owned" };
  const task = (await readTaskRecords(cwd)).get(taskId)?.task;
  const outputPath = asString(task?.outputPath);
  const registry = resolve(cwd, TASKS_SUBDIR) + sep;
  const file = outputPath === void 0 ? void 0 : resolve(cwd, outputPath);
  if (file?.startsWith(registry) !== true) return { known: false, reason: "no-output-file", command: asString(task?.command) ?? "" };
  const handle = await open(file, "r").catch(() => void 0);
  if (handle === void 0) return { known: false, reason: "no-output-file", command: asString(task?.command) ?? "" };
  try {
    const totalBytes = (await handle.stat()).size;
    const limit = Math.min(Math.max(1, Math.floor(tailBytes)), OUTPUT_READ_LIMIT_BYTES);
    const start = Math.max(0, totalBytes - limit);
    const buffer = Buffer.alloc(totalBytes - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const read = buffer.subarray(0, bytesRead);
    const lineStart = start === 0 ? 0 : read.indexOf(10) + 1;
    return { known: true, text: read.toString("utf8", lineStart), totalBytes, truncated: start > 0 || lineStart > 0, command: asString(task?.command) ?? "" };
  } finally {
    await handle.close();
  }
}
async function listBackgroundTasks(cwd, transcriptPath, now, probeProcessStart) {
  const [owned, records] = await Promise.all([ownedTaskIds(cwd, transcriptPath), readTaskRecords(cwd)]);
  const tasks = [];
  for (const id of owned) {
    const record = records.get(id);
    if (record === void 0) continue;
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
      startedAt: startedAt === void 0 ? void 0 : new Date(startedAt).toISOString(),
      endedAt: endedAt === void 0 ? void 0 : new Date(endedAt).toISOString(),
      durationMs: startedAt === void 0 ? void 0 : (endedAt ?? now) - startedAt,
      exitCode: asNumber(task.exitCode),
      bytesWritten: asNumber(task.bytesWritten) ?? 0,
      hasOutput: asString(task.outputPath) !== void 0
    });
  }
  tasks.sort((left, right) => (right.startedAt ?? "").localeCompare(left.startedAt ?? ""));
  return tasks;
}

// src/server-plugin.ts
function sessionFrom(input) {
  if (typeof input !== "object" || input === null) return void 0;
  const cwd = Reflect.get(input, "cwd");
  const sessionFile = Reflect.get(input, "sessionFile");
  if (typeof cwd !== "string" || !isAbsolute(cwd)) return void 0;
  if (typeof sessionFile !== "string" || !isAbsolute(sessionFile) || !sessionFile.endsWith(".jsonl")) return void 0;
  return { cwd, sessionFile };
}
function taskIdFrom(input) {
  const taskId = typeof input === "object" && input !== null ? Reflect.get(input, "taskId") : void 0;
  return typeof taskId === "string" && /^[A-Za-z0-9_-]+$/.test(taskId) ? taskId : void 0;
}
function tailBytesFrom(input) {
  const tailBytes = typeof input === "object" && input !== null ? Reflect.get(input, "tailBytes") : void 0;
  return typeof tailBytes === "number" && Number.isFinite(tailBytes) && tailBytes > 0 ? tailBytes : OUTPUT_READ_LIMIT_BYTES;
}
var COMMAND_SHOWN_CHARS = 4096;
function commandAsJson(command) {
  if (command === "") return {};
  if (command.length <= COMMAND_SHOWN_CHARS) return { command };
  const characters = Array.from(command);
  return characters.length <= COMMAND_SHOWN_CHARS ? { command } : { command: characters.slice(0, COMMAND_SHOWN_CHARS).join(""), commandCut: true };
}
function tasksAsJson(tasks) {
  return tasks.map((task) => ({
    id: task.id,
    name: task.name,
    status: task.status,
    ...task.startedAt === void 0 ? {} : { startedAt: task.startedAt },
    ...task.durationMs === void 0 ? {} : { durationMs: task.durationMs },
    ...task.exitCode === void 0 ? {} : { exitCode: task.exitCode }
  }));
}
function outputAsJson(read) {
  if (!read.known) return read.reason === "no-output-file" ? { known: false, reason: read.reason, ...commandAsJson(read.command) } : { known: false, reason: read.reason };
  return { known: true, text: read.text, totalBytes: read.totalBytes, truncated: read.truncated, ...commandAsJson(read.command) };
}
function probeWith(context, signal) {
  return processStartProbe((args, env) => context.execFile({ file: "ps", args, env, signal }));
}
var plugin = {
  apiVersion: 1,
  name: "Background Runs",
  activate: (context) => ({
    agentFacts: {
      workPaths: [{ root: "cwd", path: ".pi/tasks" }, { root: "cwd", path: ".pi/delegate" }]
    },
    backgroundWork: async (session, signal) => ({ running: await runningTasksForSession(session.cwd, session.sessionFile, probeWith(context, signal)) }),
    operations: {
      "tasks.list": async (input, { signal }) => {
        const session = sessionFrom(input);
        if (session === void 0) return { known: false, reason: "no-session" };
        return { known: true, tasks: tasksAsJson(await listBackgroundTasks(session.cwd, session.sessionFile, Date.now(), probeWith(context, signal))) };
      },
      "tasks.output": async (input) => {
        const session = sessionFrom(input);
        if (session === void 0) return { known: false, reason: "no-session" };
        const taskId = taskIdFrom(input);
        if (taskId === void 0) return { known: false, reason: "not-owned" };
        return outputAsJson(await readTaskOutput(session.cwd, session.sessionFile, taskId, tailBytesFrom(input)));
      }
    }
  })
};
var server_plugin_default = plugin;
export {
  server_plugin_default as default
};
