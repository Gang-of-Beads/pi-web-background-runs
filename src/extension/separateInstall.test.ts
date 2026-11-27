import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { namesBackgroundTasks, separateInstall } from "./separateInstall.js";

describe("a separate pi-background-tasks", () => {
  it("is known by its package source, not by this package's", () => {
    expect(["npm:pi-background-tasks", "npm:pi-background-tasks@2.6.10", "git:github.com/ismailsaleekh/pi-background-tasks", "/opt/x/pi-background-tasks/", "npm:@gang-of-beads/pi-web-background-runs", "npm:pi-background-tasks-extra"].map(namesBackgroundTasks))
      .toEqual([true, true, true, true, false, false]);
  });

  it("is found in pi's own settings or the project's", () => {
    const dir = mkdtempSync(join(tmpdir(), "separate-"));
    const settings = (name: string, packages: unknown): string => {
      const agentDir = join(dir, name);
      mkdirSync(join(agentDir, ".pi"), { recursive: true });
      writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages }));
      writeFileSync(join(agentDir, ".pi", "settings.json"), JSON.stringify({ packages }));
      return agentDir;
    };
    const both = settings("both", ["npm:@gang-of-beads/pi-web-background-runs", { source: "npm:pi-background-tasks" }]);
    const alone = settings("alone", ["npm:@gang-of-beads/pi-web-background-runs"]);
    expect([separateInstall(alone, both), separateInstall(both, alone), separateInstall(alone, alone), separateInstall(join(dir, "none"), join(dir, "none"))]).toEqual([true, true, false, false]);
  });
});
