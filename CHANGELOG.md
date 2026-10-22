# Changelog

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
