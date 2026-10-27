#![no_std]

//! Switching between pattern and streamed motion.
//!
//! Idle is the menu: the machine rests and the first pattern command or
//! streamed point picks the next mode. A pattern stop (e.g. `go:menu`)
//! returns to idle from either mode. Streaming uses the pattern input
//! (depth, stroke, speed), so every remote controls both modes.

use core::future::Future;
use core::pin::pin;

use embassy_futures::select::{Either, select};
use embassy_time::{Delay, Timer};
use log::{debug, error, info, warn};
use ossm::{MotionPhase, MotionSender, StateResponse};
use pattern_engine::{AnyPattern, PatternRunner, PatternSender, PendingCommand};
use stream_engine::{StreamInput, StreamRunner};

pub struct Modes<'a> {
    pub motion: &'a MotionSender,
    pub patterns: &'a PatternSender,
    pub pattern_runner: PatternRunner,
    pub stream_runner: StreamRunner,
}

/// The mode driving the machine.
pub enum Mode {
    Idle,
    /// Run patterns, starting with the command that left idle.
    Pattern(PendingCommand),
    Streaming,
}

impl Modes<'_> {
    pub async fn run(&self) -> ! {
        let mut mode = Mode::Idle;
        loop {
            mode = match mode {
                Mode::Idle => self.idle().await,
                Mode::Pattern(command) => self.pattern(command).await,
                Mode::Streaming => self.streaming().await,
            };
        }
    }

    /// Wait for the next mode: a pattern command, or a streamed point while
    /// the speed setting is above zero.
    async fn idle(&self) -> Mode {
        info!("Idle mode");
        let stream = async {
            loop {
                self.stream_runner.wait_for_stream().await;
                if self.patterns.input().velocity > 0.0 {
                    return;
                }
                debug!("Streamed point dropped: speed is zero");
            }
        };
        match select(self.pattern_runner.take_command(), stream).await {
            Either::First(command) => Mode::Pattern(command),
            Either::Second(()) => Mode::Streaming,
        }
    }

    /// Run patterns until the engine is idle. Streamed points are not received
    /// meanwhile.
    async fn pattern(&self, command: PendingCommand) -> Mode {
        info!("Pattern mode");
        let mut patterns = AnyPattern::all_builtin();
        self.pattern_runner
            .run_session(command, self.motion, &mut patterns, Delay)
            .await;
        Mode::Idle
    }

    /// Prepare, stream until a pattern stop, then end the stream and disable
    /// the machine. Other pattern commands are dropped.
    async fn streaming(&self) -> Mode {
        info!("Streaming mode");
        let _active = self.stream_runner.activate();
        if self.prepare().await {
            match select(self.until_stop(), self.stream()).await {
                Either::First(()) => {}
                Either::Second(never) => never,
            }
        }
        self.motion.end_stream().await;
        if self.motion.disable().await == StateResponse::Fault {
            error!("Board fault during disable");
        }
        // A failed prepare leaves without a stop: zero the speed so that
        // later points do not retry at once.
        self.patterns.set_speed(0.0);
        Mode::Idle
    }

    /// Bring the controller to rest in `Ready`, enabling and homing as
    /// needed. False if a pattern stop or a failure aborts.
    async fn prepare(&self) -> bool {
        loop {
            let response = match self.motion.state().phase {
                MotionPhase::Ready => return true,
                MotionPhase::Moving | MotionPhase::Stopping => {
                    Timer::after_millis(10).await;
                    continue;
                }
                MotionPhase::Disabled => self.operate(self.motion.enable()).await,
                MotionPhase::Enabled | MotionPhase::Paused => {
                    self.operate(self.motion.home()).await
                }
            };
            match response {
                Some(StateResponse::Completed) => {}
                Some(_) => {
                    error!("Preparing for streaming failed");
                    return false;
                }
                None => {
                    info!("Streaming aborted before it started");
                    return false;
                }
            }
        }
    }

    /// Await a motion operation to completion, meanwhile taking pattern
    /// commands. None if one was a stop. The operation is never cancelled, so
    /// its response cannot be taken for that of a later one.
    async fn operate(
        &self,
        operation: impl Future<Output = StateResponse>,
    ) -> Option<StateResponse> {
        let mut operation = pin!(operation);
        match select(operation.as_mut(), self.until_stop()).await {
            Either::First(response) => Some(response),
            Either::Second(()) => {
                operation.await;
                None
            }
        }
    }

    /// Take pattern commands until a stop, dropping the others. Cancel-safe:
    /// a command is only removed from the queue when its take completes.
    async fn until_stop(&self) {
        while !self.pattern_runner.take_command().await.is_stop() {
            warn!("Pattern command dropped: streaming");
        }
    }

    /// Stream from the next point: those received while preparing are stale.
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
