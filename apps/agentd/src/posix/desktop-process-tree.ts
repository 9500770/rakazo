import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";

/**
 * Drop-in for `packages/adapters/src/desktop-process-tree.ts` on macOS and Linux, with the Windows
 * Job Object code (and its `koffi` native module) left out. `build.mjs` remaps the import at bundle
 * time, so the adapter source stays untouched.
 *
 * A command gets its own process group (`detached`), which is what makes the whole tree killable:
 * a `kill(-pid)` reaches every descendant, including shells that outlive the command they started.
 */
export interface NativeProcessTree {
  alive(): boolean;
  kill(): void;
  close(): void;
}

export function spawnOwnedCommand(
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): {
  child: ChildProcessWithoutNullStreams;
  tree: NativeProcessTree;
} {
  if (process.platform === "win32")
    throw new Error("This agent build runs on macOS and Linux only");
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd,
    env,
    detached: true,
    shell: false,
    windowsHide: true,
  });
  const pid = child.pid;
  let tree: NativeProcessTree;
  try {
    tree = {
      alive() {
        if (!pid) return false;
        try {
          process.kill(-pid, 0);
          return true;
        } catch {
          return false;
        }
      },
      kill() {
        if (!pid) return;
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      },
      close() {},
    };
  } catch (error) {
    child.on("error", () => undefined);
    child.kill("SIGKILL");
    throw error;
  }
  child.stdin.on("error", () => undefined);
  return { child, tree };
}
