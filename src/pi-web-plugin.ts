import type { PiWebPlugin, PluginActivationContext, PluginSessionCommandOutcome, WorkspacePanelContext } from "@gang-of-beads/pi-web-plugin-api/plugin-api";
import { backgroundRunCountOf, backgroundRunNote } from "./backgroundRunNote.js";
import { noticeLabel, taskNotice } from "./taskNotice.js";
import { backgroundListModel, localClockTime, STOP_NOTE_LINE, stopNote, type ListControls, type NoteLine, type StopOutcome, type TaskRow } from "./backgroundTaskRows.js";
import { outputFrom, TaskOutputReads, TasksReader, type TaskScope, type TasksView } from "./tasksRead.js";
import { defineTaskDetailElements, OUTPUT_TAIL_BYTES, taskDetailBody, WHOLE_LOG_BYTES, wholeLogContent, type RowUi } from "./taskDetail.js";

/** The selected session's working directory and transcript; a session with no transcript yet has no scope. */
function scopeOf(panel: WorkspacePanelContext): TaskScope | undefined {
  const selected = panel.state?.selectedSession;
  const cwd = selected?.cwd;
  const sessionFile = selected?.path;
  if (cwd === undefined || cwd === "" || sessionFile === undefined || sessionFile === "") return undefined;
  return { cwd, sessionFile };
}

/** The facts that move when the session's tasks do: read again when one changes. */
function readKeyOf(panel: WorkspacePanelContext): string {
  const status = panel.state?.status;
  return `${String(status?.backgroundRunCount ?? 0)}:${String(status?.isStreaming === true)}`;
}

/** A session that has no transcript yet can own no task on disk. */
const NO_TRANSCRIPT: TasksView = { tasks: [], read: "read" };

/** Said on a running row where this PI WEB cannot run the extension's stop command. */
const STOP_NEEDS_NEWER_HOST: NoteLine = { words: "Stop needs a newer PI WEB on this machine.", tone: "info" };

/** A command whose promise failed was taken or not; only the list can tell. */
const LOST_ANSWER: PluginSessionCommandOutcome = { kind: "unknown", words: "" };

const plugin: PiWebPlugin = {
  apiVersion: 2,
  name: "Background Runs",
  activate: (context: PluginActivationContext) => {
    const { html, svg, ui } = context;
    const callOperation = context.callOperation;
    let requestUpdate: () => void = () => undefined;
    const reader = new TasksReader(
      (scope) => (callOperation === undefined ? Promise.reject(new Error("no operations")) : callOperation("tasks.list", { cwd: scope.cwd, sessionFile: scope.sessionFile })),
      () => { requestUpdate(); },
    );
    context.on?.("session-activity-settled", () => {
      reader.forget();
      requestUpdate();
    });
    /** The panel and the tab's badge both ask, so the read follows the selected session while the panel is closed too. */
    const viewOf = (panel: WorkspacePanelContext): TasksView => {
      requestUpdate = () => { panel.host.requestRender(); };
      const scope = scopeOf(panel);
      if (scope === undefined) return NO_TRANSCRIPT;
      reader.follow(scope, readKeyOf(panel));
      return reader.viewFor(scope.sessionFile);
    };

    /**
     * Rows that open (design-b3s3-v2 §4.4). Everything a row holds on this device is keyed by
     * machine, session transcript and task, so another session's rows show closed and never
     * another session's output. A Stop's note outlives the row's closing; a reload forgets it and
     * the list is the truth again.
     */
    const opened = new Set<string>();
    const stops = new Map<string, StopOutcome>();
    const wholeLogsReading = new Set<string>();
    const stopAllsInFlight = new Map<string, number>();
    /** An open running row reads again after a poll's wait, but only once this page is visible again. */
    const pollAfter = (ms: number): void => {
      setTimeout(() => {
        if (document.visibilityState === "visible") requestUpdate();
        else document.addEventListener("visibilitychange", () => { requestUpdate(); }, { once: true });
      }, ms);
    };
    const outputs = new TaskOutputReads((pollAgainInMs) => {
      requestUpdate();
      if (pollAgainInMs !== undefined) pollAfter(pollAgainInMs);
    });
    if (ui?.renderOutput !== undefined) defineTaskDetailElements();

    const rowControls = (panel: WorkspacePanelContext, scope: TaskScope): ListControls => {
      const renderOutput = ui?.renderOutput;
      const renderButton = ui?.renderButton;
      if (ui === undefined || renderOutput === undefined || renderButton === undefined || callOperation === undefined) return {};
      const rowUi: RowUi = { renderOutput, renderButton };
      const machineId = panel.machine.id;
      const sessionKey = JSON.stringify([machineId, scope.sessionFile]);
      const keyOf = (taskId: string): string => JSON.stringify([machineId, scope.sessionFile, taskId]);
      const readOutput = (taskId: string, tailBytes: number): Promise<unknown> =>
        callOperation("tasks.output", { cwd: scope.cwd, sessionFile: scope.sessionFile, taskId, tailBytes });
      const stopPending = (key: string): boolean => stops.has(key) && stops.get(key) === undefined;
      const session = panel.session;
      const stop = session === undefined ? undefined : (row: TaskRow): Promise<void> => {
        const key = keyOf(row.id);
        stops.set(key, undefined);
        requestUpdate();
        return session.runCommand({ sessionId: session.id, name: "kill", args: row.id })
          .catch(() => LOST_ANSWER)
          .then((outcome) => {
            stops.set(key, outcome);
            reader.forget();
            requestUpdate();
          });
      };
      const openWholeLog = (row: TaskRow, key: string): void => {
        wholeLogsReading.add(key);
        requestUpdate();
        void readOutput(row.id, WHOLE_LOG_BYTES).then(outputFrom, () => undefined).then((output) => {
          wholeLogsReading.delete(key);
          requestUpdate();
          const dialog = ui.showDialog({
            label: `${row.name} log`,
            presentation: "fullscreen",
            content: wholeLogContent(html, rowUi, {
              name: row.name,
              running: row.tone === "running",
              output: output ?? { read: "failed", text: "", totalBytes: 0, truncated: false },
              close: () => { dialog.close(); },
              closeIcon: ui.renderCloseIcon?.(),
            }),
          });
        });
      };
      const noteOf = (row: TaskRow, key: string): NoteLine | undefined => {
        const running = row.tone === "running";
        if (stops.has(key)) {
          const outcome = stops.get(key);
          return STOP_NOTE_LINE[stopNote(outcome, running)](outcome);
        }
        return running && stop === undefined ? STOP_NEEDS_NEWER_HOST : undefined;
      };
      const confirm = ui.confirm;
      return {
        expansion: (row) => {
          const key = keyOf(row.id);
          return {
            expanded: opened.has(key),
            onToggle: () => {
              if (opened.delete(key)) outputs.forget(key);
              else opened.add(key);
              requestUpdate();
            },
            body: () => {
              const running = row.tone === "running";
              outputs.refresh(key, running, Date.now(), () => readOutput(row.id, OUTPUT_TAIL_BYTES));
              return taskDetailBody(html, rowUi, {
                name: row.name,
                running,
                output: outputs.view(key),
                note: noteOf(row, key),
                wholeLog: { busy: wholeLogsReading.has(key), open: () => { if (!wholeLogsReading.has(key)) openWholeLog(row, key); } },
                stop: !running || stop === undefined ? undefined : { busy: stopPending(key), run: () => { if (!stopPending(key)) void stop(row); } },
              });
            },
          };
        },
        ...(stop === undefined || confirm === undefined ? {} : {
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
                tone: "danger",
              }).then((confirmed) => {
                if (!confirmed) return;
                const sends = running.filter((row) => !stopPending(keyOf(row.id)));
                stopAllsInFlight.set(sessionKey, (stopAllsInFlight.get(sessionKey) ?? 0) + sends.length);
                for (const row of sends) {
                  void stop(row).finally(() => {
                    stopAllsInFlight.set(sessionKey, (stopAllsInFlight.get(sessionKey) ?? 1) - 1);
                    requestUpdate();
                  });
                }
                requestUpdate();
              });
            },
          }),
        }),
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
          visible: (context) => context.state?.selectedSession !== undefined,
          badge: (panel) => {
            const running = viewOf(panel).tasks.filter((task) => task.status === "running").length;
            return running === 0 ? undefined : running;
          },
          render: (panel) => {
            const view = viewOf(panel);
            const scope = scopeOf(panel);
            return ui?.renderList === undefined
              ? html`<p class="muted">This list needs a newer PI WEB on this device.</p>`
              : ui.renderList(backgroundListModel(view.tasks, view.read, localClockTime, scope === undefined ? {} : rowControls(panel, scope)));
          },
        },
      ],
      messageRenderers: [
        {
          id: "message.background-task-notification",
          tag: "background-task-notification",
          render: (view) => html`<strong>Background task</strong><div>${noticeLabel(taskNotice(view.payload))}</div>`,
        },
      ],
      activityNotes: [
        {
          id: "activity.background-runs",
          order: 100,
          note: (activity) => backgroundRunNote(backgroundRunCountOf(activity.status)),
        },
      ],
    },
    };
  },
};

export default plugin;
