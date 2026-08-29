# 1. Light the boot LED before initialising the motor

Date: 2026-08-29

## Status

Accepted

## Context

`esp32s3::run` brings up the motor via `motor::build`, which spends roughly
500 ms provisioning over Modbus and panics outright when it finds a
factory-fresh motor that still needs a power cycle.

That panic is the single most confusing boot a user can hit: the board is
powered, the firmware is running, and nothing outward-facing says so. The
addressable LED is the only signal the board has before the radio and the web
UI are up.

The obvious order is to bring up the motor first — it is the machine's reason
to exist, and the LED is cosmetic. Ordering it that way is what makes the LED
useless in the one case it is most needed.

## Decision

Initialise the LED and set `BOOT_COLOR` *before* calling `motor::build`.

The LED path is fallible-but-ignorable throughout: `ws2812::build` returns
`None` rather than panicking, and a failed `set_color` is logged and stepped
over. Nothing on this path may prevent a board with a working motor from
running.

## Consequences

A lit LED distinguishes "the firmware did not run" from "the firmware ran". It
does not, on its own, implicate the motor — nothing changes the colour after
boot, so the same colour is shown whether the machine went on to work or
panicked a moment later.

Any future work that moves LED setup below `motor::build`, or makes the LED
depend on a subsystem that comes up after it, silently destroys this. No test
catches it, because the failure only appears on hardware in a state the tests
do not reproduce.

If a status-indicator layer later drives colours from machine state, that layer
must keep the boot colour as its first act rather than waiting for the first
state transition.
