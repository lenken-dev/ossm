//! Switching between pattern and streamed motion.
//!
//! The pattern engine drives the machine until a streamed point starts
//! streaming. Streaming then lasts until the next pattern command (play,
//! stop, pause, ...) from any remote, which the pattern engine processes once
//! it runs again. Streaming uses the pattern input (depth, stroke, speed), so
//! every remote controls both modes.
//!
//! Rules:
//! 1. Ownership: a point starts streaming only while no pattern session
//!    exists (the pattern engine is idle or ready, with no motion state
//!    operation in flight) and the speed setting is above zero. Other points
//!    are dropped. A playing or paused pattern must be stopped first.
//! 2. Armed or abort: before each step of preparing the machine (enabling,
//!    homing), streaming must still be armed: speed above zero and no pattern
//!    command. Otherwise preparing aborts to pattern mode without further
//!    motion. Issued operations are awaited, never cancelled, so each gets
//!    its own response.
//! 3. No lost commands: pattern commands arriving while preparing are taken,
//!    keeping the dominant one (the latest stop-like one, else the latest),
//!    and so are those arriving while leaving streaming. Leaving streaming
//!    ends the stream with a controlled stop and disables the machine, then
//!    hands the dominant command to the pattern engine. Unless that command
//!    plays a pattern, the speed is set to zero before, so later points
//!    cannot restart motion until the speed is raised.

use core::cell::Cell;
use core::future::Future;

use embassy_futures::select::{Either, select};
use embassy_time::{Delay, Duration, Ticker, Timer};
use log::{error, info, warn};
use ossm::{MotionLimits, MotionPhase, MotionSender, StateResponse};
use pattern_engine::{AnyPattern, EngineState, PatternRunner, PatternSender, PendingCommand};
use stream_engine::{StreamRunner, StreamSender, StreamStart};

/// How often the stream input follows the pattern input.
const INPUT_SYNC_INTERVAL: Duration = Duration::from_millis(10);

pub struct Modes<'a> {
    pub motion: &'a MotionSender,
    pub limits: &'a MotionLimits,
    pub patterns: &'a PatternSender,
    pub pattern_runner: PatternRunner,
    pub stream: &'a StreamSender,
    pub stream_runner: StreamRunner,
}

impl Modes<'_> {
    pub async fn run(&self) -> ! {
        let ignored = Cell::new(0);
        let mut command = None;
        loop {
            let patterns = self.pattern_runner.run_from(
                command.take(),
                self.motion,
                AnyPattern::all_builtin(),
                Delay,
            );
            let start = match select(patterns, self.owned_stream(&ignored)).await {
                Either::First(never) => never,
                Either::Second(start) => start,
            };

            info!("Streaming mode ({} points dropped before)", ignored.take());
            let _active = self.stream_runner.activate();
            command = match self.prepare(&mut command).await {
                Ok(homed) => {
                    let streaming = self.stream(start, homed, &ignored);
                    match select(self.pattern_runner.take_command(), streaming).await {
                        Either::First(command) => Some(command),
                        Either::Second(never) => never,
                    }
                }
                Err(()) => command,
            };

            info!("Pattern mode");
            self.operate(self.motion.end_stream(), &mut command).await;
            if self.operate(self.motion.disable(), &mut command).await == StateResponse::Fault {
                error!("Board fault during disable");
            }
            if !command.as_ref().is_some_and(PendingCommand::is_play) {
                self.patterns.set_speed(0.0);
            }
        }
    }

    /// Wait for the first point received while streaming may take over
    /// (rule 1), dropping the others.
    async fn owned_stream(&self, ignored: &Cell<u32>) -> StreamStart {
        loop {
            let start = self.stream_runner.wait_for_stream().await;
            let reason = if self.patterns.input().velocity <= 0.0 {
                "speed is zero"
            } else if !matches!(
                self.patterns.state(),
                EngineState::Idle | EngineState::Ready
            ) || self.pattern_runner.state_operation_in_flight()
            {
                "pattern session active"
            } else {
                return start;
            };
            if ignored.replace(ignored.get() + 1) == 0 {
                warn!("Streamed point dropped: {reason}");
            }
        }
    }

    /// Bring the controller to rest in `Ready`, enabling and homing as needed
    /// while armed (rule 2). Pattern commands are taken into `command`
    /// (rule 3). Returns whether it homed.
    async fn prepare(&self, command: &mut Option<PendingCommand>) -> Result<bool, ()> {
        let mut homed = false;
        loop {
            while let Some(taken) = self.pattern_runner.try_take_command() {
                keep_dominant(command, taken);
            }
            if command.is_some() || self.patterns.input().velocity <= 0.0 {
                info!("Streaming aborted before it started");
                return Err(());
            }
            let response = match self.motion.state().phase {
                MotionPhase::Ready => return Ok(homed),
                MotionPhase::Moving | MotionPhase::Stopping => {
                    Timer::after_millis(10).await;
                    continue;
                }
                MotionPhase::Disabled => self.operate(self.motion.enable(), command).await,
                MotionPhase::Enabled | MotionPhase::Paused => {
                    homed = true;
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
                let taken = self.pattern_runner.take_command().await;
                keep_dominant(command, taken);
            }
        };
        match select(operation, take).await {
            Either::First(response) => response,
            Either::Second(never) => never,
        }
    }

    /// Stream from `start`, or from a fresh start if preparing homed: points
    /// received while homing are stale.
    async fn stream(&self, start: StreamStart, homed: bool, ignored: &Cell<u32>) -> ! {
        let start = if homed {
            self.owned_stream(ignored).await
        } else {
            start
        };
        self.sync_input();
        let sync = async {
            let mut ticker = Ticker::every(INPUT_SYNC_INTERVAL);
            loop {
                ticker.next().await;
                self.sync_input();
            }
        };
        let run = self.stream_runner.run(start, self.motion, self.limits);
        match select(run, sync).await {
            Either::First(never) | Either::Second(never) => never,
        }
    }

    /// Apply the pattern input to the stream. Jerk keeps its default.
    fn sync_input(&self) {
        let pattern = self.patterns.input();
        let stream = self.stream.input();
        if (pattern.depth, pattern.stroke, pattern.velocity)
            != (stream.depth, stream.stroke, stream.velocity)
        {
            self.stream.set_depth(pattern.depth);
            self.stream.set_stroke(pattern.stroke);
            self.stream.set_speed(pattern.velocity);
        }
    }
}

/// Keep the latest stop-like command, else the latest command.
fn keep_dominant(kept: &mut Option<PendingCommand>, taken: PendingCommand) {
    if !(taken.is_play() && kept.as_ref().is_some_and(|kept| !kept.is_play())) {
        *kept = Some(taken);
    }
}
