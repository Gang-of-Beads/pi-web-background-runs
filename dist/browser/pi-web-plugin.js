// src/backgroundRunNote.ts
function backgroundRunNote(count) {
  if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) return void 0;
  return count === 1 ? "1 background run" : `${String(count)} background runs`;
}
function backgroundRunCountOf(status) {
  if (typeof status !== "object" || status === null) return void 0;
  return Reflect.get(status, "backgroundRunCount");
}

// src/taskNotice.ts
var OUTCOMES = {
  completed: "completed",
  failed: "failed",
  killed: "killed",
  running: "running"
};
function readString(payload, key) {
  if (typeof payload !== "object" || payload === null) return void 0;
  const value = Reflect.get(payload, key);
  return typeof value === "string" && value !== "" ? value : void 0;
}
function readNumber(payload, key) {
  if (typeof payload !== "object" || payload === null) return void 0;
  const value = Reflect.get(payload, key);
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function taskNotice(payload) {
  const name = readString(payload, "name") ?? readString(payload, "id") ?? "Background task";
  const outcome = OUTCOMES[readString(payload, "status") ?? ""] ?? "unknown";
  return { name, outcome, detail: noticeDetail(outcome, readNumber(payload, "exitCode")) };
}
function noticeDetail(outcome, exitCode) {
  if (outcome === "running") return void 0;
  if (exitCode === void 0) return outcome === "unknown" ? "no status reported" : void 0;
  return `exit ${String(exitCode)}`;
}
function noticeLabel(notice) {
  const state = notice.outcome === "unknown" ? "reported" : notice.outcome === "running" ? "still running" : notice.outcome;
  return notice.detail === void 0 ? `${notice.name} ${state}` : `${notice.name} ${state} \xB7 ${notice.detail}`;
}

// src/backgroundTaskRows.ts
var STATUS = {
  running: { tone: "running", label: "running" },
  completed: { tone: "done", label: "done" },
  failed: { tone: "problem", label: "failed" },
  killed: { tone: "problem", label: "stopped" },
  lost: { tone: "problem", label: "lost" },
  unknown: { tone: "unknown", label: "unknown" }
};
var FINISHED_SHOWN = 30;
function taskPresentation(status) {
  return STATUS[status] ?? { tone: "unknown", label: status === "" ? "unknown" : status };
}
function durationLabel(ms) {
  if (ms === void 0 || !Number.isFinite(ms) || ms < 0) return void 0;
  const seconds = Math.floor(ms / 1e3);
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ${String(seconds % 60)}s`;
  return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}m`;
}
function row(task) {
  const presentation = taskPresentation(task.status);
  const parts = [durationLabel(task.durationMs), task.exitCode === void 0 ? void 0 : `exit ${String(task.exitCode)}`];
  return { id: task.id, name: task.name, ...presentation, detail: parts.filter((part) => part !== void 0).join(" \xB7 "), startedAt: task.startedAt, durationMs: task.durationMs, exitCode: task.exitCode };
}
function newestFirst(left, right) {
  return (right.startedAt ?? "").localeCompare(left.startedAt ?? "");
}
function backgroundTaskList(tasks, shown = FINISHED_SHOWN) {
  const running = tasks.filter((task) => task.status === "running").sort(newestFirst).map(row);
  const finished = tasks.filter((task) => task.status !== "running").sort(newestFirst);
  return {
    running,
    finished: finished.slice(0, shown).map(row),
    hiddenFinished: Math.max(0, finished.length - shown)
  };
}
var LIST_READ = { unread: "reading", read: "ready", failed: "failed" };
var LIST_WORDS = {
  empty: "This session has started no background runs.",
  reading: "Reading this session's background runs\u2026",
  failed: "This machine could not read the background runs.",
  stale: "Could not refresh - showing the last read."
};
var exitWord = (row2) => row2.exitCode === void 0 ? void 0 : `exit ${String(row2.exitCode)}`;
var ROW_SIDE = {
  running: (row2) => ({ status: { label: row2.label, tone: "good" } }),
  done: (row2) => ({ value: exitWord(row2) ?? row2.label }),
  problem: (row2) => ({ status: { label: exitWord(row2) ?? row2.label, tone: "problem" } }),
  unknown: (row2) => ({ status: { label: row2.label, tone: "neutral" } })
};
var dayNumber = (date) => date.getFullYear() * 1e4 + date.getMonth() * 100 + date.getDate();
var localClockTime = (iso) => {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return void 0;
  const at = new Date(time);
  return dayNumber(at) === dayNumber(/* @__PURE__ */ new Date()) ? at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : at.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};
function rowDetail(row2, clock, startedWord) {
  const started = row2.startedAt === void 0 ? void 0 : clock(row2.startedAt);
  const parts = [started === void 0 ? void 0 : `${startedWord}${started}`, durationLabel(row2.durationMs)];
  return parts.filter((part) => part !== void 0).join(" \xB7 ");
}
function listRow(row2, clock, startedWord) {
  return { id: row2.id, title: row2.name, ...ROW_SIDE[row2.tone](row2), detail: rowDetail(row2, clock, startedWord) };
}
function backgroundListModel(tasks, read, clock = localClockTime) {
  const list = backgroundTaskList(tasks);
  const hidden = list.hiddenFinished;
  return {
    read: LIST_READ[read],
    words: LIST_WORDS,
    groups: [
      { id: "running", heading: "Running", rows: list.running.map((row2) => listRow(row2, clock, "started ")) },
      { id: "finished", heading: "Finished", rows: list.finished.map((row2) => listRow(row2, clock, "")) }
    ],
    notes: hidden === 0 ? [] : [`${String(hidden)} older ${hidden === 1 ? "run" : "runs"} not shown`]
  };
}

// src/tasksRead.ts
var UNREAD = { tasks: [], read: "unread" };
var TasksReader = class {
  constructor(ask, changed) {
    this.ask = ask;
    this.changed = changed;
  }
  ask;
  changed;
  sessionFile;
  key;
  view = UNREAD;
  issued = 0;
  /** The session on screen and its key; reads when either is new. */
  follow(scope, key) {
    if (this.sessionFile !== scope.sessionFile) {
      this.sessionFile = scope.sessionFile;
      this.view = UNREAD;
      this.key = void 0;
    }
    if (this.key === key) return;
    this.key = key;
    this.read(scope);
  }
  /** Something outside the key changed (the session's work settled): the next follow reads. */
  forget() {
    this.key = void 0;
  }
  viewFor(sessionFile) {
    return this.sessionFile === sessionFile ? this.view : UNREAD;
  }
  read(scope) {
    this.issued += 1;
    const seq = this.issued;
    const current = () => seq === this.issued && scope.sessionFile === this.sessionFile;
    this.ask(scope).then(
      (answer) => {
        if (!current()) return;
        const tasks = tasksFrom(answer);
        this.view = tasks === void 0 ? { tasks: this.view.tasks, read: "failed" } : { tasks, read: "read" };
        this.changed();
      },
      () => {
        if (!current()) return;
        this.view = { tasks: this.view.tasks, read: "failed" };
        this.changed();
      }
    );
  }
};
function tasksFrom(answer) {
  if (!isRecord(answer) || answer["known"] !== true || !Array.isArray(answer["tasks"])) return void 0;
  return answer["tasks"].flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const { id, name, status, startedAt, durationMs, exitCode } = entry;
    if (typeof id !== "string" || typeof name !== "string" || typeof status !== "string") return [];
    return [{
      id,
      name,
      status,
      ...typeof startedAt === "string" ? { startedAt } : {},
      ...typeof durationMs === "number" ? { durationMs } : {},
      ...typeof exitCode === "number" ? { exitCode } : {}
    }];
  });
}
function isRecord(value) {
  return typeof value === "object" && value !== null;
}

// src/pi-web-plugin.ts
function scopeOf(panel) {
  const selected = panel.state?.selectedSession;
  const cwd = selected?.cwd;
  const sessionFile = selected?.path;
  if (cwd === void 0 || cwd === "" || sessionFile === void 0 || sessionFile === "") return void 0;
  return { cwd, sessionFile };
}
function readKeyOf(panel) {
  const status = panel.state?.status;
  return `${String(status?.backgroundRunCount ?? 0)}:${String(status?.isStreaming === true)}`;
}
var NO_TRANSCRIPT = { tasks: [], read: "read" };
var plugin = {
  apiVersion: 2,
  name: "Background Runs",
  activate: (context) => {
    const { html, svg, ui } = context;
    const callOperation = context.callOperation;
    let requestUpdate = () => void 0;
    const reader = new TasksReader(
      (scope) => callOperation === void 0 ? Promise.reject(new Error("no operations")) : callOperation("tasks.list", { cwd: scope.cwd, sessionFile: scope.sessionFile }),
      () => {
        requestUpdate();
      }
    );
    context.on?.("session-activity-settled", () => {
      reader.forget();
      requestUpdate();
    });
    const viewOf = (panel) => {
      requestUpdate = () => {
        panel.host.requestRender();
      };
      const scope = scopeOf(panel);
      if (scope === void 0) return NO_TRANSCRIPT;
      reader.follow(scope, readKeyOf(panel));
      return reader.viewFor(scope.sessionFile);
    };
    return {
      contributions: {
        workspacePanels: [
          {
            id: "workspace.background",
            title: "Background",
            icon: svg`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"></circle><path d="M12 7.5V12l3 2"></path></svg>`,
            order: 65,
            visible: (context2) => context2.state?.selectedSession !== void 0,
            badge: (panel) => {
              const running = viewOf(panel).tasks.filter((task) => task.status === "running").length;
              return running === 0 ? void 0 : running;
            },
            render: (panel) => {
              const view = viewOf(panel);
              return ui?.renderList === void 0 ? html`<p class="muted">This list needs a newer PI WEB on this device.</p>` : ui.renderList(backgroundListModel(view.tasks, view.read));
            }
          }
        ],
        messageRenderers: [
          {
            id: "message.background-task-notification",
            tag: "background-task-notification",
            render: (view) => html`<strong>Background task</strong><div>${noticeLabel(taskNotice(view.payload))}</div>`
          }
        ],
        activityNotes: [
          {
            id: "activity.background-runs",
            order: 100,
            note: (activity) => backgroundRunNote(backgroundRunCountOf(activity.status))
          }
        ]
      }
    };
  }
};
var pi_web_plugin_default = plugin;
export {
  pi_web_plugin_default as default
};
