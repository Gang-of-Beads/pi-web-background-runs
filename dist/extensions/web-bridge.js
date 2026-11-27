// src/extension/hostClient.ts
var HOST_REQUEST_CHANNEL = "pi-background-tasks:host:request:v1";
var HOST_RESPONSE_CHANNEL = "pi-background-tasks:host:response:v1";
var HOST_CHANGED_CHANNEL = "pi-background-tasks:host:changed:v1";
var REQUEST_SCHEMA = "pi-background-tasks.host-request.v1";
var ANSWER_TIMEOUT_MS = 15e3;
var HostRefusal = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "HostRefusal";
  }
  code;
};
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
var BackgroundTaskHostClient = class {
  constructor(events, clientId, timeoutMs = ANSWER_TIMEOUT_MS) {
    this.events = events;
    this.clientId = clientId;
    this.timeoutMs = timeoutMs;
  }
  events;
  clientId;
  timeoutMs;
  lease;
  leasing;
  requests = 0;
  /** The change feed: `ready`, `changed` or `closed`, each a reason to read again or to stop. */
  onChanged(listener) {
    return this.events.on(HOST_CHANGED_CHANNEL, (frame) => {
      const kind = isRecord(frame) ? frame["kind"] : void 0;
      if (kind === "closed" || kind === "ready") this.forgetLease();
      if (typeof kind === "string") listener(kind);
    });
  }
  /** The service closed or started again: its lease is gone with it. */
  forgetLease() {
    this.lease = void 0;
    this.leasing = void 0;
  }
  list(limit) {
    return this.leased("list", { limit });
  }
  stop(taskId) {
    return this.leased("stop", { taskId });
  }
  logs(taskId, maxBytes) {
    return this.leased("logs", { taskId, maxBytes, tail: true });
  }
  detail(taskId) {
    return this.leased("detail", { taskId });
  }
  /** A leased operation; a lease the service no longer knows is taken again, once. */
  async leased(operation, payload, retried = false) {
    const lease = await this.currentLease();
    lease.sequence += 1;
    try {
      return await this.ask(operation, { ...payload, leaseId: lease.leaseId, activationId: lease.activationId, sequence: lease.sequence });
    } catch (error) {
      const stale = error instanceof HostRefusal && (error.code === "LEASE_INVALID" || error.code === "ACTIVATION_MISMATCH");
      if (!stale || retried) throw error;
      this.forgetLease();
      return this.leased(operation, payload, true);
    }
  }
  currentLease() {
    if (this.lease !== void 0) return Promise.resolve(this.lease);
    this.leasing ??= this.ask("subscribe", { clientId: this.clientId }).then((result) => {
      if (!isRecord(result) || typeof result["leaseId"] !== "string" || typeof result["activationId"] !== "string") throw new HostRefusal("NO_ANSWER", "The background task service did not grant a lease.");
      this.lease = { leaseId: result["leaseId"], activationId: result["activationId"], sequence: 0 };
      return this.lease;
    }).finally(() => {
      this.leasing = void 0;
    });
    return this.leasing;
  }
  ask(operation, payload) {
    this.requests += 1;
    const requestId = `${this.clientId}-${String(Date.now())}-${String(this.requests)}`;
    return new Promise((resolve, reject) => {
      const settle = (run) => {
        clearTimeout(timer);
        stopListening();
        run();
      };
      const timer = setTimeout(() => {
        settle(() => {
          reject(new HostRefusal("NO_ANSWER", `The background task service did not answer ${operation}.`));
        });
      }, this.timeoutMs);
      timer.unref();
      const stopListening = this.events.on(HOST_RESPONSE_CHANNEL, (frame) => {
        if (!isRecord(frame) || frame["request_id"] !== requestId) return;
        const error = frame["error"];
        if (frame["ok"] === true) settle(() => {
          resolve(frame["result"]);
        });
        else settle(() => {
          reject(new HostRefusal(isRecord(error) && typeof error["code"] === "string" ? error["code"] : "OPERATION_FAILED", isRecord(error) && typeof error["message"] === "string" ? error["message"] : "The background task service refused."));
        });
      });
      this.events.emit(HOST_REQUEST_CHANNEL, { schema_version: REQUEST_SCHEMA, request_id: requestId, operation, payload });
    });
  }
};

// src/extension/webBridge.ts
var TASKS_CHANNEL = "background-runs:tasks";
var STOP_CHANNEL = "background-runs:stop";
var OUTPUT_CHANNEL = "background-runs:output";
var LISTED = 50;
var OUTPUT_BYTES = 8192;
var ANSWER_JSON_BYTES = 6e4;
var CLOCK_CHANNEL = "background-runs:clock";
var SESSION_STATES_CHANNEL = "piweb:states:background-runs";
function fitted(answer) {
  let text = answer.text;
  while (text !== "" && Buffer.byteLength(JSON.stringify({ ...answer, text })) > ANSWER_JSON_BYTES) text = text.slice(Math.ceil(text.length / 4));
  return text === answer.text ? answer : { ...answer, text, truncated: true };
}
function uncheckedRunsState(views) {
  const count = views.filter((view) => isRecord2(view) && isRecord2(view["task"]) && view["task"]["status"] === "running" && typeof view["task"]["pid"] !== "number").length;
  return count === 0 ? [] : [{ id: "unchecked-runs", label: count === 1 ? "1 managed run" : `${String(count)} managed runs`, tone: "accent", busy: true, count }];
}
var COMMAND_CHARS = 4096;
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function publishedTask(view, now) {
  const task = isRecord2(view) ? view["task"] : void 0;
  if (!isRecord2(view) || !isRecord2(task) || typeof task["id"] !== "string" || typeof task["status"] !== "string") return void 0;
  const name = typeof task["name"] === "string" && task["name"] !== "" ? task["name"].slice(0, 80) : typeof task["command"] === "string" ? task["command"].slice(0, 80) : task["id"];
  const startTime = typeof task["startTime"] === "number" ? task["startTime"] : void 0;
  const endTime = typeof task["endTime"] === "number" ? task["endTime"] : void 0;
  return {
    id: task["id"],
    name,
    status: task["status"],
    ...typeof view["kind"] === "string" ? { kind: view["kind"] } : {},
    ...startTime === void 0 ? {} : { startedAt: new Date(startTime).toISOString(), durationMs: Math.max(0, (endTime ?? now) - startTime) },
    ...typeof task["exitCode"] === "number" ? { exitCode: task["exitCode"] } : {}
  };
}
function busRequest(data) {
  return isRecord2(data) ? { id: data["id"], input: data["input"] } : void 0;
}
function tailBytesOf(input) {
  const bytes = isRecord2(input) ? input["tailBytes"] : void 0;
  return typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 1 ? Math.min(Math.floor(bytes), OUTPUT_BYTES) : OUTPUT_BYTES;
}
function taskIdOf(input) {
  const id = isRecord2(input) ? input["id"] : void 0;
  return typeof id === "string" && id !== "" ? id : void 0;
}
function startWebBridge(events, now = Date.now) {
  const host = new BackgroundTaskHostClient(events, "pi-web-background-runs");
  let reading = false;
  let again = false;
  let stopped = false;
  const publish = async () => {
    if (stopped) return;
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    try {
      const listed = await host.list(LISTED);
      const views = isRecord2(listed) && Array.isArray(listed["tasks"]) ? listed["tasks"] : [];
      const at = now();
      const tasks = views.flatMap((view) => {
        const task = publishedTask(view, at);
        return task === void 0 ? [] : [task];
      });
      if (stopped) return;
      events.emit(SESSION_STATES_CHANNEL, uncheckedRunsState(views));
      events.emit(TASKS_CHANNEL, { tasks, more: isRecord2(listed) && typeof listed["nextCursor"] === "string" });
    } catch {
    } finally {
      reading = false;
      if (again) {
        again = false;
        void publish();
      }
    }
  };
  const answer = (channel, handle) => events.on(`${channel}:request`, (data) => {
    const request = busRequest(data);
    if (request === void 0) return;
    const taskId = taskIdOf(request.input);
    const reply = (body) => {
      events.emit(`${channel}:response`, { id: request.id, ...body });
    };
    if (taskId === void 0) {
      reply({ error: "A task id is needed." });
      return;
    }
    handle(taskId, request.input).then((result) => {
      reply({ result });
    }, (error) => {
      reply({ error: error instanceof HostRefusal ? `${error.code}: ${error.message}` : "The background task service failed." });
    });
  });
  const unsubscribes = [
    host.onChanged((kind) => {
      if (kind !== "closed") void publish();
    }),
    answer(STOP_CHANNEL, async (taskId) => {
      await host.stop(taskId);
      void publish();
      return { stopped: true };
    }),
    answer(OUTPUT_CHANNEL, async (taskId, input) => {
      const logs = await host.logs(taskId, tailBytesOf(input));
      const task = isRecord2(logs) && isRecord2(logs["task"]) ? logs["task"] : {};
      const command = typeof task["command"] === "string" ? task["command"] : "";
      return fitted({
        text: isRecord2(logs) && typeof logs["text"] === "string" ? logs["text"] : "",
        totalBytes: isRecord2(logs) && typeof logs["totalBytes"] === "number" ? logs["totalBytes"] : 0,
        truncated: isRecord2(logs) && logs["truncated"] === true,
        command: command.slice(0, COMMAND_CHARS),
        commandCut: command.length > COMMAND_CHARS
      });
    }),
    /** The machine's clock, so a page on another device counts a running task's time on it. */
    events.on(`${CLOCK_CHANNEL}:request`, (data) => {
      const request = busRequest(data);
      if (request !== void 0) events.emit(`${CLOCK_CHANNEL}:response`, { id: request.id, result: { now: now() } });
    })
  ];
  return {
    refresh: () => {
      void publish();
    },
    stop: () => {
      stopped = true;
      for (const unsubscribe of unsubscribes) unsubscribe();
    }
  };
}

// src/extensions/web-bridge.ts
function webBridgeExtension(pi) {
  let bridge;
  pi.on("session_start", () => {
    bridge ??= startWebBridge(pi.events);
    bridge.refresh();
  });
  pi.on("session_shutdown", () => {
    bridge?.stop();
    bridge = void 0;
  });
}
export {
  webBridgeExtension as default
};
