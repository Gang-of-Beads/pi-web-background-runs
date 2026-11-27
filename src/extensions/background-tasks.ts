/**
 * The pi extension this package installs: pi-background-tasks, run from the dependency so its fixes
 * arrive with a version bump and never pass through a copy here.
 */
// @ts-expect-error The dependency publishes its built extension without declarations.
import backgroundTasks from "pi-background-tasks/dist/extensions/background-tasks.js";
import { unlessSeparate } from "../extension/separateInstall.js";

export default unlessSeparate(backgroundTasks as (pi: never) => unknown, true);
