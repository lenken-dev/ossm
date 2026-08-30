# Code Comments

How much to comment, and what to say. This is a house style, not a
suggestion — match it in new code and when editing existing code.

## The rule

**Document the contract, not the deliberation.**

Write what a caller cannot infer from the signature. Do not write why you
chose this over something else.

| Write this                                   | Not this                                     |
| -------------------------------------------- | -------------------------------------------- |
| Units, ranges, wire order                     | Why the units are the ones you picked        |
| What the caller must do on error              | How that compares to error handling elsewhere |
| Observable edge behaviour (truncates, clamps) | That you considered rounding first           |
| Datasheet constraints behind a magic number   | The reasoning that led you to the number     |
| What breaks if a caller reorders calls        | An essay defending the current order         |

**Never argue with an alternative you didn't pick.** If a comment contains
"rather than", "the alternative would", "deliberately not", or "contrast
with", delete it or move it to an ADR.

## How much

Match the files next to the one you're editing. The tiers:

- **`ossm/` core traits** (`Board`, `RgbLed`, `MotionSender`) — the API every
  other crate codes against. Dense docs are correct here: units, safety model,
  what each implementor must guarantee.
- **Drivers, boards, firmware, bindings** — terse. A line or two on anything
  hardware-specific or non-obvious; nothing else. A driver that reads like the
  core crate is over-commented.
- **Patterns** — usually no comments. The code is the specification.

## Where the deliberation goes

Reasoning that is genuinely load-bearing — a decision a future refactor would
silently undo — goes in `docs/adr/`, not in a comment. Leave a one-line
pointer at the code:

```rust
// Before the motor: `motor::build` panics on a factory-fresh motor, and the
// LED is the only sign the firmware ran at all.
// See docs/adr/0001-boot-led-before-motor-init.md.
```

Reasoning that is *not* load-bearing goes in the commit message, where it
stays attached to the change without accumulating in the file.

## Prose

British spelling in comments and docs (`colour`, `behaviour`, `millimetres`);
identifiers stay US (`set_color`, `BOOT_COLOR`) per Rust ecosystem convention.
