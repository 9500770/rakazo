import { formatCompactDuration, toolActivityKind, toolNameFromLabel } from "@rakazo/core";
import { typeScale } from "@rakazo/ui-tokens";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { MobileMessage } from "../../lib/api";
import { t } from "../../lib/i18n";
import type { useMobileTokens } from "../../lib/native";

type MobileTokens = ReturnType<typeof useMobileTokens>;

/**
 * One muted line under a live run's bubble: what kind of work is happening, how many tool
 * calls, and how long it has been going — ticking without new events, so a silent stretch
 * still shows the run is alive.
 */
export function LiveActivityLine({
  message,
  tokens,
}: {
  message: MobileMessage;
  /** Passed by the row, which already resolves tokens, so this line adds no appearance import. */
  tokens: MobileTokens;
}) {
  const isLive = message.id.startsWith("progress:");
  const steps = message.blocks.find((block) => block.kind === "steps");
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!isLive) return;
    const timer = setInterval(() => setTick((value) => value + 1), 15_000);
    return () => clearInterval(timer);
  }, [isLive]);
  if (!isLive || !steps || steps.kind !== "steps") return null;
  const label = steps.steps.at(-1)?.label;
  const kind = label ? toolActivityKind(toolNameFromLabel(label)) : "working";
  const phrase =
    kind === "reading"
      ? t("Looking things up…")
      : kind === "writing"
        ? t("Writing files…")
        : kind === "computer"
          ? t("Using its computer…")
          : t("Working…");
  const toolCount = steps.steps.reduce((total, step) => total + step.count, 0);
  const elapsed = message.createdAt
    ? formatCompactDuration(Date.now() - Date.parse(message.createdAt))
    : null;
  return (
    <View style={{ flexDirection: "row", marginTop: 4, gap: 6 }}>
      <Text style={{ color: tokens.mutedForeground, ...typeScale.caption }}>{phrase}</Text>
      <Text style={{ color: tokens.mutedForeground, ...typeScale.caption }}>
        {t("{count} tools", { count: toolCount })}
      </Text>
      {elapsed ? (
        <Text style={{ color: tokens.mutedForeground, ...typeScale.caption }}>{elapsed}</Text>
      ) : null}
    </View>
  );
}
