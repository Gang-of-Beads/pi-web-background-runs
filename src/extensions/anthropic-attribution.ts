/** The second extension pi-background-tasks declares, loaded as that package loads it. */
// @ts-expect-error The dependency publishes its built extension without declarations.
import anthropicAttribution from "pi-background-tasks/dist/extensions/anthropic-attribution.js";
import { unlessSeparate } from "../extension/separateInstall.js";

export default unlessSeparate(anthropicAttribution as (pi: never) => unknown, false);
