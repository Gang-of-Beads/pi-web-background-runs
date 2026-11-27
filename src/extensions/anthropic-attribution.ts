/** The second extension pi-background-tasks declares, loaded as that package loads it. */
// @ts-expect-error The dependency publishes its built extension without declarations.
export { default } from "pi-background-tasks/dist/extensions/anthropic-attribution.js";
