import { Box, Flex, Slider, Text } from "@radix-ui/themes";

export function LabeledSlider({
  label,
  value,
  display,
  min,
  max,
  step,
  disabled,
  ends,
  onChange,
  onCommit,
}: {
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  /** Labels under the track's start and end. */
  ends?: [string, string];
  onChange: (v: number) => void;
  /** On release or a key step, after the `onChange` calls of a drag. */
  onCommit?: (v: number) => void;
}) {
  return (
    <Box>
      <Flex justify="between" mb="1">
        <Text size="2" weight="medium">{label}</Text>
        <Text size="2" color="gray">{display}</Text>
      </Flex>
      <Slider min={min} max={max} step={step} value={[value]} disabled={disabled} onValueChange={([v]) => onChange(v)} onValueCommit={([v]) => onCommit?.(v)} />
      {ends && (
        <Flex justify="between" mt="1">
          <Text size="1" color="gray">{ends[0]}</Text>
          <Text size="1" color="gray">{ends[1]}</Text>
        </Flex>
      )}
    </Box>
  );
}
