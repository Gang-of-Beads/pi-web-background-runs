import type { HtmlTemplateTag, PluginHostUi, PluginListWords } from "@gang-of-beads/pi-web-plugin-api/plugin-api";
import { byteSize, type NoteLine } from "./backgroundTaskRows.js";
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
 * host element whose styles are not this plugin's, so the arrangement (note above the output, Whole
 * log left and Stop right, the log's header over a view that fills the screen) lives in these two
 * elements' shadow roots, and the host components and words are slotted into them. They are plain
 * custom elements: the plugin builds templates with the host's `html` and bundles no lit of its own.
 */
const TASK_DETAIL_SHELL = `<style>
  :host { display: flex; flex-direction: column; gap: var(--pi-space-3, 8px); min-width: 0; }
  ::slotted([slot="note"]) { margin: 0; color: var(--pi-muted); font-size: var(--pi-text-xs); overflow-wrap: anywhere; }
  ::slotted([data-tone="warning"]) { color: var(--pi-warning); }
  ::slotted([data-tone="error"]) { color: var(--pi-danger); }
  ::slotted([slot="actions"]) { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--pi-space-3, 8px); }
</style><slot name="note"></slot><slot></slot><slot name="actions"></slot>`;

const WHOLE_LOG_SHELL = `<style>
  :host { box-sizing: border-box; display: flex; flex-direction: column; gap: var(--pi-space-3, 8px); flex: 1 1 auto; height: 100%; min-height: 0; padding: var(--pi-space-4, 12px) var(--pi-space-5, 16px) max(var(--pi-space-5, 16px), env(safe-area-inset-bottom)); }
  header { display: flex; align-items: flex-start; gap: var(--pi-space-3, 8px); }
  .titles { display: flex; flex-direction: column; gap: var(--pi-space-1, 2px); flex: 1 1 auto; min-width: 0; }
  ::slotted([slot="title"]) { margin: 0; font-size: var(--pi-text-base); font-weight: 600; overflow-wrap: anywhere; }
  ::slotted([slot="cut"]) { margin: 0; color: var(--pi-dim); font-size: var(--pi-text-xs); }
  ::slotted([slot="close"]) { flex: none; display: grid; place-items: center; width: 44px; height: 44px; padding: 0; border: 0; border-radius: var(--pi-radius-md); background: transparent; color: inherit; cursor: pointer; }
  ::slotted([slot="close"]:focus-visible) { outline: var(--pi-focus-ring-width, 2px) solid var(--pi-accent); }
  .body { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
</style><header><div class="titles"><slot name="title"></slot><slot name="cut"></slot></div><slot name="close"></slot></header><div class="body"><slot></slot></div>`;

export function defineTaskDetailElements(): void {
  defineShell("bg-task-detail", TASK_DETAIL_SHELL);
  defineShell("bg-whole-log", WHOLE_LOG_SHELL);
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
  readonly output: OutputView;
  readonly note: NoteLine | undefined;
  readonly wholeLog: { readonly busy: boolean; readonly open: () => void };
  /** Absent for a finished task, and where this PI WEB cannot run the stop command. */
  readonly stop: { readonly busy: boolean; readonly run: () => void } | undefined;
}

/** An open row: its note, the end of its output, then Whole log and, while it runs, Stop. */
export function taskDetailBody(html: HtmlTemplateTag, ui: RowUi, detail: TaskDetail): Template {
  const cutAbove = cutWords(detail.output, OUTPUT_TAIL_BYTES);
  return html`<bg-task-detail>
    ${detail.note === undefined ? "" : html`<p slot="note" data-tone=${detail.note.tone}>${detail.note.words}</p>`}
    ${ui.renderOutput({ label: `Output of ${detail.name}`, read: detail.output.read, text: detail.output.text, words: outputWords(detail.running, detail.output), ...(cutAbove === undefined ? {} : { cutAbove }) })}
    <div slot="actions">
      ${ui.renderButton({ label: "Whole log", busy: detail.wholeLog.busy, run: detail.wholeLog.open })}
      ${detail.stop === undefined ? "" : ui.renderButton({ label: "Stop", tone: "danger", busy: detail.stop.busy, run: detail.stop.run })}
    </div>
  </bg-task-detail>`;
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
    <button slot="close" type="button" aria-label="Close" @click=${log.close}>${log.closeIcon ?? "Close"}</button>
    ${ui.renderOutput({ label: `Whole log of ${log.name}`, read: log.output.read, text: log.output.text, words: outputWords(log.running, log.output), size: "fill" })}
  </bg-whole-log>`;
}
