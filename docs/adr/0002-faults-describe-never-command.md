# 2. Faults describe, they never command

Date: 2026-08-31

## Status

Accepted

## Context

The firmware has no error model. `StateResponse::Fault` is a single bit with no
class and no code, and the underlying `B::Error` is dropped into `log::error!`
at every raise site. A fault model is being introduced so the LED can name what
went wrong.

`MotionController` already has its own safety behaviour, independent of
anything the LED does: `update` calls `enter_fault()` on a board tick failure,
which transitions the controller to `Disabled` and returns `Err`. The
pattern-engine runner has its own: a failed enable or home sets the runner back
to `Idle`.

The obvious shape for a fault model is a safety authority — subsystems raise
faults, and raising one stops the machine. That gives one place to reason about
what a failure does, and it is what a reader expects to find. It also means the
controller's `enter_fault` and the runner's fallback to `Idle` are now the
*second* mechanism that stops the machine, racing a mechanism that was designed
without knowledge of them.

## Decision

A fault is an observation. Raising one changes what is displayed and nothing
else.

Subsystems report faults into the fault store; the store is never consulted to
decide whether the machine may move. `MotionController` and the pattern-engine
runner keep their existing behaviour untouched and do not read the store.

Severity therefore ranks *display precedence* — which of several latched faults
the LED names — and makes no claim about danger.

## Consequences

A latched fault does not prevent the user re-enabling the machine and trying
again. The LED will still be naming the fault while the machine runs; that is
correct, because the fault records what happened, not what is permitted.

Nothing in the status layer can be relied on for safety, and nothing may be
built on the assumption that it can. A future requirement to gate motion on a
fault needs a different mechanism, decided separately — extending this one
turns the display path into a safety path by accident, which is precisely what
this decision buys out of.

The fault store must be reachable from code that runs before `MotionController`
exists: `motor::build` panics on a factory-fresh motor (see
docs/adr/0001-boot-led-before-motor-init.md), and that is the single most
valuable fault the LED can name. The store is created alongside the LED, before
`motor::build`, and `provision` returns a `Result` rather than panicking.
