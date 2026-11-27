// src/extensions/anthropic-attribution.ts
import anthropicAttribution from "pi-background-tasks/dist/extensions/anthropic-attribution.js";

// src/extension/separateInstall.ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
var SEPARATE_INSTALL_WORDS = "pi-background-tasks is installed on its own as well as through pi-web-background-runs, which brings it. Remove the separate one: pi remove npm:pi-background-tasks";
function sourceOf(entry) {
  if (typeof entry === "string") return entry;
  const source = typeof entry === "object" && entry !== null ? Reflect.get(entry, "source") : void 0;
  return typeof source === "string" ? source : void 0;
}
function namesBackgroundTasks(source) {
  return /(^|[:/\\])pi-background-tasks(\.git)?(@[^/\\]*)?[/\\]?$/.test(source);
}
function packagesIn(settingsFile) {
  try {
    const packages = Reflect.get(JSON.parse(readFileSync(settingsFile, "utf8")), "packages");
    return Array.isArray(packages) ? packages : [];
  } catch {
    return [];
  }
}
function separateInstall(cwd = process.cwd(), agentDir = process.env["PI_CODING_AGENT_DIR"] ?? join(homedir(), ".pi", "agent")) {
  return [join(agentDir, "settings.json"), join(cwd, ".pi", "settings.json")].flatMap(packagesIn).some((entry) => {
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

// src/extensions/anthropic-attribution.ts
var anthropic_attribution_default = unlessSeparate(anthropicAttribution, false);
export {
  anthropic_attribution_default as default
};
