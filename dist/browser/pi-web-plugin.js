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
  lost: { tone: "problem", label: "ended \xB7 no exit code" },
  unknown: { tone: "unknown", label: "unknown" }
};
var STATUS_EXPLAINED = {
  lost: "The task's process ended without recording an exit code - the session daemon or the machine restarted, or the system stopped it.",
  unknown: "Could not tell whether the task is still running."
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
  return { id: task.id, name: task.name, ...presentation, detail: parts.filter((part) => part !== void 0).join(" \xB7 "), startedAt: task.startedAt, durationMs: task.durationMs, exitCode: task.exitCode, explain: STATUS_EXPLAINED[task.status] };
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
function listRow(row2, clock, startedWord, controls) {
  const expansion = controls.expansion?.(row2);
  return { id: row2.id, title: row2.name, ...ROW_SIDE[row2.tone](row2), detail: rowDetail(row2, clock, startedWord), ...expansion === void 0 ? {} : { expansion } };
}
function backgroundListModel(tasks, read, clock = localClockTime, controls = {}) {
  const list = backgroundTaskList(tasks);
  const hidden = list.hiddenFinished;
  const stopAll = list.running.length === 0 ? void 0 : controls.stopAll?.(list.running);
  return {
    read: LIST_READ[read],
    words: LIST_WORDS,
    groups: [
      { id: "running", heading: "Running", rows: list.running.map((row2) => listRow(row2, clock, "started ", controls)), ...stopAll === void 0 ? {} : { headingAction: stopAll } },
      { id: "finished", heading: "Finished", rows: list.finished.map((row2) => listRow(row2, clock, "", controls)) }
    ],
    notes: hidden === 0 ? [] : [`${String(hidden)} older ${hidden === 1 ? "run" : "runs"} not shown`]
  };
}
function stopNote(outcome, stillRunning) {
  if (outcome === void 0) return "pending";
  if (outcome.kind !== "ran") return outcome.kind;
  const last = outcome.notices.at(-1);
  if (!stillRunning && (last === void 0 || last.level === "error")) return "already-stopped";
  return last === void 0 ? "ran-still-running" : "said";
}
var STOP_NOTE_LINE = {
  "pending": () => ({ words: "Stopping\u2026", tone: "info" }),
  "said": (outcome) => {
    const last = outcome?.kind === "ran" ? outcome.notices.at(-1) : void 0;
    return { words: last?.message ?? "", tone: last?.level ?? "info" };
  },
  "already-stopped": () => ({ words: "Already stopped", tone: "info" }),
  "ran-still-running": () => ({ words: "The command ran; the task still reads running.", tone: "warning" }),
  "refused": (outcome) => ({ words: outcome?.kind === "refused" ? outcome.words : "", tone: "error" }),
  "waiting": () => ({ words: "No answer yet from the session; the list shows what happened.", tone: "info" }),
  "unknown": () => ({ words: "No answer from the machine; the list shows what happened.", tone: "warning" })
};
function byteSize(bytes) {
  const units = [[1024 * 1024, "MiB"], [1024, "KiB"]];
  for (const [size, unit] of units) {
    if (bytes >= size) return `${String(Math.round(bytes / size * 10) / 10)} ${unit}`;
  }
  return `${String(bytes)} bytes`;
}

// src/tasksRead.ts
var UNREAD = { tasks: [], read: "unread", readAt: 0 };
function tasksAt(view, now) {
  const sinceRead = Math.max(0, now - view.readAt);
  return view.tasks.map((task) => task.status === "running" && task.durationMs !== void 0 ? { ...task, durationMs: task.durationMs + sinceRead } : task);
}
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
        this.view = tasks === void 0 ? { ...this.view, read: "failed" } : { tasks, read: "read", readAt: Date.now() };
        this.changed();
      },
      () => {
        if (!current()) return;
        this.view = { ...this.view, read: "failed" };
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
var OUTPUT_UNREAD = { read: "reading", text: "", totalBytes: 0, truncated: false };
var OUTPUT_POLL_MS = 2e3;
var TaskOutputReads = class {
  constructor(changed) {
    this.changed = changed;
  }
  changed;
  entries = /* @__PURE__ */ new Map();
  view(key) {
    return this.entries.get(key)?.view ?? OUTPUT_UNREAD;
  }
  refresh(key, running, now, ask) {
    const entry = this.entries.get(key) ?? { view: OUTPUT_UNREAD, inFlight: false, answeredAt: void 0, answeredRunning: false };
    this.entries.set(key, entry);
    if (entry.inFlight || !outputReadDue(entry, running, now)) return;
    entry.inFlight = true;
    const land = (view) => {
      if (this.entries.get(key) !== entry) return;
      entry.inFlight = false;
      entry.view = view;
      entry.answeredAt = Date.now();
      entry.answeredRunning = running;
      this.changed(running ? OUTPUT_POLL_MS : void 0);
    };
    ask().then(
      (answer) => {
        land(outputFrom(answer) ?? { ...entry.view, read: "failed" });
      },
      () => {
        land({ ...entry.view, read: "failed" });
      }
    );
  }
  forget(key) {
    this.entries.delete(key);
  }
};
function outputReadDue(entry, running, now) {
  if (entry.answeredAt === void 0) return true;
  if (running) return now - entry.answeredAt >= OUTPUT_POLL_MS;
  return entry.answeredRunning;
}
function outputFrom(answer) {
  if (!isRecord(answer)) return void 0;
  const { known, text, totalBytes, truncated, reason, command, commandCut } = answer;
  if (known === true && typeof text === "string" && typeof totalBytes === "number" && typeof truncated === "boolean") {
    return { read: "ready", text, totalBytes, truncated, ...typeof command === "string" && command !== "" ? { command: { text: command, cut: commandCut === true } } : {} };
  }
  if (known === false && (reason === "no-session" || reason === "not-owned" || reason === "no-output-file")) {
    return { read: "failed", text: "", totalBytes: 0, truncated: false, missing: reason, ...typeof command === "string" && command !== "" ? { command: { text: command, cut: commandCut === true } } : {} };
  }
  return void 0;
}

// src/commandLayout.ts
var STAGE_ENDS = /* @__PURE__ */ new Set(["&&", "||", "|", "|&", ";"]);
var URL_TEXT = /[\w%.~-]/;
function commandLayout(command) {
  const lead = /^ */.exec(command)?.[0] ?? "";
  const stages = [];
  let words = [];
  let quote = "";
  for (const [, text = "", gap = ""] of command.slice(lead.length).matchAll(/([^ ]+)( *)/g)) {
    const startedOutside = quote === "";
    quote = quoteAfter(text, quote);
    words.push({ pieces: wordPieces(text), gapAfter: gap });
    if (quote === "" && (startedOutside && STAGE_ENDS.has(text) || text.endsWith(";"))) {
      stages.push(closeStage(words));
      words = [];
    }
  }
  if (words.length > 0) stages.push(closeStage(words));
  return { lead, stages };
}
function closeStage(words) {
  const last = words[words.length - 1];
  if (last === void 0) return { words, gapAfter: "" };
  return { words: [...words.slice(0, -1), { pieces: last.pieces, gapAfter: "" }], gapAfter: last.gapAfter };
}
function quoteAfter(text, quote) {
  let open = quote;
  for (const ch of text) {
    if (open === "" && (ch === "'" || ch === '"')) open = ch;
    else if (ch === open) open = "";
  }
  return open;
}
function wordPieces(word) {
  const pieces = [];
  let start = 0;
  for (let index = 1; index < word.length; index += 1) {
    if (!breaksBefore(word, index)) continue;
    pieces.push(word.slice(start, index));
    start = index;
  }
  pieces.push(word.slice(start));
  return pieces;
}
function breaksBefore(word, index) {
  const before = word.charAt(index - 1);
  const at = word.charAt(index);
  if (before === "/") return at !== "/" && index >= 2 && word.charAt(index - 2) !== "/";
  if (before === "=") return true;
  return (at === "?" || at === "&") && URL_TEXT.test(before);
}

// src/taskDetail.ts
var OUTPUT_TAIL_BYTES = 8 * 1024;
var WHOLE_LOG_BYTES = 1024 * 1024;
var TASK_DETAIL_SHELL = `<style>
  :host { display: flex; flex-direction: column; gap: var(--pi-space-3, 6px); min-width: 0; }
  .band { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: var(--pi-space-4, 8px); margin-top: var(--pi-space-1, 2px); padding-top: var(--pi-space-4, 8px); border-top: 1px solid var(--pi-border-muted); }
  .say { display: flex; flex-direction: column; gap: var(--pi-space-1, 2px); flex: 1 1 8rem; min-width: 0; }
  ::slotted([slot="say"]) { margin: 0; color: var(--pi-dim); font-size: var(--pi-text-xs); overflow-wrap: anywhere; }
  ::slotted([data-tone="info"]) { color: var(--pi-muted); }
  ::slotted([data-tone="warning"]) { color: var(--pi-warning); }
  ::slotted([data-tone="error"]) { color: var(--pi-danger); }
  ::slotted([slot="actions"]) { display: flex; flex-wrap: wrap; align-items: center; gap: var(--pi-space-4, 8px); }
</style><slot name="command"></slot><slot></slot><div class="band"><div class="say"><slot name="say"></slot></div><slot name="actions"></slot></div>`;
var TASK_COMMAND_SHELL = `<style>
  :host { box-sizing: border-box; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; column-gap: var(--pi-space-3, 6px); min-width: 0; padding: var(--pi-space-3, 6px); padding-inline-start: var(--pi-space-5, 10px); border: 1px solid var(--pi-border-muted); border-radius: var(--pi-radius-md, 8px); background: var(--pi-surface-canvas); color: var(--pi-text-secondary); font: var(--pi-text-xs) var(--pi-font-mono, monospace); line-height: 1.45; }
  p { margin: 0; padding-block: var(--pi-space-1, 2px); padding-inline-start: 2ch; max-height: calc(4 * 1.45em); overflow-y: auto; text-indent: -2ch; white-space: pre-wrap; overflow-wrap: anywhere; }
  .stage, .word, .piece { display: inline-block; max-width: 100%; vertical-align: top; text-indent: 0; }
  .word, .piece { word-break: break-all; }
  :host([cut]) .command::after { content: "\u2026"; }
  .prompt, button, .said { user-select: none; -webkit-user-select: none; }
  .prompt { color: var(--pi-dim); }
  button { position: relative; align-self: start; box-sizing: border-box; display: grid; place-items: center; width: 22px; height: 22px; padding: 0; border: 1px solid var(--pi-border-muted); border-radius: var(--pi-radius-sm, 6px); background: var(--pi-surface); color: var(--pi-muted); line-height: 1; cursor: pointer; }
  button::after { content: ""; position: absolute; inset: calc(-1 * var(--pi-space-5, 10px)) calc(-1 * var(--pi-space-1, 2px)); }
  button:focus-visible { outline: var(--pi-focus-ring-width, 2px) solid var(--pi-accent); outline-offset: var(--pi-focus-ring-offset-tight, 1px); }
  @media (hover: hover) { button:hover { color: var(--pi-text); border-color: var(--pi-accent); } }
  @media (pointer: coarse) {
    button::after { inset: calc((22px - var(--pi-control-height-touch, 44px)) / 2 - 1px); inset-inline-start: 0; }
    button:active { background: var(--pi-surface-hover); }
  }
  svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .said { grid-column: 1 / -1; justify-self: end; color: var(--pi-muted); font: var(--pi-text-xs) var(--pi-font-ui, sans-serif); }
  .said[data-outcome="refused"] { color: var(--pi-danger); }
</style><p><span class="prompt">$ </span><span class="command"></span></p><button type="button" aria-label="Copy command"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15V5a2 2 0 0 1 2-2h8"></path></svg></button><span class="said" role="status"></span>`;
var WHOLE_LOG_SHELL = `<style>
  :host { box-sizing: border-box; display: flex; flex-direction: column; gap: var(--pi-space-3, 6px); flex: 1 1 auto; height: 100%; min-height: 0; padding: var(--pi-space-4, 8px) var(--pi-space-5, 10px) max(var(--pi-space-5, 10px), env(safe-area-inset-bottom)); }
  header { display: flex; align-items: flex-start; gap: var(--pi-space-3, 6px); }
  .titles { display: flex; flex-direction: column; gap: var(--pi-space-1, 2px); flex: 1 1 auto; min-width: 0; }
  ::slotted([slot="title"]) { margin: 0; font-size: var(--pi-text-base); font-weight: 600; overflow-wrap: anywhere; }
  ::slotted([slot="cut"]) { margin: 0; color: var(--pi-dim); font-size: var(--pi-text-xs); }
  .body { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
</style><header><div class="titles"><slot name="title"></slot><slot name="cut"></slot></div><slot name="close"></slot></header><div class="body"><slot></slot></div>`;
var WHOLE_LOG_CLOSE_STYLES = `
  .bg-whole-log-close { position: relative; box-sizing: border-box; flex: none; display: inline-grid; place-items: center; width: var(--pi-panel-header-control-height, 36px); height: var(--pi-panel-header-control-height, 36px); padding: 0; border: 1px solid var(--pi-border); border-radius: var(--pi-radius-md, 8px); background: var(--pi-surface); color: var(--pi-text); font: inherit; line-height: 1; cursor: pointer; }
  .bg-whole-log-close svg { width: 18px; height: 18px; stroke-width: 2; pointer-events: none; }
  .bg-whole-log-close:focus-visible { outline: var(--pi-focus-ring-width, 2px) solid var(--pi-accent); outline-offset: var(--pi-focus-ring-offset-inset, -2px); }
  @media (hover: hover) { .bg-whole-log-close:hover { background: var(--pi-surface-hover); } }
  @media (pointer: coarse) {
    .bg-whole-log-close::after { content: ""; position: absolute; inset: calc((var(--pi-panel-header-control-height, 36px) - var(--pi-control-height-touch, 44px)) / 2 - 1px); }
    .bg-whole-log-close:active { background: var(--pi-surface-hover); }
  }
`;
var COPY_SAID = {
  "copied": () => "Copied",
  "copied-start": (command) => `Copied the first ${Array.from(command).length.toLocaleString("en-US")} characters`,
  "refused": () => "Could not copy"
};
var COPY_SAID_MS = 2e3;
function copyOutcome(copied, cut) {
  if (!copied) return "refused";
  return cut ? "copied-start" : "copied";
}
var writeClipboard = (text) => navigator.clipboard.writeText(text).then(() => true);
function defineTaskDetailElements(copyText) {
  const copy = copyText ?? writeClipboard;
  defineShell("bg-task-detail-2", TASK_DETAIL_SHELL);
  defineShell("bg-whole-log", WHOLE_LOG_SHELL);
  if (customElements.get("bg-task-command") !== void 0) return;
  customElements.define("bg-task-command", class extends HTMLElement {
    static observedAttributes = ["command"];
    root = this.attachShadow({ mode: "open" });
    saidTimer;
    constructor() {
      super();
      this.root.innerHTML = TASK_COMMAND_SHELL;
      this.root.querySelector("button")?.addEventListener("click", () => {
        this.copy();
      });
      this.root.querySelector("p")?.addEventListener("click", (event) => {
        this.selectCommandOnTripleClick(event);
      });
    }
    attributeChangedCallback() {
      this.root.querySelector(".command")?.replaceChildren(...commandNodes(this.getAttribute("command") ?? ""));
    }
    selectCommandOnTripleClick(event) {
      const command = this.root.querySelector(".command");
      if (event.detail < 3 || command === null) return;
      getSelection()?.selectAllChildren(command);
    }
    copy() {
      const command = this.getAttribute("command") ?? "";
      const cut = this.hasAttribute("cut");
      void Promise.resolve().then(() => copy(command)).then((copied) => copyOutcome(copied, cut), () => "refused").then((outcome) => {
        this.say(outcome, command);
      });
    }
    say(outcome, command) {
      const said = this.root.querySelector(".said");
      if (said === null) return;
      said.dataset["outcome"] = outcome;
      said.textContent = COPY_SAID[outcome](command);
      clearTimeout(this.saidTimer);
      this.saidTimer = setTimeout(() => {
        said.textContent = "";
      }, COPY_SAID_MS);
    }
  });
}
function span(className, children) {
  const element = document.createElement("span");
  element.className = className;
  element.append(...children.filter((child) => child !== ""));
  return element;
}
function wordNodes(word) {
  const text = word.pieces.length > 1 ? word.pieces.map((piece) => span("piece", [piece])) : word.pieces;
  return [span("word", text), word.gapAfter];
}
function commandNodes(command) {
  const layout = commandLayout(command);
  return [layout.lead, ...layout.stages.flatMap((stage) => [span("stage", stage.words.flatMap(wordNodes)), stage.gapAfter])].filter((node) => node !== "");
}
function defineShell(tag, markup) {
  if (customElements.get(tag) !== void 0) return;
  customElements.define(tag, class extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" }).innerHTML = markup;
    }
  });
}
var MISSING_WORDS = {
  "no-session": "This session has no transcript yet.",
  "not-owned": "This session did not start this run.",
  "no-output-file": "No output file to read."
};
function outputWords(running, output) {
  return {
    empty: running ? "No output yet." : "The task wrote no output.",
    reading: "Reading the output\u2026",
    failed: output.missing === void 0 ? "Could not read the output." : MISSING_WORDS[output.missing],
    stale: "Could not refresh - showing the last read."
  };
}
function cutWords(output, limitBytes) {
  return output.truncated ? `Showing the last ${byteSize(limitBytes)} of ${byteSize(output.totalBytes)}` : void 0;
}
function exitNote(exitCode) {
  return exitCode === void 0 ? void 0 : { words: `Exited with code ${String(exitCode)}.`, tone: exitCode === 0 ? "info" : "error" };
}
function taskDetailBody(html, ui, detail) {
  const explained = detail.explain === void 0 ? void 0 : { words: detail.explain, tone: "info" };
  const notes = [detail.note, explained, exitNote(detail.exitCode)].filter((note) => note !== void 0);
  const cut = cutWords(detail.output, OUTPUT_TAIL_BYTES);
  const command = detail.output.command;
  return html`<bg-task-detail-2>
    ${command === void 0 ? "" : html`<bg-task-command slot="command" command=${command.text} ?cut=${command.cut}></bg-task-command>`}
    ${ui.renderOutput({ label: `Output of ${detail.name}`, read: detail.output.read, text: detail.output.text, words: outputWords(detail.running, detail.output) })}
    ${notes.map((note) => html`<p slot="say" data-tone=${note.tone}>${note.words}</p>`)}
    ${cut === void 0 ? "" : html`<p slot="say">${cut}</p>`}
    <div slot="actions">
      ${ui.renderButton({ label: "Whole log", busy: detail.wholeLog.busy, run: detail.wholeLog.open })}
      ${detail.stop === void 0 ? "" : ui.renderButton({ label: "Stop", tone: "danger", busy: detail.stop.busy, run: detail.stop.run })}
    </div>
  </bg-task-detail-2>`;
}
function wholeLogContent(html, ui, log) {
  const cut = cutWords(log.output, WHOLE_LOG_BYTES);
  return html`<bg-whole-log>
    <h2 slot="title">${log.name}</h2>
    ${cut === void 0 ? "" : html`<p slot="cut">${cut}</p>`}
    <style>${WHOLE_LOG_CLOSE_STYLES}</style>
    <button slot="close" class="bg-whole-log-close" type="button" aria-label="Close" @click=${log.close}>${log.closeIcon ?? "Close"}</button>
    ${ui.renderOutput({ label: `Whole log of ${log.name}`, read: log.output.read, text: log.output.text, words: outputWords(log.running, log.output), size: "fill" })}
  </bg-whole-log>`;
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
var NO_TRANSCRIPT = { tasks: [], read: "read", readAt: 0 };
var ELAPSED_TICK_MS = 1e3;
var STOP_NEEDS_NEWER_HOST = { words: "Stop needs a newer PI WEB on this machine.", tone: "info" };
var LOST_ANSWER = { kind: "unknown", words: "" };
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
    const opened = /* @__PURE__ */ new Set();
    const stops = /* @__PURE__ */ new Map();
    const wholeLogsReading = /* @__PURE__ */ new Set();
    const stopAllsInFlight = /* @__PURE__ */ new Map();
    const pollAfter = (ms, due = () => {
      requestUpdate();
    }) => {
      setTimeout(() => {
        if (document.visibilityState === "visible") due();
        else document.addEventListener("visibilitychange", due, { once: true });
      }, ms);
    };
    let elapsedTickPending = false;
    const tickElapsed = () => {
      if (elapsedTickPending) return;
      elapsedTickPending = true;
      pollAfter(ELAPSED_TICK_MS, () => {
        elapsedTickPending = false;
        requestUpdate();
      });
    };
    const outputs = new TaskOutputReads((pollAgainInMs) => {
      requestUpdate();
      if (pollAgainInMs !== void 0) pollAfter(pollAgainInMs);
    });
    if (ui?.renderOutput !== void 0) defineTaskDetailElements(ui.copyText);
    const rowControls = (panel, scope) => {
      const renderOutput = ui?.renderOutput;
      const renderButton = ui?.renderButton;
      if (ui === void 0 || renderOutput === void 0 || renderButton === void 0 || callOperation === void 0) return {};
      const rowUi = { renderOutput, renderButton };
      const machineId = panel.machine.id;
      const sessionKey = JSON.stringify([machineId, scope.sessionFile]);
      const keyOf = (taskId) => JSON.stringify([machineId, scope.sessionFile, taskId]);
      const readOutput = (taskId, tailBytes) => callOperation("tasks.output", { cwd: scope.cwd, sessionFile: scope.sessionFile, taskId, tailBytes });
      const stopPending = (key) => stops.has(key) && stops.get(key) === void 0;
      const session = panel.session;
      const stop = session === void 0 ? void 0 : (row2) => {
        const key = keyOf(row2.id);
        stops.set(key, void 0);
        requestUpdate();
        return session.runCommand({ sessionId: session.id, name: "kill", args: row2.id }).catch(() => LOST_ANSWER).then((outcome) => {
          stops.set(key, outcome);
          reader.forget();
          requestUpdate();
        });
      };
      const openWholeLog = (row2, key) => {
        wholeLogsReading.add(key);
        requestUpdate();
        void readOutput(row2.id, WHOLE_LOG_BYTES).then(outputFrom, () => void 0).then((output) => {
          wholeLogsReading.delete(key);
          requestUpdate();
          const dialog = ui.showDialog({
            label: `${row2.name} log`,
            presentation: "fullscreen",
            content: wholeLogContent(html, rowUi, {
              name: row2.name,
              running: row2.tone === "running",
              output: output ?? { read: "failed", text: "", totalBytes: 0, truncated: false },
              close: () => {
                dialog.close();
              },
              closeIcon: ui.renderCloseIcon?.()
            })
          });
        });
      };
      const noteOf = (row2, key) => {
        const running = row2.tone === "running";
        if (stops.has(key)) {
          const outcome = stops.get(key);
          return STOP_NOTE_LINE[stopNote(outcome, running)](outcome);
        }
        return running && stop === void 0 ? STOP_NEEDS_NEWER_HOST : void 0;
      };
      const confirm = ui.confirm;
      return {
        expansion: (row2) => {
          const key = keyOf(row2.id);
          return {
            expanded: opened.has(key),
            onToggle: () => {
              if (opened.delete(key)) outputs.forget(key);
              else opened.add(key);
              requestUpdate();
            },
            body: () => {
              const running = row2.tone === "running";
              outputs.refresh(key, running, Date.now(), () => readOutput(row2.id, OUTPUT_TAIL_BYTES));
              return taskDetailBody(html, rowUi, {
                name: row2.name,
                running,
                exitCode: row2.exitCode,
                explain: row2.explain,
                output: outputs.view(key),
                note: noteOf(row2, key),
                wholeLog: { busy: wholeLogsReading.has(key), open: () => {
                  if (!wholeLogsReading.has(key)) openWholeLog(row2, key);
                } },
                stop: !running || stop === void 0 ? void 0 : { busy: stopPending(key), run: () => {
                  if (!stopPending(key)) void stop(row2);
                } }
              });
            }
          };
        },
        ...stop === void 0 || confirm === void 0 ? {} : {
          stopAll: (running) => ({
            id: "stop-all",
            label: "Stop all",
            tone: "danger",
            busy: (stopAllsInFlight.get(sessionKey) ?? 0) > 0,
            run: () => {
              const count = running.length;
              void confirm({
                title: `Stop ${String(count)} background ${count === 1 ? "run" : "runs"}?`,
                message: "Each one is sent /kill now. What they wrote so far stays in their output.",
                confirmLabel: "Stop all",
                tone: "danger"
              }).then((confirmed) => {
                if (!confirmed) return;
                const sends = running.filter((row2) => !stopPending(keyOf(row2.id)));
                stopAllsInFlight.set(sessionKey, (stopAllsInFlight.get(sessionKey) ?? 0) + sends.length);
                for (const row2 of sends) {
                  void stop(row2).finally(() => {
                    stopAllsInFlight.set(sessionKey, (stopAllsInFlight.get(sessionKey) ?? 1) - 1);
                    requestUpdate();
                  });
                }
                requestUpdate();
              });
            }
          })
        }
      };
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
              const scope = scopeOf(panel);
              if (ui?.renderList === void 0) return html`<p class="muted">This list needs a newer PI WEB on this device.</p>`;
              const tasks = tasksAt(view, Date.now());
              if (tasks.some((task) => task.status === "running")) tickElapsed();
              return ui.renderList(backgroundListModel(tasks, view.read, localClockTime, scope === void 0 ? {} : rowControls(panel, scope)));
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
