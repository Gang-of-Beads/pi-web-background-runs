# Changelog

## 0.2.0

- One install: the package now loads pi-background-tasks itself, as a dependency. **Remove a separately installed copy** (`pi remove npm:pi-background-tasks`). Until you do, the package leaves the tools to that copy, so nothing breaks, and each session start warns you to remove it; in PI WEB the warning stands above the Background list. The dependency is pinned to an exact version (2.6.10), so a newer pi-background-tasks arrives with a release of this package.
- With a PI WEB that has the extension bus (after 2.202611.10), the Background page takes the state of the session's tasks from the extension, through pi-background-tasks' own host interface, laid over the server part's read of the task records; an open row's command and output come the same way. Tasks the extension does not publish (from before the session's runtime last started, or older than its newest 50) are shown from their records as before.
- Stop goes through that interface too. It stops exactly the task the row names and says why when it cannot, where `/kill` answered "Unknown background task ID" for a task its registry no longer knew.
- A running Fusion run is counted in "N background runs" and listed as running. It names no process of its own, so it used to read "unknown" and was left out of the count; it is now checked by the pi process that runs it.
- Unchanged on older PI WEB releases, and for the running count and the whole log, which the server part still reads from the records and `ps`.
- Restart the session daemon after updating.

## 0.1.5

- Require plugin API alpha.10; a host without `session.runCommand` hides Stop instead of failing on the type.
- Ship the BSD-3 notice for the Lit the browser bundle inlines.

## 0.1.4

- A task still running on Android (Termux) is no longer listed under Finished as "ended · no exit code", and the Background count includes it again. The plugin checks a running task by its process's age, read with `ps -o etime=`, instead of its start time, read with `lstart`. On Android procps cannot read the boot time, so it printed every process as born in January 1970 and every live task read as ended. The elapsed time needs neither the boot time nor the C locale that 0.1.2 set for `lstart`.
- Restart the session daemon after updating: the plugin's server half runs there.

## 0.1.3

- A Background row opens: it shows the command the task actually ran, in a mono box with a copy key, then the end of its output with **Whole log** and **Stop**. Long commands wrap between words (a pipeline stage moves whole to the next line), a triple-click selects exactly the command, and a command over 4,096 characters is cut on a character boundary and says so when copied.
- A running row's elapsed time keeps counting on the page.
- The status words say what they know: "lost" reads "ended · no exit code" with why, "unknown" says the plugin could not tell whether the task still runs, and a missing output says only as much as is known. A running task with no recorded process reads unknown.
- A task is shown to its own session also when its registry directory is named after the session.
- Built against `@gang-of-beads/pi-web-plugin-api` 0.1.0-alpha.5. The plugin feature-detects every newer host member and keeps working on older PI WEB versions. Restart the session daemon after updating: the plugin's server half runs there.

## 0.1.2

- A running task is no longer shown as lost when the machine's `LC_TIME` is a non-English locale, such as `ar_AE.UTF-8` ([#1](https://github.com/Gang-of-Beads/pi-web-background-runs/issues/1)). The plugin now asks `ps` for a process's start time in the C locale, which it can read on Linux and macOS.
- A running task whose process cannot be checked is now shown as unknown instead of lost: lost means the process is gone or its pid now belongs to another process. On Windows, which has no `ps`, running tasks now show as unknown rather than lost. Unknown tasks are not counted as running.

## 0.1.1

- Built against `@gang-of-beads/pi-web-plugin-api`, the plugin contract package PI WEB publishes for plugin repositories, instead of the whole PI WEB package. Only the build changed: the published plugin code is the same as 0.1.0's.

## 0.1.0

- First release. The Background runs plugin moves out of PI WEB's bundled plugins into this repository, unchanged in behaviour: the Background tab, the running count in the activity line, and the task-ended notice row. The plugin id stays `background-runs`, so an existing `plugins.background-runs` setting keeps applying.
- Published to npm: install with `pi install npm:@gang-of-beads/pi-web-background-runs`.
