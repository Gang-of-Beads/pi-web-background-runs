# pi-web-background-runs

A [PI WEB](https://github.com/Gang-of-Beads/pi-web) plugin for [pi-background-tasks](https://www.npmjs.com/package/pi-background-tasks), the extension behind the `bg_run` tool.

- A **Background** tab beside the conversation lists the open session's background tasks with their state and how long they ran; its badge counts the running ones.
- The activity line under the conversation says how many background runs the session has going.
- A task's end notice (`background-task-notification`) is drawn as a short "Background task" row in the conversation.

## Requirements

- PI WEB 2.202610.5 or later. Earlier releases bundle their own copy of this plugin, which wins over an installed one (Settings → PI WEB plugins reports the duplicate id).
- The pi-background-tasks extension installed in pi.

## Install

```sh
pi install git:github.com/Gang-of-Beads/pi-web-background-runs
```

The plugin has a server part, so restart the PI WEB session daemon, then reload the PI WEB tab. To remove it, run `pi remove git:github.com/Gang-of-Beads/pi-web-background-runs` and restart the daemon again.

## How it works

The server part runs inside the PI WEB session daemon. It reads the registry pi-background-tasks keeps under the project folder (`.pi/tasks`), matches each task to the session that started it, and answers the browser's `tasks.list` operation. Once it has matched a task, it records the match in `.pi/tasks/attribution.json`, so the task stays with its session after compaction removes the transcript line that proved it. It declares the extension's directories (`.pi/tasks`, `.pi/delegate`), so while the plugin is on the daemon watches them to keep the running count current, and the Files and Git panels ignore their churn. The browser part draws the tab, the activity note and the notice row.

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

## License

[MIT](LICENSE)
