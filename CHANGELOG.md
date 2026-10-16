# Changelog

## 0.1.1

- Built against `@gang-of-beads/pi-web-plugin-api`, the plugin contract package PI WEB publishes for plugin repositories, instead of the whole PI WEB package. Only the build changed: the published plugin code is the same as 0.1.0's.

## 0.1.0

- First release. The Background runs plugin moves out of PI WEB's bundled plugins into this repository, unchanged in behaviour: the Background tab, the running count in the activity line, and the task-ended notice row. The plugin id stays `background-runs`, so an existing `plugins.background-runs` setting keeps applying.
- Published to npm: install with `pi install npm:@gang-of-beads/pi-web-background-runs`.
