import type { ReactNode } from "react";
import { DataList, Flex, Heading, Text } from "@radix-ui/themes";
import { ChevronRightIcon } from "@radix-ui/react-icons";
import { formatScriptTime } from "../StreamPanel";
import { stats, type Action } from "./model";

/** A sidebar section's title, pressed to expand or collapse it; collapsed, `summary` at its end. */
export function SectionHeader({ title, open, setOpen, summary }: { title: string; open: boolean; setOpen: (open: boolean) => void; summary?: ReactNode }) {
  return (
    <Flex
      align="center"
      gap="2"
      role="button"
      tabIndex={0}
      aria-expanded={open}
      onClick={() => setOpen(!open)}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setOpen(!open))}
      style={{ cursor: "pointer", userSelect: "none" }}
    >
      <ChevronRightIcon style={{ flexShrink: 0, transform: open ? "rotate(90deg)" : undefined }} />
      <Heading size="3">{title}</Heading>
      {!open && summary && <Text size="2" color="gray" ml="auto">{summary}</Text>}
    </Flex>
  );
}

/** The stats of the points `picked` of `actions`, sorted: speeds, depths, duration and count. */
export function Stats({ actions, picked, size }: { actions: Action[]; picked: number[]; size: "1" | "2" }) {
  const { top, average, low, high, duration } = stats(actions, picked);
  return (
    <DataList.Root size={size}>
      {([["Max speed", `${Math.round(top)}/s`], ["Average speed", `${Math.round(average)}/s`], ["Min depth", 100 - high], ["Max depth", 100 - low], ["Duration", formatScriptTime(duration / 1000)], ["Points", picked.length]] as const).map(([label, value]) => (
        <DataList.Item key={label}>
          <DataList.Label color="gray">{label}</DataList.Label>
          <DataList.Value>{value}</DataList.Value>
        </DataList.Item>
      ))}
    </DataList.Root>
  );
}
