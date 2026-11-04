import type { ProcessEvent } from "@rakazo/adapter-kit";
import { backgroundCommandCeilingMs, redactSecrets } from "@rakazo/core";
import { redactShellStreams } from "./agent-environment.js";
import { automated } from "./automated-messages.js";
import { shortenPlainText } from "./context-selection.js";
import { TOOL_RESULT_TEXT_LIMIT } from "./pi-runtime-limits.js";

/**
 * Device-code logins print a code and then wait. Once that output goes quiet,
 * return it while the process is still running so the bot can show the code.
 * Fast commands that exit inside this window are unchanged.
 */
export const SHELL_STREAM_IDLE_MS = 1_000;

/**
 * How long a still-silent command may run before observation hands it off as
 * still running. After the first real chunk, {@link SHELL_STREAM_IDLE_MS} applies.
 */
export const SHELL_STREAM_STARTUP_SILENCE_MS = 20_000;

export const SHELL_STILL_RUNNING_NOTICE =
  "Still running. Tell the user any one-time code or sign-in URL in the output.";

export interface ShellCommandSnapshot {
  stdout: string;
  stderr: string;
}

export interface FinishedShellCommand extends ShellCommandSnapshot {
  code: number;
}

export interface RunningShellCommand extends ShellCommandSnapshot {
  code: null;
  running: true;
}

export type ShellCommandResult = FinishedShellCommand | RunningShellCommand;

export function isRunningShellCommand(result: unknown): result is RunningShellCommand {
  return (
    !!result &&
    typeof result === "object" &&
    (result as { running?: unknown }).running === true &&
    (result as { code?: unknown }).code === null
  );
}

export function formatFinishedShellCommand(result: FinishedShellCommand): string {
  // Delivered in the user's role after the turn, so marked as automated: models took
  // finished console output for the user replying.
  const parts = [automated("Shell command finished."), `exit code: ${result.code}`];
  if (result.stdout) parts.push(`stdout:\n${keepHeadAndTail(result.stdout)}`);
  if (result.stderr) parts.push(`stderr:\n${keepHeadAndTail(result.stderr)}`);
  return parts.join("\n");
}

// Build and install failures print last, so keep the tail as well as the head.
function keepHeadAndTail(text: string): string {
  return text.length > TOOL_RESULT_TEXT_LIMIT
    ? shortenPlainText(text, TOOL_RESULT_TEXT_LIMIT)
    : text;
}

/**
 * After the turn that first saw a still-running shell, wait for those commands
 * to exit and hand the bot the final output. The turn that received the live
 * output is skipped so the bot can relay a device code before the process ends.
 * The wait is bounded by the background ceiling; a batch that outlives it goes
 * back to the front of the queue for the next turn boundary.
 */
export async function deliverFinishedShells(
  followUp: (text: string) => void,
  pending: Array<Promise<FinishedShellCommand>>,
  turn: { toolResults: Array<{ toolName?: string; details?: unknown }> },
  signal?: AbortSignal,
): Promise<void> {
  if (pending.length === 0 || turnReturnedRunningShell(turn)) return;
  const batch = pending.splice(0, pending.length);
  // The sandbox kills a backgrounded command at the ceiling, so completions land by
  // then; this race only guards a provider whose kill timer never fires.
  let ceilingTimer: ReturnType<typeof setTimeout> | undefined;
  const ceilingReached = new Promise<true>((resolve) => {
    ceilingTimer = setTimeout(() => resolve(true), backgroundCommandCeilingMs(process.env));
  });
  let results: Array<FinishedShellCommand | undefined> | undefined;
  try {
    const outcome = await Promise.race([
      Promise.all(batch.map((completion) => finishOrAbort(completion, signal))),
      ceilingReached,
    ]);
    if (Array.isArray(outcome)) results = outcome;
  } finally {
    clearTimeout(ceilingTimer);
  }
  if (!results) {
    pending.unshift(...batch);
    return;
  }
  const texts = results.filter((result): result is FinishedShellCommand => result !== undefined);
  if (texts.length === 0) return;
  followUp(texts.map((result) => formatFinishedShellCommand(result)).join("\n\n"));
}

function turnReturnedRunningShell(turn: {
  toolResults: Array<{ toolName?: string; details?: unknown }>;
}): boolean {
  return turn.toolResults.some(
    (result) =>
      (result.toolName === "shell" || result.toolName === "user_computer_shell") &&
      isRunningShellCommand(result.details),
  );
}

async function finishOrAbort(
  completion: Promise<FinishedShellCommand>,
  signal?: AbortSignal,
): Promise<FinishedShellCommand | undefined> {
  if (signal?.aborted) return undefined;
  const settled = completion.then(
    (result) => result,
    (error: unknown) => ({
      stdout: "",
      stderr: error instanceof Error ? error.message : "command failed",
      code: 1,
    }),
  );
  if (!signal) return settled;
  return Promise.race([
    settled,
    new Promise<undefined>((resolve) => {
      if (signal.aborted) {
        resolve(undefined);
        return;
      }
      signal.addEventListener("abort", () => resolve(undefined), { once: true });
    }),
  ]);
}

/**
 * Read a command stream. When output arrives and then stays quiet, return it
 * before exit and keep collecting the rest on `completion`. A command that stays
 * silent for the startup window is handed off the same way without being killed.
 */
export async function observeShellCommand(
  events: AsyncIterable<ProcessEvent>,
  options: {
    secrets: string[];
    idleMs?: number;
    startupSilenceMs?: number;
    onOutput?: (snapshot: ShellCommandSnapshot) => void;
  },
): Promise<{
  result: ShellCommandResult;
  completion?: Promise<FinishedShellCommand>;
}> {
  const idleMs = options.idleMs ?? SHELL_STREAM_IDLE_MS;
  const startupSilenceMs = options.startupSilenceMs ?? SHELL_STREAM_STARTUP_SILENCE_MS;
  let stdout = "";
  let stderr = "";
  let code: number | undefined;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveIdle: ((reason: "idle" | "done") => void) | undefined;
  const idlePromise = new Promise<"idle" | "done">((resolve) => {
    resolveIdle = resolve;
  });

  const redact = (snapshot: ShellCommandSnapshot, withholdPartial: boolean): ShellCommandSnapshot =>
    redactShellStreams(snapshot, options.secrets, { withholdPartial });

  const clearIdle = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  const armIdle = (ms: number) => {
    clearIdle();
    if (ms <= 0) {
      resolveIdle?.("idle");
      return;
    }
    timer = setTimeout(() => resolveIdle?.("idle"), ms);
  };

  // Silent commands must not wait for the sandbox kill timeout; hand off after this window.
  armIdle(startupSilenceMs);

  const done = (async (): Promise<FinishedShellCommand> => {
    try {
      for await (const event of events) {
        if (event.type === "stdout") stdout += event.data;
        else if (event.type === "stderr") stderr += event.data;
        else if (event.type === "exit") {
          code = event.code;
          break;
        } else continue;
        const published = redact({ stdout, stderr }, true);
        try {
          options.onOutput?.(published);
        } catch {
          // Live output is a view. A failed update must not kill the command.
        }
        if (stdout.length > 0 || stderr.length > 0) armIdle(idleMs);
      }
    } catch (error) {
      // Providers may include command environment values in errors. Never expose the raw
      // error or its cause to runtime tool handling or a background completion observer.
      throw new Error(
        redactSecrets(error instanceof Error ? error.message : String(error), options.secrets),
      );
    } finally {
      clearIdle();
      finished = true;
      resolveIdle?.("done");
    }
    return { ...redact({ stdout, stderr }, false), code: code ?? 0 };
  })();

  const reason = await Promise.race([
    idlePromise,
    done.then(
      () => "done" as const,
      () => "done" as const,
    ),
  ]);
  if (reason === "done" || finished || code !== undefined) {
    return { result: await done };
  }
  return {
    // The process is still running, so an unfinished secret prefix stays out of the
    // tool result. The completion publishes the rest once the command exits.
    result: { ...redact({ stdout, stderr }, true), code: null, running: true },
    completion: done,
  };
}
