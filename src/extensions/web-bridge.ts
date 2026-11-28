import type { PiEvents } from "../extension/hostClient.js";
import { SEPARATE_INSTALL_WORDS, separateInstall } from "../extension/separateInstall.js";
import { startWebBridge, type WebBridge } from "../extension/webBridge.js";

/** The part of pi's extension API the bridge uses. */
interface BridgeHost {
  readonly events: PiEvents;
  on(event: "session_start" | "session_shutdown", handler: () => void): void;
}

/**
 * Publishes this session's background tasks for PI WEB (see webBridge.ts). The task service answers
 * once its own session has started; whichever of the two extensions hears `session_start` first,
 * the service's `ready` frame makes the bridge read again.
 */
export default function webBridgeExtension(pi: BridgeHost): void {
  let bridge: WebBridge | undefined;
  pi.on("session_start", () => {
    /** One bridge for the extension's life: a second client under the same name would restart the lease's request numbering and be refused. */
    /** PI WEB shows a session-start warning only to a page attached at that moment, so the Background page carries it too. */
    bridge ??= startWebBridge(pi.events, undefined, separateInstall() ? SEPARATE_INSTALL_WORDS : undefined);
    bridge.refresh();
  });
  pi.on("session_shutdown", () => {
    bridge?.stop();
    bridge = undefined;
  });
}
