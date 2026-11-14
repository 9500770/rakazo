import type { MessageBlock } from "@rakazo/contracts";
import type { ToolStepOutcome } from "@rakazo/core";
import {
  appendTextSegment,
  appendToolCallSegment,
  createStreamingRedactor,
  endsSentence,
  isBackgroundRunTrigger,
  isConversationalRun,
  noteLastToolStep,
  redactSecrets,
  redactSecretsAfter,
  withToolStepOutcomes,
} from "@rakazo/core";
import type { Run } from "@rakazo/db";
import type { ExecutorDeps } from "./executor-deps.js";
import type { ReplyState, RunContext } from "./run-context.js";
import { publishMessage } from "./run-messages.js";
import {
  messageBlocksText,
  runAllowsSilentEmpty,
  runPromotesMidTurnNarration,
} from "./run-replies.js";
import { PAGE_BROWSER_TOOL_NAMES } from "./run-tool-selection.js";
import { couldBecomeNoResponse, isExactNoResponse, isPlaceholderText } from "./silent-reply.js";
import { USER_COMPUTER_SCREEN_TOOLS } from "./user-computer-tools.js";
import {
  clampUserProgressMessage,
  extractNarrationText,
  isUserProgressClientNonce,
  MID_TURN_PROGRESS_MIN_TURN_AGE_MS,
  midTurnProgressBudgetAllows,
  midTurnProgressBudgetUsed,
  narrationStatusLine,
  SILENT_WORK_REMINDERS_MAX_PER_RUN,
  silentLongWorkNote,
  USER_PROGRESS_MESSAGE_MAX_LENGTH,
  userProgressClientNonce,
} from "./user-progress.js";

/** A fresh reply that knows the progress messages earlier attempts of this run posted. */
export async function createReplyState(
  deps: ExecutorDeps,
  run: Run,
  secrets: string[],
): Promise<ReplyState> {
  const reply: ReplyState = {
    assembled: "",
    currentTextSegment: "",
    messageSegments: [],
    publishedTerminalSubagent: false,
    publishedMidTurnUserMessage: false,
    discardedMidTurnNarration: false,
    lastDiscardedMidTurnNarration: "",
    explicitNoResponse: false,
    assistantTurnText: "",
    midTurnUserTexts: [],
    midTurnProgressCount: 0,
    turnStartedAtMs: run.startedAt?.getTime() ?? Date.now(),
    lastDurablePostAtMs: run.startedAt?.getTime() ?? Date.now(),
    lastSilentWorkReminderAt: 0,
    silentWorkReminders: 0,
    progressBudgetStart: 0,
    steeringReplyPending: false,
    steeringResets: 0,
    lastSteeringResetAt: Number.NEGATIVE_INFINITY,
    workingNotes: [],
    textSinceLastStep: "",
    narrationSoFar: "",
    narrationStatusShowing: false,
    pendingToolNames: [],
    toolCalls: [],
    toolOutcomes: new Map(),
    toolStepCalls: new Map(),
    keptResultChars: 0,
    pendingProgress: "",
    lastProgressAt: 0,
    hasStreamedText: false,
    assistantTurnBreakPending: false,
    redactor: createStreamingRedactor(secrets),
  };
  const priorProgress = await deps.prisma.message.findMany({
    where: { runId: run.id, role: "bot" },
    orderBy: { seq: "asc" },
    select: { blocks: true, clientNonce: true },
  });
  for (const message of priorProgress) {
    if (!isUserProgressClientNonce(message.clientNonce)) continue;
    const blocks = Array.isArray(message.blocks) ? (message.blocks as MessageBlock[]) : [];
    const text = messageBlocksText(blocks).trim();
    if (!text) continue;
    reply.midTurnUserTexts.push(text);
    reply.publishedMidTurnUserMessage = true;
    reply.midTurnProgressCount += 1;
  }
  // A resumed turn reconnects with the person already briefed; silence counts from here.
  if (reply.midTurnProgressCount > 0) reply.lastDurablePostAtMs = Date.now();
  return reply;
}

export function recordExplicitNoResponse(reply: ReplyState, text: string) {
  reply.explicitNoResponse ||= isExactNoResponse(text) || /\bNO_RESPONSE\b/.test(text);
}

/** Durable interim messages only on genuinely long turns, capped per run. */
export function canPublishDurableProgress(reply: ReplyState) {
  return (
    reply.steeringReplyPending ||
    midTurnProgressBudgetAllows(progressSinceBudgetStart(reply), Date.now() - reply.turnStartedAtMs)
  );
}

/**
 * The first message_user of a conversational turn may acknowledge the plan at once, before
 * a long tool starts. Plain narration never takes this path: models write "Let me check"
 * before almost every tool, so it would post a bubble on every short turn. Later beats still
 * wait for the 60s / max-3 budget. Runs nobody is waiting on keep the fresh-turn rule.
 */
export function canPostFirstHeadsUp(ctx: RunContext) {
  const { reply } = ctx.state;
  return (
    reply.midTurnProgressCount === 0 &&
    isConversationalRun(ctx.run.trigger) &&
    !runAllowsSilentEmpty(ctx.run.trigger)
  );
}

export function progressSinceBudgetStart(reply: ReplyState) {
  return reply.midTurnProgressCount - reply.progressBudgetStart;
}

/** The next interim message's nonce; it uses up the allowance for answering the person. */
function nextProgressNonce(ctx: RunContext) {
  const { reply } = ctx.state;
  reply.steeringReplyPending = false;
  reply.lastDurablePostAtMs = Date.now();
  return userProgressClientNonce(ctx.run.id, reply.midTurnProgressCount++);
}

/**
 * Posts an interim message. A chat app gets a run's messages when the run ends, so a 1:1 run it
 * started sends this one on at once. A group run posts once, when it ends.
 */
export async function publishInterimMessage(ctx: RunContext, text: string, markUnread?: boolean) {
  const { deps, run } = ctx;
  const { reply } = ctx.state;
  await publishMessage(
    deps,
    run,
    "bot",
    [{ kind: "text", text }],
    markUnread,
    nextProgressNonce(ctx),
  );
  reply.midTurnUserTexts.push(text);
  reply.publishedMidTurnUserMessage = true;
  if (run.trigger === "messaging" && !ctx.source.channelId) {
    // Sent from here while the turn carries on; its rows' backup jobs cover a failed send.
    const delivery = deps.messagingDelivery;
    void delivery?.deliverRun(run.id, { progress: true }).catch((error) => {
      delivery.reportFailure("messaging progress delivery error", error);
    });
  }
}

/** Whether text written before a step may be posted as an interim message at all. */
export function narrationBecomesMessages(ctx: RunContext) {
  return ctx.replyMode === "chat" && runPromotesMidTurnNarration(ctx.run.trigger);
}

export function canPublishDurableNarration(ctx: RunContext) {
  return narrationBecomesMessages(ctx) && canPublishDurableProgress(ctx.state.reply);
}

/**
 * Attach a reminder whenever a conversational turn has left the person unheard-of for the
 * interim wait — not only before the first post, so a turn that acked once cannot grind on
 * in silence for the rest of its run. Silence since the last heard-from moment is the signal
 * because a tool's name does not say how long it runs; each reminder resets the quiet
 * stretch, and the per-run cap keeps a long computer session from being nagged forever.
 */
export function withSilentLongWorkReminder(ctx: RunContext, result: unknown): unknown {
  const { reply } = ctx.state;
  const now = Date.now();
  const sinceHeard = now - Math.max(reply.lastDurablePostAtMs, reply.lastSilentWorkReminderAt);
  if (
    typeof result !== "object" ||
    result === null ||
    Array.isArray(result) ||
    (result as { terminate?: unknown }).terminate === true ||
    !isConversationalRun(ctx.run.trigger) ||
    runAllowsSilentEmpty(ctx.run.trigger) ||
    ctx.tools.disabled.has("message_user") ||
    midTurnProgressBudgetUsed(progressSinceBudgetStart(reply)) ||
    reply.silentWorkReminders >= SILENT_WORK_REMINDERS_MAX_PER_RUN ||
    sinceHeard < MID_TURN_PROGRESS_MIN_TURN_AGE_MS
  ) {
    return result;
  }
  reply.silentWorkReminders += 1;
  reply.lastSilentWorkReminderAt = now;
  const note = silentLongWorkNote(sinceHeard);
  const record = result as { note?: unknown };
  if (typeof record.note === "string" && record.note.trim()) {
    return { ...record, note: `${record.note}\n${note}` };
  }
  return { ...record, note };
}

export function flushPendingTools(reply: ReplyState) {
  if (reply.currentTextSegment) {
    reply.messageSegments = appendTextSegment(reply.messageSegments, reply.currentTextSegment);
    reply.currentTextSegment = "";
  }
  for (const name of reply.pendingToolNames) {
    reply.messageSegments = appendToolCallSegment(reply.messageSegments, name);
  }
  reply.pendingToolNames = [];
}

/**
 * The reply's steps with how each call ended. Calls with no result yet count as `unfinished`
 * when given (a stopped run), otherwise they carry no outcome.
 */
export function withReplyToolOutcomes(
  reply: ReplyState,
  unfinished?: ToolStepOutcome,
): MessageBlock[] {
  return withToolStepOutcomes(
    reply.messageSegments,
    reply.toolCalls.map(({ label, executionId, tool }) => ({
      label,
      outcome: reply.toolOutcomes.get(executionId) ?? unfinished,
      tool,
      call: reply.toolStepCalls.get(executionId),
    })),
  );
}

export function tryFlushPendingTools(reply: ReplyState) {
  if (reply.pendingToolNames.length > 0 && endsSentence(reply.currentTextSegment))
    flushPendingTools(reply);
}

/**
 * A member a group message named nobody for may answer with the silence sentinel, so what it
 * has written stays unseen while that is still possible. Once the text turns into a reply it
 * all shows.
 */
export function progressHeldForSilence(ctx: RunContext) {
  const { reply } = ctx.state;
  return !reply.hasStreamedText && mayBeSilentEnding(ctx, reply.pendingProgress);
}

/** Text a member a group message named nobody for may still turn into its silent ending. */
export function mayBeSilentEnding(ctx: Pick<RunContext, "groupReplyOptional">, text: string) {
  return ctx.groupReplyOptional && (couldBecomeNoResponse(text) || isPlaceholderText(text));
}

export async function flushProgress(ctx: RunContext) {
  const { deps, run, runId, bot, thread } = ctx;
  const { reply } = ctx.state;
  // Routines may finish silently. Do not leak narration or a partial silence
  // sentinel before the final outcome is known.
  if (
    ctx.scripted ||
    !reply.pendingProgress ||
    run.trigger === "routine" ||
    isBackgroundRunTrigger(run.trigger) ||
    progressHeldForSilence(ctx)
  )
    return;
  await deps.events.append({
    spaceId: run.spaceId,
    threadId: thread.id,
    botId: bot.id,
    type: "thread.progress",
    runId,
    // The first flush replaces the "working…" placeholder outright — a delta here
    // would otherwise get appended straight onto it with no separator.
    payload: reply.hasStreamedText
      ? { delta: reply.pendingProgress, streaming: true }
      : { text: reply.pendingProgress, streaming: true },
  });
  reply.hasStreamedText = true;
  reply.pendingProgress = "";
  reply.lastProgressAt = Date.now();
}

/**
 * Text the bot wrote before a step. It is posted as an interim message when the budget allows
 * and it fits; otherwise it is a note on that step, kept out of the reply. Returns the note so
 * the caller can show it as the working line.
 */
export async function publishMidTurnNarration(ctx: RunContext, beforeConnectCard = false) {
  const { run } = ctx;
  const { reply } = ctx.state;
  const extracted = extractNarrationText(reply.messageSegments, reply.currentTextSegment);
  reply.messageSegments = extracted.remaining;
  reply.currentTextSegment = "";
  const text = redactSecretsAfter(reply.narrationSoFar, extracted.text, ctx.secrets).trim();
  reply.narrationSoFar += extracted.text;
  if (!text) return undefined;
  reply.assembled = "";
  reply.hasStreamedText = false;
  reply.pendingProgress = "";
  // Text the redactor still holds back belongs to the text just taken out.
  reply.redactor.skip();
  const promotes = runPromotesMidTurnNarration(run.trigger);
  if (
    text.length <= USER_PROGRESS_MESSAGE_MAX_LENGTH &&
    (canPublishDurableNarration(ctx) || (beforeConnectCard && narrationBecomesMessages(ctx)))
  ) {
    reply.workingNotes.length = 0;
    reply.narrationStatusShowing = false;
    await publishInterimMessage(ctx, text);
    return undefined;
  }
  reply.discardedMidTurnNarration = true;
  reply.lastDiscardedMidTurnNarration = clampUserProgressMessage(text);
  if (promotes && !ctx.allowSilentEmptyRun) {
    reply.workingNotes.push(text);
    flushPendingTools(reply);
    reply.messageSegments = noteLastToolStep(reply.messageSegments, text);
  }
  return text;
}

/**
 * Text the bot wrote before asking is what the person needs to answer, and a paused run
 * never reaches the final reply that would bring held notes back. Posts it whole, ahead of
 * the question.
 */
export async function publishNarrationBeforeAsk(ctx: RunContext) {
  const { run } = ctx;
  const { reply } = ctx.state;
  if (!runPromotesMidTurnNarration(run.trigger)) return;
  const extracted = extractNarrationText(reply.messageSegments, reply.currentTextSegment);
  const pending = redactSecretsAfter(reply.narrationSoFar, extracted.text, ctx.secrets).trim();
  reply.narrationSoFar += extracted.text;
  // Messages mode shows only the latest text, as at the end of a turn.
  const held =
    ctx.replyMode === "chat" ? reply.workingNotes : pending ? [] : reply.workingNotes.slice(-1);
  // Held notes were redacted against the secrets known when they were held; check them again.
  const text = redactSecrets([...held, pending].filter(Boolean).join("\n\n"), ctx.secrets);
  if (!text) return;
  reply.messageSegments = extracted.remaining;
  reply.currentTextSegment = "";
  reply.workingNotes.length = 0;
  reply.narrationStatusShowing = false;
  reply.assembled = "";
  reply.hasStreamedText = false;
  reply.pendingProgress = "";
  reply.redactor.skip();
  await publishInterimMessage(ctx, text);
}

/**
 * Replaces the text streamed so far with the note as the working line. Runs that hold their
 * narration back (routines, peers, background work) keep their live view.
 */
export async function showNarrationStatus(ctx: RunContext, note: string | undefined) {
  const { deps, run, runId, bot, thread } = ctx;
  if (
    !note ||
    ctx.scripted ||
    !runPromotesMidTurnNarration(run.trigger) ||
    isBackgroundRunTrigger(run.trigger)
  )
    return;
  ctx.state.reply.narrationStatusShowing = true;
  await deps.events.append({
    spaceId: run.spaceId,
    threadId: thread.id,
    botId: bot.id,
    type: "thread.progress",
    runId,
    payload: { reset: true, text: narrationStatusLine(note), activity: true },
  });
}
