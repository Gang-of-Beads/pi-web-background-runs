import { rm } from "node:fs/promises";
import * as esbuild from "esbuild";

/**
 * PI WEB loads a plugin's browser module as-is, without an import map, so the browser entry is one
 * self-contained file. The server entry is loaded by the session daemon with Node's own loader and
 * is bundled the same way, so the package needs no runtime dependencies.
 */
await rm("dist", { recursive: true, force: true });
const shared = { bundle: true, format: "esm", target: "es2022", legalComments: "eof", logLevel: "info" };
await esbuild.build({ ...shared, entryPoints: ["src/pi-web-plugin.ts"], outfile: "dist/browser/pi-web-plugin.js", platform: "browser" });
await esbuild.build({ ...shared, entryPoints: ["src/server-plugin.ts"], outfile: "dist/server-plugin.js", platform: "node" });
