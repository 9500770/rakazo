import { Plural, Trans } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { ThreadMessage } from "@rakazo/contracts";
import { formatCompactDuration, toolActivityKind, toolNameFromLabel } from "@rakazo/core";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@rakazo/ui-web/components/ui/collapsible";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { Fragment, useEffect, useState } from "react";
import { toolStepCount } from "../lib/tool-activity-view";

type ToolStep = Extract<ThreadMessage["blocks"][number], { kind: "steps" }>["steps"][number];
type ActivityKind = "reading" | "writing" | "computer" | "working";

/** The kind of work the newest step stands for, so the header names the activity, not the tool. */
export function stepsActivityKind(steps: readonly ToolStep[]): ActivityKind {
  const label = steps.at(-1)?.label;
  return label ? toolActivityKind(toolNameFromLabel(label)) : "working";
}

function LiveActivityLabel({ kind }: { kind: string }) {
  switch (kind) {
    case "reading":
      return <Trans>Looking things up</Trans>;
    case "writing":
      return <Trans>Writing files</Trans>;
    case "computer":
      return <Trans>Using its computer</Trans>;
    default:
      return <Trans>Working</Trans>;
  }
}

/** Re-renders while a run is live so its elapsed time keeps ticking without new events. */
function useLiveElapsed(live: boolean, startedAt: number | undefined): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live || startedAt === undefined) return;
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [live, startedAt]);
  if (!live || startedAt === undefined) return null;
  return formatCompactDuration(Math.max(0, now - startedAt));
}

/** While a run is live, only the most recent steps are listed so a long run does not push the chat down. */
export const LIVE_TOOL_STEP_WINDOW = 6;

export function ToolSteps({
  steps,
  currentIndex,
  limit,
}: {
  steps: readonly ToolStep[];
  currentIndex?: number;
  /** Show only the last `limit` steps, with a count of the earlier ones above them. */
  limit?: number;
}) {
  const hidden = limit !== undefined && steps.length > limit ? steps.length - limit : 0;
  const shown = hidden > 0 ? steps.slice(hidden) : steps;
  return (
    <div className="space-y-0.5" data-testid="tool-rows">
      {hidden > 0 ? (
        <div className="text-[12px] leading-5 text-muted-foreground" data-testid="tool-rows-hidden">
          <Plural value={hidden} one="+# earlier step" other="+# earlier steps" />
        </div>
      ) : null}
      {shown.map((step, offset) => {
        const index = hidden + offset;
        const isCurrent = index === currentIndex;
        return (
          <Fragment key={index}>
            {step.note ? (
              <div className="py-1 text-[13px] text-foreground/75" data-testid="tool-step-note">
                <ChatMarkdown>{step.note}</ChatMarkdown>
              </div>
            ) : null}
            <div className="flex min-w-0 items-center gap-2 leading-5">
              <span
                className={`text-[12px] ${isCurrent ? "text-warning" : "text-success"}`}
                style={{ animation: isCurrent ? "rkPulse 1.2s ease-in-out infinite" : undefined }}
              >
                {isCurrent ? "◷" : "✓"}
              </span>
              <span
                className={`min-w-0 flex-1 truncate text-[13px] ${
                  isCurrent ? "text-foreground" : "text-muted-foreground"
                }`}
                title={step.label}
              >
                {step.label}
                {step.count > 1 ? ` ×${step.count}` : ""}
              </span>
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

/**
 * The tool-activity card. It starts open while the run is live and folds when the run
 * ends. The keyed default keeps manual toggles until the run changes phase.
 */
export function ToolActivityDisclosure({
  live,
  stepCount,
  durationMs,
  activityKind = "working",
  startedAt,
  children,
}: {
  live: boolean;
  stepCount: number;
  durationMs?: number;
  activityKind?: "reading" | "writing" | "computer" | "working";
  /** Wall clock of the run's start; while live the header ticks elapsed time from it. */
  startedAt?: number;
  children: ReactNode;
}) {
  const duration = formatCompactDuration(durationMs);
  const liveElapsed = useLiveElapsed(live, startedAt);
  const toolCount = stepCount;
  return (
    <Collapsible
      key={live ? "working" : "actions"}
      defaultOpen={live}
      data-testid="tool-activity"
      data-live={live || undefined}
      className="group"
    >
      <CollapsibleTrigger
        className={`flex min-h-6 w-fit cursor-pointer list-none items-center gap-1 rounded-md py-0.5 pe-1.5 text-[13px] font-medium outline-none hover:text-foreground/75 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
          live ? "text-foreground/75" : "text-muted-foreground"
        }`}
      >
        <ChevronRight
          aria-hidden
          size={14}
          strokeWidth={1.8}
          className="transition-transform duration-150 group-data-panel-open:rotate-90 motion-reduce:transition-none"
        />
        <span className="flex items-center gap-2">
          <span>
            {live ? (
              <>
                <LiveActivityLabel kind={activityKind} />…
              </>
            ) : (
              <Trans>Done</Trans>
            )}
          </span>
          <span>
            <Plural value={toolCount} one="# tool" other="# tools" />
          </span>
          {live && liveElapsed ? (
            <span data-testid="tool-activity-elapsed">{liveElapsed}</span>
          ) : !live && duration ? (
            <span>{duration}</span>
          ) : null}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent hiddenUntilFound>
        <div className="ms-[7px] mt-0.5 border-s border-border ps-3">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * A tools-only message: a plain muted line between messages, not a chat bubble.
 */
export function StandaloneToolActivity({
  live,
  steps,
  stepCount,
  durationMs,
  startedAt,
}: {
  live: boolean;
  steps: readonly ToolStep[];
  stepCount: number;
  durationMs?: number;
  startedAt?: number;
}) {
  return (
    <div className="flex justify-start" dir="ltr" data-testid="tool-activity-line">
      <div className="max-w-full min-w-0 ps-1">
        <ToolActivityDisclosure
          live={live}
          stepCount={stepCount}
          durationMs={durationMs}
          activityKind={stepsActivityKind(steps)}
          startedAt={startedAt}
        >
          <ToolSteps
            steps={steps}
            currentIndex={live ? steps.length - 1 : undefined}
            limit={live ? LIVE_TOOL_STEP_WINDOW : undefined}
          />
        </ToolActivityDisclosure>
      </div>
    </div>
  );
}

/** A bot message whose only visible blocks are tool cards: one slim line per card, no bubble. */
export function ToolOnlyNarration({
  blocks,
  live,
  startedAt,
}: {
  blocks: readonly ThreadMessage["blocks"][number][];
  live: boolean;
  startedAt?: number;
}) {
  return (
    <>
      {blocks.map((block, i) =>
        block.kind === "steps" ? (
          <StandaloneToolActivity
            key={i}
            live={live}
            steps={block.steps}
            stepCount={toolStepCount(block.steps)}
            durationMs={block.durationMs}
            startedAt={startedAt}
          />
        ) : null,
      )}
    </>
  );
}
