# 3. The fault reporter is a copyable handle

Date: 2026-08-31

## Status

Accepted

## Context

Every capability this repo hands out is deliberately non-`Clone` and not
publicly constructible. `Ossm::split` yields one `MotionSender`, one
`MotionObserver` and one `MotionReceiver`; `PatternEngine::split` does the
same. The pattern is load-bearing: `Ossm`'s own documentation notes that after
`split` returns, nothing in the program holds an `&Ossm`, and the handles are
what stop a second caller from moving the motor behind the first one's back.

A fault reporter under that rule would have to be threaded by reference down
every call graph that can fail. The failure sites are not concentrated: they
live in `ossm` (transport, `MotionController`), `ossm-esp` (the motor
builders), `crates/pattern-engine` (the runner, which today swallows
`StateResponse::Fault`), and `firmware/esp32s3` (`radio.rs`, the boot path).

## Decision

`FaultReporter` is `Copy`, freely duplicated, and handed to anyone who needs
it.

The non-`Clone` rule protects *authority*. `MotionSender` can move the motor,
so exactly one thing may hold it. A fault reporter has no authority: raising a
fault changes what is displayed and nothing else (see
docs/adr/0002-faults-describe-never-command.md). There is nothing for the type
system to protect here.

The reporter still goes to loops rather than leaves. Fallible code keeps
returning `Result` as it does today, and the fault is raised at the nearest
caller that never returns — the boot path in `run`, `motion_task`, and
`PatternRunner::run`. `provision` returns a `Result` instead of panicking and
the `ossm-esp` builders do the same, so no driver learns the fault vocabulary.

## Consequences

The store cannot know which site raised a fault. The `log::error!` already
present at each raise site carries that, and the fault itself is a bare tag
with no payload, so there is nothing to attribute.

Restricting the handle would have bought no safety and cost reporting
coverage: an awkward capability means a raise site quietly does not report,
which is the worst failure mode a diagnostic has.

A reader who has just met three deliberately non-`Clone` capabilities will
read this `Copy` as an oversight. It is not, and un-`Copy`ing it once the
raise sites hold copies is a refactor across four crates.
