import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SEPARATE_INSTALL_WORDS = "pi-background-tasks is installed on its own as well as through pi-web-background-runs, which brings it. Remove the separate one: pi remove npm:pi-background-tasks";

function sourceOf(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (typeof entry !== "object" || entry === null) return undefined;
  /** `extensions: []` is pi's filter for "load none of its extensions": that copy takes no tools. */
  const extensions: unknown = Reflect.get(entry, "extensions");
  if (Array.isArray(extensions) && extensions.length === 0) return undefined;
  const source: unknown = Reflect.get(entry, "source");
  return typeof source === "string" ? source : undefined;
}

/** Whether a package source names pi-background-tasks itself: `npm:pi-background-tasks@2`, a git URL with any ref, or a folder that ends in it. */
export function namesBackgroundTasks(source: string): boolean {
  return /(^|[:/\\])pi-background-tasks(\.git)?([/\\]|@.*)?$/.test(source);
}

function packagesIn(settingsFile: string): readonly unknown[] {
  try {
    const packages: unknown = Reflect.get(JSON.parse(readFileSync(settingsFile, "utf8")) as object, "packages");
    return Array.isArray(packages) ? packages : [];
  } catch {
    return [];
  }
}

/**
 * Whether pi's settings also install pi-background-tasks on its own, as every installation from
 * before this package brought it does. Two copies in one session take each other's tools and
 * neither works (seen live: every `/bg` command gone, and an error that names no remedy). So this
 * package then leaves the tools to the separate copy and says what to remove.
 *
 * Only pi's own settings are read. A project's settings are not: an extension is not told its
 * session's folder when it loads, and stepping aside for a copy that is not loaded leaves no tools at
 * all, which is worse than the conflict a missed copy gives.
 */
export function separateInstall(agentDir: string = process.env["PI_CODING_AGENT_DIR"] || join(homedir(), ".pi", "agent")): boolean {
  return packagesIn(join(agentDir, "settings.json"))
    .some((entry) => { const source = sourceOf(entry); return source !== undefined && namesBackgroundTasks(source); });
}

interface Host {
  on(event: "session_start", handler: (event: unknown, context: { readonly ui?: { notify?(words: string, level: "warning"): void } }) => void): void;
}

/** The dependency's extension, unless a separate copy is installed: then a warning on every session start instead. */
export function unlessSeparate<P extends Host>(extension: (pi: P) => unknown, warn: boolean): (pi: P) => unknown {
  return (pi) => {
    if (!separateInstall()) return extension(pi);
    if (warn) pi.on("session_start", (_event, context) => { context.ui?.notify?.(SEPARATE_INSTALL_WORDS, "warning"); });
    return undefined;
  };
}
