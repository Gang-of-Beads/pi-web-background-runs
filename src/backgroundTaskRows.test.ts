import { describe, expect, it } from "vitest";
import { backgroundListModel, backgroundTaskList, byteSize, durationLabel, STOP_NOTE_LINE, stopNote, taskPresentation, type StopOutcome, type TaskInput, type TasksRead } from "./backgroundTaskRows";
import { outputFrom, OUTPUT_POLL_MS, TaskOutputReads } from "./tasksRead";

const task = (id: string, status: string, startedAt: string, extra: Partial<TaskInput> = {}): TaskInput => ({ id, name: `task ${id}`, status, startedAt, ...extra });

describe("taskPresentation", () => {
  const expected: Record<string, [string, string]> = {
    running: ["running", "running"],
    completed: ["done", "done"],
    failed: ["problem", "failed"],
    killed: ["problem", "stopped"],
    lost: ["problem", "lost"],
    unknown: ["unknown", "unknown"],
  };
  for (const [status, [tone, label]] of Object.entries(expected)) {
    it(`names ${status} as ${label}`, () => {
      expect(taskPresentation(status)).toEqual({ tone, label });
    });
  }

  it("says a status it has no word for rather than guessing one", () => {
    expect(taskPresentation("timeout")).toEqual({ tone: "unknown", label: "timeout" });
    expect(taskPresentation("")).toEqual({ tone: "unknown", label: "unknown" });
  });
});

describe("backgroundTaskList", () => {
  it("puts running work first and the rest newest first", () => {
    const list = backgroundTaskList([
      task("old", "completed", "2026-09-28T10:00:00Z"),
      task("live", "running", "2026-09-28T09:00:00Z"),
      task("new", "failed", "2026-09-28T11:00:00Z"),
    ]);
    expect(list.running.map((row) => row.id)).toEqual(["live"]);
    expect(list.finished.map((row) => row.id)).toEqual(["new", "old"]);
    expect(list.hiddenFinished).toBe(0);
  });

  it("cuts a long history to the newest rows and counts the rest instead of dropping them silently", () => {
    const tasks = Array.from({ length: 407 }, (_, index) => task(String(index), "completed", `2026-09-28T10:${String(index % 60).padStart(2, "0")}:00Z`));
    const list = backgroundTaskList(tasks, 30);
    expect(list.finished).toHaveLength(30);
    expect(list.hiddenFinished).toBe(377);
  });

  it("keeps the name and the status apart, with duration and exit code as the detail", () => {
    const [row] = backgroundTaskList([task("a", "failed", "2026-09-28T10:00:00Z", { durationMs: 125_000, exitCode: 1 })]).finished;
    expect(row).toMatchObject({ name: "task a", label: "failed", tone: "problem", detail: "2m 5s · exit 1" });
  });
});

describe("durationLabel", () => {
  it("reads seconds, minutes and hours", () => {
    expect(durationLabel(9_000)).toBe("9s");
    expect(durationLabel(65_000)).toBe("1m 5s");
    expect(durationLabel(3_720_000)).toBe("1h 2m");
    expect(durationLabel(undefined)).toBeUndefined();
    expect(durationLabel(-1)).toBeUndefined();
  });
});

describe("backgroundListModel", () => {
  const clock = (iso: string): string => iso.slice(11, 16);

  it("hands the host one group of running work and one of finished work", () => {
    const model = backgroundListModel([
      task("live", "running", "2026-09-28T09:00:00Z", { durationMs: 112_000 }),
      task("ok", "completed", "2026-09-28T08:38:00Z", { durationMs: 64_000, exitCode: 0 }),
      task("bad", "failed", "2026-09-28T08:35:00Z", { durationMs: 48_000, exitCode: 1 }),
      task("gone", "lost", "2026-09-28T08:30:00Z"),
      task("odd", "timeout", "2026-09-28T08:20:00Z"),
    ], "read", clock);
    expect(model.groups).toEqual([
      { id: "running", heading: "Running", rows: [{ id: "live", title: "task live", status: { label: "running", tone: "good" }, detail: "started 09:00 · 1m 52s" }] },
      { id: "finished", heading: "Finished", rows: [
        { id: "ok", title: "task ok", value: "exit 0", detail: "08:38 · 1m 4s" },
        { id: "bad", title: "task bad", status: { label: "exit 1", tone: "problem" }, detail: "08:35 · 48s" },
        { id: "gone", title: "task gone", status: { label: "lost", tone: "problem" }, detail: "08:30" },
        { id: "odd", title: "task odd", status: { label: "timeout", tone: "neutral" }, detail: "08:20" },
      ] },
    ]);
    expect(model.notes).toEqual([]);
  });

  it("names a read state for every page the session can show, and counts the runs it cuts", () => {
    const reads: [TasksRead, string][] = [["unread", "reading"], ["read", "ready"], ["failed", "failed"]];
    for (const [read, expected] of reads) expect(backgroundListModel([], read, clock).read).toBe(expected);
    expect(backgroundListModel([], "read", clock).words).toEqual({
      empty: "This session has started no background runs.",
      reading: "Reading this session's background runs…",
      failed: "This machine could not read the background runs.",
      stale: "Could not refresh - showing the last read.",
    });
    const many = Array.from({ length: 32 }, (_, index) => task(String(index), "completed", `2026-09-28T10:${String(index).padStart(2, "0")}:00Z`));
    expect(backgroundListModel(many, "read", clock).notes).toEqual(["2 older runs not shown"]);
  });
});

describe("backgroundListModel with rows that open", () => {
  const clock = (iso: string): string => iso.slice(11, 16);
  const tasks = [task("live", "running", "2026-09-28T09:00:00Z"), task("ok", "completed", "2026-09-28T08:00:00Z")];
  const body = (): string => "body";

  it("hands every row its expansion and puts Stop all beside Running", () => {
    const model = backgroundListModel(tasks, "read", clock, {
      expansion: (row) => ({ expanded: row.id === "live", onToggle: () => undefined, body }),
      stopAll: (running) => ({ id: "stop-all", label: `Stop ${String(running.length)}`, tone: "danger", run: () => undefined }),
    });
    expect(model.groups[0]?.headingAction?.label).toBe("Stop 1");
    expect(model.groups.flatMap((group) => group.rows.map((row) => row.expansion?.expanded))).toEqual([true, false]);
  });

  it("offers no Stop all while nothing runs", () => {
    const model = backgroundListModel([task("ok", "completed", "2026-09-28T08:00:00Z")], "read", clock, {
      stopAll: () => ({ id: "stop-all", label: "Stop all", run: () => undefined }),
    });
    expect(model.groups[0]).not.toHaveProperty("headingAction");
  });
});

describe("stopNote", () => {
  const ran = (...levels: ("info" | "warning" | "error")[]): StopOutcome => ({ kind: "ran", notices: levels.map((level) => ({ level, message: `${level} said` })) });
  const line = (outcome: StopOutcome, running: boolean) => STOP_NOTE_LINE[stopNote(outcome, running)](outcome);

  it("says what the extension said, in its tone", () => {
    expect(line(undefined, true)).toEqual({ words: "Stopping…", tone: "info" });
    expect(line(ran("warning", "info"), false)).toEqual({ words: "info said", tone: "info" });
    expect(line(ran("error"), true)).toEqual({ words: "error said", tone: "error" });
  });

  it("claims no success the list does not show", () => {
    expect(stopNote(ran(), true)).toBe("ran-still-running");
    expect(stopNote(ran(), false)).toBe("already-stopped");
    // A second device's Stop: the extension refuses a task that no longer runs.
    expect(stopNote(ran("error"), false)).toBe("already-stopped");
  });

  it("passes the host's refusal and names an answer that did not come", () => {
    expect(line({ kind: "refused", reason: "session-changed", words: "The session on screen changed." }, true)).toEqual({ words: "The session on screen changed.", tone: "error" });
    expect(stopNote({ kind: "waiting" }, true)).toBe("waiting");
    expect(stopNote({ kind: "unknown", words: "" }, true)).toBe("unknown");
  });
});

describe("byteSize", () => {
  it("says bytes, KiB and MiB", () => {
    expect(byteSize(900)).toBe("900 bytes");
    expect(byteSize(8 * 1024)).toBe("8 KiB");
    expect(byteSize(13_002_342)).toBe("12.4 MiB");
  });
});

describe("TaskOutputReads (tasksRead.ts)", () => {
  const answer = { known: true, text: "line\n", totalBytes: 5, truncated: false };

  it("reads an answer, a refusal and a failure apart", () => {
    expect(outputFrom(answer)).toEqual({ read: "ready", text: "line\n", totalBytes: 5, truncated: false });
    expect(outputFrom({ known: false, reason: "no-output-file" })).toMatchObject({ read: "failed", text: "", missing: "no-output-file" });
    expect(outputFrom({ known: false, reason: "something new" })).toBeUndefined();
  });

  it("reads a running row again after the poll's wait, a finished row once", async () => {
    let asked = 0;
    const polls: (number | undefined)[] = [];
    const reads = new TaskOutputReads((poll) => { polls.push(poll); });
    const ask = (): Promise<unknown> => { asked += 1; return Promise.resolve(answer); };

    reads.refresh("run", true, 0, ask);
    reads.refresh("run", true, 0, ask);
    await Promise.resolve();
    expect(asked).toBe(1);
    expect(polls).toEqual([OUTPUT_POLL_MS]);
    expect(reads.view("run").text).toBe("line\n");
    reads.refresh("run", true, Date.now() + OUTPUT_POLL_MS, ask);
    expect(asked).toBe(2);
    await Promise.resolve();

    // It finished: one more read, then none.
    reads.refresh("run", false, Date.now(), ask);
    await Promise.resolve();
    reads.refresh("run", false, Date.now() + 60_000, ask);
    expect(asked).toBe(3);
    expect(polls.at(-1)).toBeUndefined();
  });

  it("keeps the text on a failed read and drops a closed row's late answer", async () => {
    const reads = new TaskOutputReads(() => undefined);
    reads.refresh("row", true, 0, () => Promise.resolve(answer));
    await Promise.resolve();
    reads.refresh("row", true, Date.now() + OUTPUT_POLL_MS, () => Promise.reject(new Error("offline")));
    await Promise.resolve();
    await Promise.resolve();
    expect(reads.view("row")).toMatchObject({ read: "failed", text: "line\n" });

    reads.refresh("other", true, 0, () => Promise.resolve(answer));
    reads.forget("other");
    await Promise.resolve();
    expect(reads.view("other")).toMatchObject({ read: "reading", text: "" });
  });
});
