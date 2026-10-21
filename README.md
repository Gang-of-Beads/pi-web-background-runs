# pi-web-background-runs

A [PI WEB](https://github.com/Gang-of-Beads/pi-web) plugin for [pi-background-tasks](https://www.npmjs.com/package/pi-background-tasks), the extension behind the `bg_run` tool.

- A **Background** tab beside the conversation lists the open session's background tasks with their state and how long they ran; its badge counts the running ones.
- A task's row opens to the command it runs, four lines at most with its own scroll, with a key that copies it (a command over 4,096 characters is shown and copied only that far, and the key says so), and the end of its output, which follows a running task every two seconds while the tab is on screen. **Whole log** shows the last 1 MiB of the output on the whole screen and says when it is cut. Under the output the row says how much of it is shown, and a finished task's exit code. A task whose process ended without recording an exit code reads "ended · no exit code", and one where PI WEB cannot tell whether it still runs (its process could not be checked, or its record names none) reads "unknown"; opening either row says what that means. **Stop** on a running task sends the extension's `/kill <id>` to the session at once and shows the extension's answer on the row; **Stop all** beside "Running" asks first, then stops every running task.
- The activity line under the conversation says how many background runs the session has going.
- A task's end notice (`background-task-notification`) is drawn as a short "Background task" row in the conversation.

## Requirements

- PI WEB 2.202610.5 or later. Earlier releases bundle their own copy of this plugin, which wins over an installed one (Settings → PI WEB plugins reports the duplicate id).
- Rows that open need a PI WEB whose plugin API has `ui.renderOutput` (plugin API 0.1.0-alpha.6); older releases show the rows without opening them. Stop and Stop all also need a PI WEB that lets a plugin run the session commands it declares; without it an open running row says "Stop needs a newer PI WEB on this machine."
- The pi-background-tasks extension installed in pi.

## Install

```sh
pi install npm:@gang-of-beads/pi-web-background-runs
```

To follow `main` instead of releases, install `git:github.com/Gang-of-Beads/pi-web-background-runs`.

The plugin has a server part, so restart the PI WEB session daemon, then reload the PI WEB tab. Restart the daemon after an update too: an update that changes the server part does not take effect on a tab reload. To remove it, run `pi remove npm:@gang-of-beads/pi-web-background-runs` and restart the daemon again.

## How it works

The server part runs inside the PI WEB session daemon. It reads the registry pi-background-tasks keeps under the project folder (`.pi/tasks`), matches each task to the session that started it, and answers the browser's `tasks.list` operation. Its `tasks.output` operation answers for one of the session's tasks with its command (the first 4,096 characters) and the end of its output file (8 KiB for an open row, 1 MiB for the Whole log), cut at a line start; it reads only tasks the session owns and only files under `.pi/tasks`. Once it has matched a task, it records the match in `.pi/tasks/attribution.json`, so the task stays with its session after compaction removes the transcript line that proved it. It declares the extension's directories (`.pi/tasks`, `.pi/delegate`), so while the plugin is on the daemon watches them to keep the running count current, and the Files and Git panels ignore their churn. The browser part draws the tab, the activity note and the notice row. The package declares `kill` in `piWeb.plugins[].sessionCommands`, so PI WEB lets the tab run `/kill <id>` in the session on screen and shows the declaration on the plugin's card in Settings.

## Development

```sh
npm install
npm run check
```

`npm run check` type-checks, runs the tests, and builds two bundles with esbuild: `dist/browser/pi-web-plugin.js` for the page and `dist/server-plugin.js` for the daemon. `dist/` is committed so that `pi install git:` works without a build step, and the check fails when it is out of date.

To try a change in a running PI WEB, link the working copy as a local plugin, restart the session daemon and reload the tab:

```sh
mkdir -p ~/.pi-web/plugins
ln -s "$PWD" ~/.pi-web/plugins/background-runs
```

See [PI WEB's plugin documentation](https://github.com/Gang-of-Beads/pi-web/blob/main/docs/plugins.md) for the plugin contract.

## Contributing

Issues and pull requests are welcome. Please keep changes small and focused, run `npm run check` before opening a pull request, and describe what you changed and how you checked it in a running PI WEB.

## Releasing

Update `version` in `package.json` and `package-lock.json`, give `CHANGELOG.md` a section for it, commit, and push a matching `v<version>` tag. The release workflow checks the package, publishes it to npm, and creates the GitHub Release from that CHANGELOG section.

## License

[MIT](LICENSE)
