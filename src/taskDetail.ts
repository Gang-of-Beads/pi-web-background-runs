import type { HtmlTemplateTag, PluginHostUi, PluginListWords } from "@gang-of-beads/pi-web-plugin-api/plugin-api";
import { byteSize, type NoteLine } from "./backgroundTaskRows.js";
import { commandLayout, type CommandWord } from "./commandLayout.js";
import type { OutputView } from "./tasksRead.js";

type Template = ReturnType<HtmlTemplateTag>;

/** The host components a row that opens is built from; a host without them draws the rows flat. */
export interface RowUi {
  readonly renderOutput: NonNullable<PluginHostUi["renderOutput"]>;
  readonly renderButton: NonNullable<PluginHostUi["renderButton"]>;
}

/** How much of a task's output its open row shows, and how much the Whole log does (design-b3s3-v2 §4.4). */
export const OUTPUT_TAIL_BYTES = 8 * 1024;
export const WHOLE_LOG_BYTES = 1024 * 1024;

/**
 * The plugin's own layout around the host components. A row's body and a dialog's content land in a
 * host element whose styles are not this plugin's, so the arrangement lives in these elements' shadow
 * roots and the host components and words are slotted into them. They are plain custom elements: the
 * plugin builds templates with the host's `html` and bundles no lit of its own. An open row is the
 * design's sectioned row kept inside the row's padding, so its boxes take the theme's 8 px
 * radius and surfaces: the command box and the output box as a pair, then a band under a hairline with
 * what the row knows on the left and Whole log and Stop on the right.
 */
const TASK_DETAIL_SHELL = `<style>
  :host { display: flex; flex-direction: column; gap: var(--pi-space-3, 6px); min-width: 0; }
  .band { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: var(--pi-space-4, 8px); margin-top: var(--pi-space-1, 2px); padding-top: var(--pi-space-4, 8px); border-top: 1px solid var(--pi-border-muted); }
  .say { display: flex; flex-direction: column; gap: var(--pi-space-1, 2px); flex: 1 1 8rem; min-width: 0; }
  ::slotted([slot="say"]) { margin: 0; color: var(--pi-dim); font-size: var(--pi-text-xs); overflow-wrap: anywhere; }
  ::slotted([data-tone="info"]) { color: var(--pi-muted); }
  ::slotted([data-tone="warning"]) { color: var(--pi-warning); }
  ::slotted([data-tone="error"]) { color: var(--pi-danger); }
  ::slotted([slot="actions"]) { display: flex; flex-wrap: wrap; align-items: center; gap: var(--pi-space-4, 8px); }
</style><slot name="command"></slot><slot></slot><div class="band"><div class="say"><slot name="say"></slot></div><slot name="actions"></slot></div>`;

/**
 * The command box: the command in mono, at most four lines with its own scroll so the output and the
 * actions stay on screen, and a copy key drawn like the chat message header keys (22 px, muted ink,
 * 14 px glyph; owner: the 36 px bar key was too big). On a finger its reach grows up, down and right
 * to 44 px tall, never over the command, so a long press there still selects text.
 *
 * A long command wraps between its words, continuation lines indented under the command rather than
 * under `$` (see `commandLayout`). A triple-click selects exactly the command: the browser's own
 * paragraph selection runs on to the next selectable text (the output box below) and copies newlines
 * with the command, and a pasted newline runs it. For the same reason the key and its status line
 * are not selectable.
 */
const TASK_COMMAND_SHELL = `<style>
  :host { box-sizing: border-box; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; column-gap: var(--pi-space-3, 6px); min-width: 0; padding: var(--pi-space-3, 6px); padding-inline-start: var(--pi-space-5, 10px); border: 1px solid var(--pi-border-muted); border-radius: var(--pi-radius-md, 8px); background: var(--pi-surface-canvas); color: var(--pi-text-secondary); font: var(--pi-text-xs) var(--pi-font-mono, monospace); line-height: 1.45; }
  p { margin: 0; padding-block: var(--pi-space-1, 2px); padding-inline-start: 2ch; max-height: calc(4 * 1.45em); overflow-y: auto; text-indent: -2ch; white-space: pre-wrap; overflow-wrap: anywhere; }
  .stage, .word, .piece { display: inline-block; max-width: 100%; vertical-align: top; text-indent: 0; }
  .word, .piece { word-break: break-all; }
  :host([cut]) .command::after { content: "…"; }
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

const WHOLE_LOG_SHELL = `<style>
  :host { box-sizing: border-box; display: flex; flex-direction: column; gap: var(--pi-space-3, 6px); flex: 1 1 auto; height: 100%; min-height: 0; padding: var(--pi-space-4, 8px) var(--pi-space-5, 10px) max(var(--pi-space-5, 10px), env(safe-area-inset-bottom)); }
  header { display: flex; align-items: flex-start; gap: var(--pi-space-3, 6px); }
  .titles { display: flex; flex-direction: column; gap: var(--pi-space-1, 2px); flex: 1 1 auto; min-width: 0; }
  ::slotted([slot="title"]) { margin: 0; font-size: var(--pi-text-base); font-weight: 600; overflow-wrap: anywhere; }
  ::slotted([slot="cut"]) { margin: 0; color: var(--pi-dim); font-size: var(--pi-text-xs); }
  .body { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
</style><header><div class="titles"><slot name="title"></slot><slot name="cut"></slot></div><slot name="close"></slot></header><div class="body"><slot></slot></div>`;

/**
 * The Whole log's close key, the dialogs' bar key (36 px box, 18 px glyph, 44 px reach on a finger).
 * The key is light DOM in the host's scope, where the host's own `button` rule beats any `::slotted`
 * rule of the shell, so this sheet travels with the template into that scope and wins by class.
 */
const WHOLE_LOG_CLOSE_STYLES = `
  .bg-whole-log-close { position: relative; box-sizing: border-box; flex: none; display: inline-grid; place-items: center; width: var(--pi-panel-header-control-height, 36px); height: var(--pi-panel-header-control-height, 36px); padding: 0; border: 1px solid var(--pi-border); border-radius: var(--pi-radius-md, 8px); background: var(--pi-surface); color: var(--pi-text); font: inherit; line-height: 1; cursor: pointer; }
  .bg-whole-log-close svg { width: 18px; height: 18px; stroke-width: 2; pointer-events: none; }
  .bg-whole-log-close:focus-visible { outline: var(--pi-focus-ring-width, 2px) solid var(--pi-accent); outline-offset: var(--pi-focus-ring-offset-inset, -2px); }
  @media (hover: hover) { .bg-whole-log-close:hover { background: var(--pi-surface-hover); } }
  @media (pointer: coarse) {
    .bg-whole-log-close::after { content: ""; position: absolute; inset: calc((var(--pi-panel-header-control-height, 36px) - var(--pi-control-height-touch, 44px)) / 2 - 1px); }
    .bg-whole-log-close:active { background: var(--pi-surface-hover); }
  }
`;

type CopyText = PluginHostUi["copyText"];

type CopyOutcome = "copied" | "copied-start" | "refused";

/** What the copy key says, and for how long; a clipboard that refuses says so, and a cut command says only its start was copied. */
const COPY_SAID: Readonly<Record<CopyOutcome, (command: string) => string>> = {
  "copied": () => "Copied",
  "copied-start": (command) => `Copied the first ${Array.from(command).length.toLocaleString("en-US")} characters`,
  "refused": () => "Could not copy",
};
const COPY_SAID_MS = 2_000;

function copyOutcome(copied: boolean, cut: boolean): CopyOutcome {
  if (!copied) return "refused";
  return cut ? "copied-start" : "copied";
}

/** The browser's own clipboard, for a host without `copyText`; a page on plain http has none and reads as refused. */
const writeClipboard: CopyText = (text) => navigator.clipboard.writeText(text).then(() => true);

/**
 * Custom elements are page-global and the first definition of a tag wins, so a shell whose slots
 * change takes a new tag: a newer copy of the plugin must not land in an older copy's shell.
 * `copyText` is the host's clipboard chain (it falls back where `navigator.clipboard` is missing).
 */
export function defineTaskDetailElements(copyText: CopyText | undefined): void {
  const copy = copyText ?? writeClipboard;
  defineShell("bg-task-detail-2", TASK_DETAIL_SHELL);
  defineShell("bg-whole-log", WHOLE_LOG_SHELL);
  if (customElements.get("bg-task-command") !== undefined) return;
  customElements.define("bg-task-command", class extends HTMLElement {
    static readonly observedAttributes = ["command"];
    private readonly root = this.attachShadow({ mode: "open" });
    private saidTimer: ReturnType<typeof setTimeout> | undefined;

    constructor() {
      super();
      this.root.innerHTML = TASK_COMMAND_SHELL;
      this.root.querySelector("button")?.addEventListener("click", () => { this.copy(); });
      this.root.querySelector("p")?.addEventListener("click", (event) => { this.selectCommandOnTripleClick(event); });
    }

    attributeChangedCallback(): void {
      this.root.querySelector(".command")?.replaceChildren(...commandNodes(this.getAttribute("command") ?? ""));
    }

    private selectCommandOnTripleClick(event: MouseEvent): void {
      const command = this.root.querySelector(".command");
      if (event.detail < 3 || command === null) return;
      getSelection()?.selectAllChildren(command);
    }

    private copy(): void {
      const command = this.getAttribute("command") ?? "";
      const cut = this.hasAttribute("cut");
      void Promise.resolve()
        .then(() => copy(command))
        .then((copied) => copyOutcome(copied, cut), (): CopyOutcome => "refused")
        .then((outcome) => { this.say(outcome, command); });
    }

    private say(outcome: CopyOutcome, command: string): void {
      const said = this.root.querySelector<HTMLElement>(".said");
      if (said === null) return;
      said.dataset["outcome"] = outcome;
      said.textContent = COPY_SAID[outcome](command);
      clearTimeout(this.saidTimer);
      this.saidTimer = setTimeout(() => { said.textContent = ""; }, COPY_SAID_MS);
    }
  });
}

function span(className: string, children: readonly (Node | string)[]): HTMLSpanElement {
  const element = document.createElement("span");
  element.className = className;
  element.append(...children.filter((child) => child !== ""));
  return element;
}

function wordNodes(word: CommandWord): (Node | string)[] {
  const text = word.pieces.length > 1 ? word.pieces.map((piece) => span("piece", [piece])) : word.pieces;
  return [span("word", text), word.gapAfter];
}

/** The command laid out by `commandLayout`: the same characters, grouped so lines break between words. */
function commandNodes(command: string): (Node | string)[] {
  const layout = commandLayout(command);
  return [layout.lead, ...layout.stages.flatMap((stage) => [span("stage", stage.words.flatMap(wordNodes)), stage.gapAfter])].filter((node) => node !== "");
}

function defineShell(tag: string, markup: string): void {
  if (customElements.get(tag) !== undefined) return;
  customElements.define(tag, class extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" }).innerHTML = markup;
    }
  });
}

const MISSING_WORDS: Readonly<Record<NonNullable<OutputView["missing"]>, string>> = {
  "no-session": "This session has no transcript yet.",
  "not-owned": "This session did not start this run.",
  "no-output-file": "No output file to read.",
};

function outputWords(running: boolean, output: OutputView): PluginListWords {
  return {
    empty: running ? "No output yet." : "The task wrote no output.",
    reading: "Reading the output…",
    failed: output.missing === undefined ? "Could not read the output." : MISSING_WORDS[output.missing],
    stale: "Could not refresh - showing the last read.",
  };
}

function cutWords(output: OutputView, limitBytes: number): string | undefined {
  return output.truncated ? `Showing the last ${byteSize(limitBytes)} of ${byteSize(output.totalBytes)}` : undefined;
}

export interface TaskDetail {
  readonly name: string;
  readonly running: boolean;
  /** Absent while it runs, and when the record has no exit code. */
  readonly exitCode: number | undefined;
  /** What a settled but uncertain status means; absent for the others. */
  readonly explain: string | undefined;
  readonly output: OutputView;
  readonly note: NoteLine | undefined;
  readonly wholeLog: { readonly busy: boolean; readonly open: () => void };
  /** Absent for a finished task, and where this PI WEB cannot run the stop command. */
  readonly stop: { readonly busy: boolean; readonly run: () => void } | undefined;
}

function exitNote(exitCode: number | undefined): NoteLine | undefined {
  return exitCode === undefined ? undefined : { words: `Exited with code ${String(exitCode)}.`, tone: exitCode === 0 ? "info" : "error" };
}

/** An open row: the command box, the end of its output, then a band with its notes and cut size left, Whole log and, while it runs, Stop right. */
export function taskDetailBody(html: HtmlTemplateTag, ui: RowUi, detail: TaskDetail): Template {
  const explained: NoteLine | undefined = detail.explain === undefined ? undefined : { words: detail.explain, tone: "info" };
  const notes = [detail.note, explained, exitNote(detail.exitCode)].filter((note) => note !== undefined);
  const cut = cutWords(detail.output, OUTPUT_TAIL_BYTES);
  const command = detail.output.command;
  return html`<bg-task-detail-2>
    ${command === undefined ? "" : html`<bg-task-command slot="command" command=${command.text} ?cut=${command.cut}></bg-task-command>`}
    ${ui.renderOutput({ label: `Output of ${detail.name}`, read: detail.output.read, text: detail.output.text, words: outputWords(detail.running, detail.output) })}
    ${notes.map((note) => html`<p slot="say" data-tone=${note.tone}>${note.words}</p>`)}
    ${cut === undefined ? "" : html`<p slot="say">${cut}</p>`}
    <div slot="actions">
      ${ui.renderButton({ label: "Whole log", busy: detail.wholeLog.busy, run: detail.wholeLog.open })}
      ${detail.stop === undefined ? "" : ui.renderButton({ label: "Stop", tone: "danger", busy: detail.stop.busy, run: detail.stop.run })}
    </div>
  </bg-task-detail-2>`;
}

export interface WholeLog {
  readonly name: string;
  readonly running: boolean;
  readonly output: OutputView;
  readonly close: () => void;
  readonly closeIcon: Template | undefined;
}

/** The Whole log dialog's content: the task's name, how much of the file it shows, a close key and the output filling the screen. */
export function wholeLogContent(html: HtmlTemplateTag, ui: RowUi, log: WholeLog): Template {
  const cut = cutWords(log.output, WHOLE_LOG_BYTES);
  return html`<bg-whole-log>
    <h2 slot="title">${log.name}</h2>
    ${cut === undefined ? "" : html`<p slot="cut">${cut}</p>`}
    <style>${WHOLE_LOG_CLOSE_STYLES}</style>
    <button slot="close" class="bg-whole-log-close" type="button" aria-label="Close" @click=${log.close}>${log.closeIcon ?? "Close"}</button>
    ${ui.renderOutput({ label: `Whole log of ${log.name}`, read: log.output.read, text: log.output.text, words: outputWords(log.running, log.output), size: "fill" })}
  </bg-whole-log>`;
}
