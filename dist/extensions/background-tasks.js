// src/extensions/background-tasks.ts
import backgroundTasks from "pi-background-tasks/dist/extensions/background-tasks.js";

// src/extension/separateInstall.ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
var SEPARATE_INSTALL_WORDS = "pi-background-tasks is installed on its own as well as through pi-web-background-runs, which brings it. Remove the separate one: pi remove npm:pi-background-tasks";
function sourceOf(entry) {
  if (typeof entry === "string") return entry;
  if (typeof entry !== "object" || entry === null) return void 0;
  const extensions = Reflect.get(entry, "extensions");
  if (Array.isArray(extensions) && extensions.length === 0) return void 0;
  const source = Reflect.get(entry, "source");
  return typeof source === "string" ? source : void 0;
}
function namesBackgroundTasks(source) {
  return /(^|[:/\\])pi-background-tasks(\.git)?([/\\]|@.*)?$/.test(source);
}
function packagesIn(settingsFile) {
  try {
    const packages = Reflect.get(JSON.parse(readFileSync(settingsFile, "utf8")), "packages");
    return Array.isArray(packages) ? packages : [];
  } catch {
    return [];
  }
}
function separateInstall(agentDir = process.env["PI_CODING_AGENT_DIR"] || join(homedir(), ".pi", "agent")) {
  return packagesIn(join(agentDir, "settings.json")).some((entry) => {
    const source = sourceOf(entry);
    return source !== void 0 && namesBackgroundTasks(source);
  });
}
function unlessSeparate(extension, warn) {
  return (pi) => {
    if (!separateInstall()) return extension(pi);
    if (warn) pi.on("session_start", (_event, context) => {
      context.ui?.notify?.(SEPARATE_INSTALL_WORDS, "warning");
    });
    return void 0;
  };
}

// src/extensions/background-tasks.ts
var background_tasks_default = unlessSeparate(backgroundTasks, true);
export {
  background_tasks_default as default
};
