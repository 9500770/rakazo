import type { MessageBlock } from "@rakazo/contracts";
import { isToolActivityBlock } from "@rakazo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import {
  canPostLongTaskHeadsUp,
  canPublishDurableNarration,
  withSilentLongWorkReminder,
} from "./run-progress.js";
import { ANSWER_BEFORE_ASK, longWorkProgressGuidance } from "./run-replies.js";
import {
  assistantTurnSeparator,
  botMessageOutcomeFromMidTurn,
  clampUserProgressMessage,
  extractNarrationText,
  finalBlocksAfterMidTurnProgress,
  isLongWorkTool,
  isProgressMessageTruncated,
  isUserProgressClientNonce,
  MID_TURN_PROGRESS_BUDGET_USED_NOTE,
  MID_TURN_PROGRESS_MAX_PER_RUN,
  MID_TURN_PROGRESS_MIN_TURN_AGE_MS,
  messageUserMaxLength,
  midTaskMessagePrompt,
  midTurnProgressBudgetAllows,
  midTurnProgressTooSoonNote,
  NARRATION_STATUS_MAX_LENGTH,
  narrationStatusLine,
  SILENT_LONG_WORK_HEADS_UP_NOTE,
  USER_PROGRESS_MESSAGE_MAX_LENGTH,
  userProgressClientNonce,
} from "./user-progress.js";

describe("clampUserProgressMessage", () => {
  it("trims and rejects empty text", () => {
    expect(clampUserProgressMessage("  hello  ")).toBe("hello");
    expect(clampUserProgressMessage("   ")).toBe("");
  });

  it("clamps long progress beats", () => {
    const clamped = clampUserProgressMessage("x".repeat(USER_PROGRESS_MESSAGE_MAX_LENGTH + 40));
    expect(clamped).toHaveLength(USER_PROGRESS_MESSAGE_MAX_LENGTH);
    expect(clamped.endsWith("…")).toBe(true);
  });

  it("clamps to a caller-supplied cap", () => {
    const clamped = clampUserProgressMessage("x".repeat(4_100), 4_000);
    expect(clamped).toHaveLength(4_000);
    expect(clamped.endsWith("…")).toBe(true);
    expect(clampUserProgressMessage("x".repeat(4_000), 4_000)).toHaveLength(4_000);
  });
});

describe("messageUserMaxLength", () => {
  afterEach(() => vi.unstubAllEnvs());

  const messageUserTool = () => {
    const tool = builtinAgentTools.find((entry) => entry.name === "message_user");
    if (!tool) throw new Error("missing message_user");
    return tool as typeof tool & {
      inputSchema: { properties: { message: { maxLength: number } } };
    };
  };

  it("defaults to 500 characters everywhere the model sees the cap", () => {
    vi.stubEnv("RAKAZO_MESSAGE_USER_MAX_CHARS", undefined);
    expect(messageUserMaxLength()).toBe(USER_PROGRESS_MESSAGE_MAX_LENGTH);
    expect(messageUserTool().inputSchema.properties.message.maxLength).toBe(500);
    expect(messageUserTool().description).toContain("cut off silently at 500 characters");
    expect(longWorkProgressGuidance()).toContain("message_user is capped at 500 characters");
    expect(longWorkProgressGuidance().startsWith(ANSWER_BEFORE_ASK)).toBe(true);
    expect(longWorkProgressGuidance()).toContain(
      "Before the first tool call on such a task, tell the person right away with message_user",
    );
    expect(longWorkProgressGuidance()).toContain(
      "Do not go silent through a long stretch of tool calls",
    );
    expect(longWorkProgressGuidance()).not.toContain("stay quiet until something changes");
  });

  it("applies RAKAZO_MESSAGE_USER_MAX_CHARS to the schema, description, and guidance", () => {
    vi.stubEnv("RAKAZO_MESSAGE_USER_MAX_CHARS", " 4000 ");
    expect(messageUserMaxLength()).toBe(4_000);
    expect(messageUserTool().inputSchema.properties.message.maxLength).toBe(4_000);
    expect(messageUserTool().description).toContain("cut off silently at 4000 characters");
    expect(longWorkProgressGuidance()).toContain("message_user is capped at 4000 characters");
  });

  it.each(["", " ", "0", "-5", "12.5", "NaN", "Infinity", "lots", "4000chars", "1e3", "0x10"])(
    "falls back to 500 for RAKAZO_MESSAGE_USER_MAX_CHARS=%j",
    (value) => {
      vi.stubEnv("RAKAZO_MESSAGE_USER_MAX_CHARS", value);
      expect(messageUserMaxLength()).toBe(USER_PROGRESS_MESSAGE_MAX_LENGTH);
    },
  );
});

describe("isProgressMessageTruncated", () => {
  it("is false for text that fits", () => {
    expect(isProgressMessageTruncated("short update")).toBe(false);
    expect(isProgressMessageTruncated("x".repeat(USER_PROGRESS_MESSAGE_MAX_LENGTH))).toBe(false);
  });

  it("is true for text that would be cut off by clampUserProgressMessage", () => {
    const long = "x".repeat(USER_PROGRESS_MESSAGE_MAX_LENGTH + 1);
    expect(isProgressMessageTruncated(long)).toBe(true);
    expect(clampUserProgressMessage(long).endsWith("…")).toBe(true);
  });

  it("measures against a caller-supplied cap", () => {
    expect(isProgressMessageTruncated("x".repeat(4_000), 4_000)).toBe(false);
    expect(isProgressMessageTruncated("x".repeat(4_001), 4_000)).toBe(true);
  });
});

describe("midTurnProgressBudgetAllows", () => {
  it("stays silent while a turn is still fresh", () => {
    expect(midTurnProgressBudgetAllows(0, MID_TURN_PROGRESS_MIN_TURN_AGE_MS - 1)).toBe(false);
  });

  it("allows a few beats once a turn is long", () => {
    const age = MID_TURN_PROGRESS_MIN_TURN_AGE_MS;
    expect(midTurnProgressBudgetAllows(0, age)).toBe(true);
    expect(midTurnProgressBudgetAllows(MID_TURN_PROGRESS_MAX_PER_RUN - 1, age)).toBe(true);
  });

  it("stops posting once the per-run cap is reached", () => {
    const age = MID_TURN_PROGRESS_MIN_TURN_AGE_MS * 10;
    expect(midTurnProgressBudgetAllows(MID_TURN_PROGRESS_MAX_PER_RUN, age)).toBe(false);
    expect(midTurnProgressBudgetAllows(MID_TURN_PROGRESS_MAX_PER_RUN + 1, age)).toBe(false);
  });
});

describe("canPostLongTaskHeadsUp", () => {
  const ctx = (trigger: string, count = 0) =>
    ({
      run: { trigger },
      state: { reply: { midTurnProgressCount: count } },
    }) as never;

  it("allows the first conversational heads-up before any long tool", () => {
    expect(canPostLongTaskHeadsUp(ctx("user"))).toBe(true);
    expect(canPostLongTaskHeadsUp(ctx("messaging"))).toBe(true);
  });

  it("does not skip the 60s wait after the first interim", () => {
    expect(canPostLongTaskHeadsUp(ctx("user", 1))).toBe(false);
  });

  it("keeps silent runs on the fresh-turn rule", () => {
    for (const trigger of ["routine", "webhook", "reaction", "bot_message"]) {
      expect(canPostLongTaskHeadsUp(ctx(trigger))).toBe(false);
    }
  });
});

describe("canPublishDurableNarration", () => {
  const ctx = (
    trigger: string,
    options: { count?: number; turnAgeMs?: number; steering?: boolean } = {},
  ) =>
    ({
      run: { trigger },
      state: {
        reply: {
          midTurnProgressCount: options.count ?? 0,
          progressBudgetStart: 0,
          turnStartedAtMs: Date.now() - (options.turnAgeMs ?? 0),
          steeringReplyPending: options.steering ?? false,
        },
      },
    }) as never;

  it("promotes the first conversational narration before any tool", () => {
    expect(canPublishDurableNarration(ctx("user"))).toBe(true);
    expect(canPublishDurableNarration(ctx("messaging"))).toBe(true);
  });

  it("keeps later narration on the 60s / max-3 budget", () => {
    expect(canPublishDurableNarration(ctx("user", { count: 1 }))).toBe(false);
    expect(
      canPublishDurableNarration(
        ctx("user", { count: 1, turnAgeMs: MID_TURN_PROGRESS_MIN_TURN_AGE_MS }),
      ),
    ).toBe(true);
    expect(
      canPublishDurableNarration(
        ctx("user", {
          count: MID_TURN_PROGRESS_MAX_PER_RUN,
          turnAgeMs: MID_TURN_PROGRESS_MIN_TURN_AGE_MS,
        }),
      ),
    ).toBe(false);
  });

  it("does not promote the first beat on silent or held-back runs", () => {
    for (const trigger of ["routine", "webhook", "reaction", "bot_message"]) {
      expect(canPublishDurableNarration(ctx(trigger))).toBe(false);
    }
  });
});

describe("silent long-work reminder", () => {
  const ctx = (options: {
    trigger?: string;
    count?: number;
    reminded?: boolean;
    disabled?: string[];
  }) =>
    ({
      run: { trigger: options.trigger ?? "user" },
      state: {
        reply: {
          midTurnProgressCount: options.count ?? 0,
          remindedSilentLongWork: options.reminded ?? false,
        },
      },
      tools: { disabled: new Set(options.disabled ?? []) },
    }) as never;

  it("names the tools that should nudge a silent conversational turn", () => {
    expect(isLongWorkTool("computer_act")).toBe(true);
    expect(isLongWorkTool("computer_observe")).toBe(true);
    expect(isLongWorkTool("shell")).toBe(true);
    expect(isLongWorkTool("browser_act")).toBe(true);
    expect(isLongWorkTool("user_computer_shell")).toBe(true);
    expect(isLongWorkTool("read_file")).toBe(false);
    expect(isLongWorkTool("web_search")).toBe(false);
    expect(isLongWorkTool("message_user")).toBe(false);
    expect(isLongWorkTool("user_computer_policy")).toBe(false);
  });

  it("asks for a message_user heads-up instead of more silent work", () => {
    expect(SILENT_LONG_WORK_HEADS_UP_NOTE).toContain("message_user");
    expect(SILENT_LONG_WORK_HEADS_UP_NOTE).toMatch(/plan|progress/);
    expect(SILENT_LONG_WORK_HEADS_UP_NOTE).not.toMatch(/Keep working/i);
  });

  it("attaches the note once on the first silent long tool", () => {
    const reply = { midTurnProgressCount: 0, remindedSilentLongWork: false };
    const first = {
      run: { trigger: "user" },
      state: { reply },
      tools: { disabled: new Set() },
    } as never;
    expect(withSilentLongWorkReminder(first, "computer_act", { ok: true })).toEqual({
      ok: true,
      note: SILENT_LONG_WORK_HEADS_UP_NOTE,
    });
    expect(reply.remindedSilentLongWork).toBe(true);
    expect(withSilentLongWorkReminder(first, "shell", { stdout: "" })).toEqual({ stdout: "" });
  });

  it("leaves short tools and later interims alone", () => {
    expect(withSilentLongWorkReminder(ctx({}), "read_file", { text: "hi" })).toEqual({
      text: "hi",
    });
    expect(withSilentLongWorkReminder(ctx({ count: 1 }), "computer_act", { ok: true })).toEqual({
      ok: true,
    });
    expect(withSilentLongWorkReminder(ctx({ trigger: "routine" }), "shell", { ok: true })).toEqual({
      ok: true,
    });
    expect(
      withSilentLongWorkReminder(ctx({ disabled: ["message_user"] }), "shell", { ok: true }),
    ).toEqual({ ok: true });
  });
});

describe("mid-turn progress rejection notes", () => {
  it("points at a later milestone or the final reply instead of telling the model to stay quiet", () => {
    expect(midTurnProgressTooSoonNote()).toContain("later milestone");
    expect(midTurnProgressTooSoonNote()).toContain(
      `${MID_TURN_PROGRESS_MIN_TURN_AGE_MS / 1000} seconds`,
    );
    expect(MID_TURN_PROGRESS_BUDGET_USED_NOTE).toContain("Put remaining points in the final reply");
    expect(`${midTurnProgressTooSoonNote()}\n${MID_TURN_PROGRESS_BUDGET_USED_NOTE}`).not.toMatch(
      /Keep working|Do not send more progress updates/i,
    );
  });
});

describe("extractNarrationText", () => {
  it("pulls text blocks and current text while keeping tool activity", () => {
    const { text, remaining } = extractNarrationText(
      [
        { kind: "text", text: "Checking calendars. " },
        { kind: "steps", steps: [{ label: "Web search", count: 1 }] },
        { kind: "text", text: "Found three options." },
      ],
      " Still looking.",
    );
    expect(text).toBe("Checking calendars. Found three options. Still looking.");
    expect(remaining).toEqual([{ kind: "steps", steps: [{ label: "Web search", count: 1 }] }]);
  });
});

describe("finalBlocksAfterMidTurnProgress", () => {
  it("drops a hollow final message that is only hidden tool activity", () => {
    const steps: MessageBlock = { kind: "steps", steps: [{ label: "Shell", count: 2 }] };
    expect(finalBlocksAfterMidTurnProgress([steps], true)).toEqual([]);
    expect(finalBlocksAfterMidTurnProgress([steps], false)).toEqual([steps]);
  });

  it("keeps a final answer alongside tool activity", () => {
    const blocks: MessageBlock[] = [
      { kind: "steps", steps: [{ label: "Web search", count: 1 }] },
      { kind: "text", text: "You are free Tuesday afternoon." },
    ];
    expect(finalBlocksAfterMidTurnProgress(blocks, true)).toEqual(blocks);
    expect(isToolActivityBlock(blocks[0]!)).toBe(true);
  });
});

describe("botMessageOutcomeFromMidTurn", () => {
  it("prefers the final reply as a result", () => {
    expect(botMessageOutcomeFromMidTurn("All set.", ["Checking calendars…"])).toEqual({
      text: "All set.",
      intent: "result",
    });
  });

  it("returns mid-turn progress as status when there is no final reply", () => {
    expect(
      botMessageOutcomeFromMidTurn("", ["Checking calendars…", "Found three free slots."]),
    ).toEqual({
      text: "Checking calendars…\n\nFound three free slots.",
      intent: "status",
    });
  });

  it("returns null when nothing was posted", () => {
    expect(botMessageOutcomeFromMidTurn("  ", [])).toBeNull();
  });
});

describe("userProgressClientNonce", () => {
  it("tags mid-turn progress messages for reconciler detection", () => {
    const nonce = userProgressClientNonce("run-1", 0);
    expect(nonce.startsWith("user-progress:run-1:0:")).toBe(true);
    expect(isUserProgressClientNonce(nonce)).toBe(true);
    expect(userProgressClientNonce("run-1", 0)).not.toBe(nonce);
    expect(isUserProgressClientNonce(null)).toBe(false);
    expect(isUserProgressClientNonce("other")).toBe(false);
  });
});

describe("assistantTurnSeparator", () => {
  it("adds a paragraph break between turns that would run together", () => {
    expect(
      assistantTurnSeparator("posted at https://example.com/drafts/42", "Nothing changed."),
    ).toBe("\n\n");
    expect(assistantTurnSeparator("Nothing changed.", "NO_RESPONSE")).toBe("\n\n");
  });

  it("adds nothing when there is no earlier text or a side has whitespace", () => {
    expect(assistantTurnSeparator("", "Hello.")).toBe("");
    expect(assistantTurnSeparator("Done.", "")).toBe("");
    expect(assistantTurnSeparator("Done.\n", "Next.")).toBe("");
    expect(assistantTurnSeparator("Done.", " Next.")).toBe("");
  });
});

describe("narrationStatusLine", () => {
  it("makes one short line of a note", () => {
    expect(narrationStatusLine("  Checking\nthe   totals.  ")).toBe("Checking the totals.");
    const line = narrationStatusLine("x".repeat(NARRATION_STATUS_MAX_LENGTH + 5));
    expect(line).toBe(`${"x".repeat(NARRATION_STATUS_MAX_LENGTH)}…`);
  });
});

describe("midTaskMessagePrompt", () => {
  it("asks for a short answer through message_user, then the rest of the task", () => {
    expect(midTaskMessagePrompt("Still working?", true)).toBe(
      "The person sent this while you were working:\n\nStill working?\n\nIf it asks something or changes the plan, answer briefly with message_user, then continue the task.",
    );
  });

  it("asks for no plain-text answer, which would end the task, when message_user is off", () => {
    const prompt = midTaskMessagePrompt("Still working?", false);
    expect(prompt).toContain("\n\nStill working?\n\n");
    expect(prompt).toContain("continue the task");
    expect(prompt).not.toMatch(/reply|answer/);
  });
});
