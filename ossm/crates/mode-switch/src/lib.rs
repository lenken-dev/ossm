#![no_std]

//! Switching between pattern and streamed motion.
//!
//! The pattern engine drives the machine until a streamed point starts
//! streaming. Streaming then lasts until the next pattern command other
//! than play (stop, pause, ...) from any remote, which the pattern engine
//! processes once it runs again. Streaming uses the pattern input (depth, stroke, speed), so
//! every remote controls both modes.
//!
//! Rules:
//! 1. Ownership: a point starts streaming only while no pattern session
//!    exists (the pattern engine is idle or ready, with no motion state
//!    operation in flight) and the speed setting is above zero. Other points
//!    are dropped. A playing or paused pattern must be stopped first. Likewise,
//!    play commands are dropped in streaming mode: the stream must end first.
//! 2. Abort: a pattern command aborts preparing the machine (enabling,
//!    homing) before its next step, without further motion. Issued
//!    operations are awaited, never cancelled, so each gets its own response.
//!    The stream starts with the first point after preparing: earlier ones
//!    are stale.
//! 3. No lost commands: pattern commands arriving in streaming mode are
//!    taken, keeping the latest. Leaving streaming ends the stream with a
//!    controlled stop, disables the machine and sets the speed to zero, so
//!    later points cannot restart motion until the speed is raised. It then
//!    hands the kept command to the pattern engine.

use core::future::Future;

use embassy_futures::select::{Either, select};
use embassy_time::{Delay, Timer};
use log::{debug, error, info, warn};
use ossm::{MotionPhase, MotionSender, StateResponse};
use pattern_engine::{AnyPattern, EngineState, PatternRunner, PatternSender, PendingCommand};
use stream_engine::{StreamInput, StreamRunner};

pub struct Modes<'a> {
    pub motion: &'a MotionSender,
    pub patterns: &'a PatternSender,
    pub pattern_runner: PatternRunner,
    pub stream_runner: StreamRunner,
}

/// The mode driving the machine.
pub enum Mode {
    /// Run patterns, starting with the command handed over by the previous
    /// mode.
    Pattern(Option<PendingCommand>),
    Streaming,
}

impl Modes<'_> {
    pub async fn run(&self) -> ! {
        let mut mode = Mode::Pattern(None);
        loop {
            mode = match mode {
                Mode::Pattern(command) => self.pattern(command).await,
                Mode::Streaming => self.streaming().await,
            };
        }
    }

    /// Run patterns until another mode may take over (rule 1).
    async fn pattern(&self, command: Option<PendingCommand>) -> Mode {
        info!("Pattern mode");
        let patterns =
            self.pattern_runner
                .run_from(command, self.motion, AnyPattern::all_builtin(), Delay);
        match select(patterns, self.owned_stream()).await {
            Either::First(never) => never,
            Either::Second(()) => Mode::Streaming,
        }
    }

    /// Prepare, stream until a pattern command other than play, then leave
    /// (rules 2 and 3).
    async fn streaming(&self) -> Mode {
        info!("Streaming mode");
        let _active = self.stream_runner.activate();
        let mut command = None;
        if self.prepare(&mut command).await.is_ok() {
            let take = async {
                while command.is_none() {
                    keep(&mut command, self.pattern_runner.take_command().await);
                }
            };
            match select(take, self.stream()).await {
                Either::First(()) => {}
                Either::Second(never) => never,
            }
        }
        self.leave(&mut command).await;
        Mode::Pattern(command)
    }

    /// End the stream with a controlled stop, disable the machine and zero
    /// the speed (rule 3).
    async fn leave(&self, command: &mut Option<PendingCommand>) {
        self.operate(self.motion.end_stream(), command).await;
        if self.operate(self.motion.disable(), command).await == StateResponse::Fault {
            error!("Board fault during disable");
        }
        self.patterns.set_speed(0.0);
    }

    /// Wait for the first point received while streaming may take over
    /// (rule 1), dropping the others.
    async fn owned_stream(&self) {
        loop {
            self.stream_runner.wait_for_stream().await;
            let reason = if self.patterns.input().velocity <= 0.0 {
                "speed is zero"
            } else if !matches!(
                self.patterns.state(),
                EngineState::Idle | EngineState::Ready
            ) || self.pattern_runner.state_operation_in_flight()
            {
                "pattern session active"
            } else {
                return;
            };
            debug!("Streamed point dropped: {reason}");
        }
    }

    /// Bring the controller to rest in `Ready`, enabling and homing as needed
    /// until a pattern command aborts (rule 2). Pattern commands are taken
    /// into `command` (rule 3).
    async fn prepare(&self, command: &mut Option<PendingCommand>) -> Result<(), ()> {
        loop {
            while let Some(taken) = self.pattern_runner.try_take_command() {
                keep(command, taken);
            }
            if command.is_some() {
                info!("Streaming aborted before it started");
                return Err(());
            }
            let response = match self.motion.state().phase {
                MotionPhase::Ready => return Ok(()),
                MotionPhase::Moving | MotionPhase::Stopping => {
                    Timer::after_millis(10).await;
                    continue;
                }
                MotionPhase::Disabled => self.operate(self.motion.enable(), command).await,
                MotionPhase::Enabled | MotionPhase::Paused => {
                    self.operate(self.motion.home(), command).await
                }
            };
            if response != StateResponse::Completed {
                error!("Preparing for streaming failed");
                return Err(());
            }
        }
    }

    /// Await a motion operation to completion, meanwhile taking pattern
    /// commands into `command` so that none are dropped by a full queue.
    async fn operate<T>(
        &self,
        operation: impl Future<Output = T>,
        command: &mut Option<PendingCommand>,
    ) -> T {
        // Taking a command is cancel-safe: it is only removed from the
        // queue when the take completes.
        let take = async {
            loop {
                keep(command, self.pattern_runner.take_command().await);
            }
        };
        match select(operation, take).await {
            Either::First(response) => response,
            Either::Second(never) => never,
        }
    }

    /// Stream from the next point (rule 2).
    async fn stream(&self) -> ! {
        let start = self.stream_runner.wait_for_stream().await;
        // Sensation (-1.0..1.0) sets the jerk setting (0.0..1.0): streaming
        // has no use for sensation, so remotes reuse its control.
        let input = || {
            let pattern = self.patterns.input();
            StreamInput {
                depth: pattern.depth,
                stroke: pattern.stroke,
                velocity: pattern.velocity,
                jerk: (pattern.sensation + 1.0) / 2.0,
            }
        };
        self.stream_runner.run(start, self.motion, input).await
    }
}

/// Keep `taken` unless it plays a pattern (rule 1).
fn keep(kept: &mut Option<PendingCommand>, taken: PendingCommand) {
    if taken.is_play() {
        warn!("Pattern play dropped: streaming");
    } else {
        *kept = Some(taken);
    }
}
