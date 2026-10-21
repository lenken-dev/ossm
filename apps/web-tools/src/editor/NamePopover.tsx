import { useId, useState, type CSSProperties, type ReactElement, type SVGProps } from "react";
import { Button, Flex, IconButton, Popover, Text, TextField } from "@radix-ui/themes";
import { CheckIcon } from "@radix-ui/react-icons";

/**
 * Every name field: a small modal popup for a name, `initial` at first,
 * opened by `children`, a button, or else open at `anchor` from the start.
 * Enter or its OK button gives the name, trimmed, to `onName`, unless it is
 * empty or `taken`; Escape or a press outside closes it with `onCancel`, the
 * press going no further. It suggests `suggestions`; with `onRemove`, it has
 * a Delete button.
 */
export function NamePopover({ initial = "", taken = () => false, onName, onCancel, onRemove, suggestions, anchor, children }: {
  initial?: string;
  taken?: (name: string) => boolean;
  onName: (name: string) => void;
  onCancel?: () => void;
  onRemove?: () => void;
  suggestions?: string[];
  anchor?: CSSProperties;
  children?: ReactElement;
}) {
  const [name, setName] = useState<string | null>(anchor ? initial : null);
  const list = useId();
  const refused = name === null || !name.trim() || taken(name.trim());
  const accept = () => {
    if (refused) return;
    setName(null);
    onName(name.trim());
  };
  return (
    <Popover.Root modal open={name !== null} onOpenChange={(open) => {
      setName(open ? initial : null);
      if (!open) onCancel?.();
    }}>
      {anchor ? <Popover.Anchor style={anchor} /> : <Popover.Trigger>{children}</Popover.Trigger>}
      <Popover.Content
        size="1"
        width={onRemove ? "280px" : "220px"}
        // In a portal, but React still bubbles its presses and keys up to where it is opened, as to a lane adding a marker or the page's shortcuts.
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <Flex direction="column" gap="1">
          <Flex gap="2">
            <TextField.Root
              size="1"
              aria-label="Name"
              list={suggestions && list}
              value={name ?? ""}
              onFocus={(e) => e.target.select()}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && accept()}
              style={{ flexGrow: 1 }}
            />
            <IconButton size="1" disabled={refused} aria-label="OK" title="OK (Enter)" onClick={accept}><CheckIcon /></IconButton>
            {onRemove && (
              <Button
                size="1"
                variant="soft"
                color="red"
                onClick={() => {
                  setName(null);
                  onRemove();
                }}
              >
                Delete
              </Button>
            )}
          </Flex>
          {name?.trim() && refused && <Text size="1" color="red">That name is taken.</Text>}
        </Flex>
        {suggestions && <datalist id={list}>{suggestions.map((s) => <option key={s} value={s} />)}</datalist>}
      </Popover.Content>
    </Popover.Root>
  );
}

/** A snippet: a stretch of strokes cut out of a script, sized like the icons. */
export const SnippetIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg width="15" height="15" viewBox="0 0 15 15" fill="none" {...props}>
    <rect x="1.5" y="2.5" width="12" height="10" rx="1.5" stroke="currentColor" />
    <polyline points="3.5,9.5 6,5 9,10 11.5,5.5" stroke="currentColor" strokeLinejoin="round" strokeLinecap="round" />
  </svg>
);
