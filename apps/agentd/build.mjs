import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/**
 * Bundles the agent into one file: `node dist/agentd.mjs run`. No install step on the target
 * machine, no native modules, nothing to rebuild when Node changes.
 *
 * Two adapter files need care, and neither is edited:
 *  - `desktop-process-tree.ts` imports `koffi` for Windows Job Objects. macOS and Linux only need
 *    the POSIX half, so the import is swapped for `src/posix/desktop-process-tree.ts`.
 *  - `desktop-sandbox-win32-path.ts` is the same story, one layer down; it is stubbed out.
 * With both swapped the bundle has zero native dependencies.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");

const posixOnly = {
  name: "posix-only",
  setup(build) {
    const swaps = {
      "./desktop-process-tree.js": path.join(here, "src/posix/desktop-process-tree.ts"),
      "./desktop-sandbox-win32-path.js": path.join(here, "src/posix/desktop-sandbox-win32-path.ts"),
    };
    for (const [specifier, replacement] of Object.entries(swaps)) {
      build.onResolve({ filter: new RegExp(`^\\./${specifier.slice(2).replaceAll(".", "\\.")}$`) }, () => ({
        path: replacement,
      }));
    }
  },
};

// The workspace packages are consumed as source here, so the bundle does not need a link step.
const workspace = {
  "@rakazo/adapters/user-device-client": "packages/adapters/src/user-device-client.ts",
  "@rakazo/adapters/host-computer-runner": "packages/adapters/src/host-computer-runner.ts",
  "@rakazo/adapters/host-computer-protocol": "packages/adapters/src/host-computer-protocol.ts",
  "@rakazo/adapters/desktop-sandbox": "packages/adapters/src/desktop-sandbox.ts",
  "@rakazo/contracts/network-host": "packages/contracts/src/network-host.ts",
  "@rakazo/contracts": "packages/contracts/src/index.ts",
  "@rakazo/core": "packages/core/src/index.ts",
  "@rakazo/core/node/desktop-runtime": "packages/core/src/node/desktop-runtime.ts",
  "@rakazo/adapter-kit": "packages/adapter-kit/src/index.ts",
};

const alias = Object.fromEntries(
  Object.entries(workspace).map(([specifier, file]) => [specifier, path.join(repo, file)]),
);

const windows = process.argv.includes("--windows");

await build({
  entryPoints: [path.join(here, "src/cli.ts")],
  outfile: path.join(here, "dist/agentd.mjs"),
  absWorkingDir: repo,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  minify: false,
  legalComments: "none",
  logLevel: "info",
  // `ws` and friends are CommonJS and call `require` at runtime; in an ESM bundle that name does not
  // exist, so the bundle brings its own. Without this the first `require("events")` throws.
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);',
  },
  alias,
  plugins: windows ? [] : [posixOnly],
  define: { "process.env.RAKAZO_AGENTD": JSON.stringify("1") },
});
