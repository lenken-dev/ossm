use core::future::Future;
use core::sync::atomic::{AtomicBool, Ordering};

use embassy_futures::select::{self, Either};
use embedded_hal_async::delay::DelayNs;
use log::info;
use ossm::{MotionSender, StateResponse};

use crate::AnyPattern;
use crate::engine::{EngineCommand, EngineState, PatternEngine};
use crate::pattern::{Pattern, PatternCtx};

/// Internal runner state.
#[derive(Debug, Clone, Copy)]
enum RunnerState {
    Idle,
    Homing(Option<usize>),
    Ready,
    Playing(usize),
}

impl RunnerState {
    fn as_engine_state(self) -> EngineState {
        match self {
            Self::Idle => EngineState::Idle,
            Self::Homing(_) => EngineState::Homing,
            Self::Ready => EngineState::Ready,
            Self::Playing(idx) => EngineState::Playing(idx),
        }
    }
}

/// A command taken with [`PatternRunner::take_command`], to be processed
/// by [`PatternRunner::run_from`].
#[derive(Debug, Clone, Copy)]
pub struct PendingCommand(EngineCommand);

impl PendingCommand {
    /// Whether the command plays a pattern, rather than stopping, pausing,
    /// resuming, or homing (a stop-like command).
    pub fn is_play(&self) -> bool {
        matches!(self.0, EngineCommand::Play(_))
    }
}

/// Driver capability for the pattern engine.
///
/// Produced by [`PatternEngine::split`](crate::PatternEngine::split).
/// Drives the engine's main loop via [`run`](Self::run). The loop
/// only returns if the host future is dropped (e.g. a mode switch),
/// at which point the runner is free for another `run` call - each
/// call starts fresh in the idle state. A host that has switched away
/// can take the next command with [`take_command`](Self::take_command)
/// and hand it to [`run_from`](Self::run_from). It should only drop a
/// run while no [state operation is in
/// flight](Self::state_operation_in_flight).
///
/// The runner carries no state of its own; "currently running" is a
/// property of the in-flight future, not the type. Spawning two
/// concurrent `run`s on the same runner would compete for the engine's
/// command channel; by convention only one caller (the active mode, or
/// the firmware boot path) drives a runner at a time.
pub struct PatternRunner {
    engine: &'static PatternEngine,
}

impl PatternRunner {
    pub(crate) fn new(engine: &'static PatternEngine) -> Self {
        Self { engine }
    }

    /// Take the next command while the runner is not running, e.g. to
    /// decide whether to switch back to patterns. Hand it to
    /// [`run_from`](Self::run_from) to process it.
    ///
    /// Input changes (speed, depth, stroke, sensation) are not commands.
    pub async fn take_command(&self) -> PendingCommand {
        PendingCommand(self.engine.commands.receive().await)
    }

    /// [`take_command`](Self::take_command) without waiting.
    pub fn try_take_command(&self) -> Option<PendingCommand> {
        self.engine.commands.try_receive().ok().map(PendingCommand)
    }

    /// Whether a run is waiting for a motion state operation (enable,
    /// disable, home, pause, resume) that it requested.
    ///
    /// Dropping a run while this is set leaves the operation in flight,
    /// and its response could be taken for the response to a later
    /// request.
    pub fn state_operation_in_flight(&self) -> bool {
        self.engine.state_operation.load(Ordering::Acquire)
    }

    /// Run the engine forever, processing commands and driving patterns.
    ///
    /// Starts idle and publishes it, so a run that follows a dropped one
    /// does not report its stale state. Commands queued before the call
    /// are processed.
    ///
    /// `motion` is borrowed for the lifetime of the run. `patterns` is
    /// moved in and lives on the runner's stack frame. `delay` must be
    /// `Clone` so a fresh [`PatternCtx`] can be created each time a
    /// pattern starts (all embassy `Delay` types are `Copy`).
    pub async fn run<const N: usize, D: DelayNs + Clone>(
        &self,
        motion: &MotionSender,
        patterns: [AnyPattern; N],
        delay: D,
    ) -> ! {
        self.run_from(None, motion, patterns, delay).await
    }

    /// [`run`](Self::run), processing `first` before any queued command.
    pub async fn run_from<const N: usize, D: DelayNs + Clone>(
        &self,
        first: Option<PendingCommand>,
        motion: &MotionSender,
        mut patterns: [AnyPattern; N],
        delay: D,
    ) -> ! {
        let engine = self.engine;
        let input = &engine.input;
        let mut state = RunnerState::Idle;
        let mut first = first;
        store_and_publish(engine, EngineState::Idle);

        loop {
            match state {
                RunnerState::Idle | RunnerState::Ready => {
                    let cmd = match first.take() {
                        Some(PendingCommand(cmd)) => cmd,
                        None => engine.commands.receive().await,
                    };
                    handle_command::<N>(engine, motion, cmd, &mut state).await;
                }
                RunnerState::Homing(maybe_idx) => {
                    if state_operation(engine, motion.enable()).await != StateResponse::Completed {
                        log::error!("Enable failed, returning to idle");
                        set_state(engine, &mut state, RunnerState::Idle);
                        continue;
                    }

                    let home_fut = state_operation(engine, motion.home());
                    let mut home_fut = core::pin::pin!(home_fut);

                    loop {
                        let result =
                            select::select(home_fut.as_mut(), engine.commands.receive()).await;

                        match result {
                            Either::First(resp) => {
                                if resp != StateResponse::Completed {
                                    log::error!("Home failed, returning to idle");
                                    set_state(engine, &mut state, RunnerState::Idle);
                                } else {
                                    match maybe_idx {
                                        Some(idx) => {
                                            set_state(engine, &mut state, RunnerState::Playing(idx))
                                        }
                                        None => set_state(engine, &mut state, RunnerState::Ready),
                                    }
                                }
                                break;
                            }
                            Either::Second(EngineCommand::Stop | EngineCommand::Pause) => {
                                if state_operation(engine, motion.disable()).await
                                    == StateResponse::Fault
                                {
                                    log::error!("Board fault during disable");
                                }
                                set_state(engine, &mut state, RunnerState::Idle);
                                break;
                            }
                            Either::Second(_) => {}
                        }
                    }
                }
                RunnerState::Playing(idx) => {
                    let mut ctx = PatternCtx::new(motion, input, delay.clone());
                    let pattern_fut = core::pin::pin!(patterns[idx].run(&mut ctx));
                    let mut pattern_fut = pattern_fut;

                    loop {
                        let result =
                            select::select(pattern_fut.as_mut(), engine.commands.receive()).await;

                        match result {
                            Either::First(_result) => {
                                if matches!(state, RunnerState::Playing(_)) {
                                    state = RunnerState::Idle;
                                    store_and_publish(engine, EngineState::Idle);
                                }
                                break;
                            }
                            Either::Second(cmd) => match cmd {
                                EngineCommand::Pause => {
                                    if state_operation(engine, motion.pause()).await
                                        != StateResponse::Completed
                                    {
                                        log::error!("Pause failed, stopping engine");
                                        state = RunnerState::Idle;
                                        store_and_publish(engine, EngineState::Idle);
                                        break;
                                    }
                                    store_and_publish(engine, EngineState::Paused(idx));
                                }
                                EngineCommand::Resume => {
                                    if state_operation(engine, motion.resume()).await
                                        != StateResponse::Completed
                                    {
                                        log::error!("Resume failed, stopping engine");
                                        state = RunnerState::Idle;
                                        store_and_publish(engine, EngineState::Idle);
                                        break;
                                    }
                                    store_and_publish(engine, EngineState::Playing(idx));
                                }
                                EngineCommand::Play(i) if i == idx => {}
                                EngineCommand::Play(new_idx) if new_idx < N => {
                                    state = RunnerState::Playing(new_idx);
                                    store_and_publish(engine, EngineState::Playing(new_idx));
                                    break;
                                }
                                EngineCommand::Stop => {
                                    if state_operation(engine, motion.disable()).await
                                        == StateResponse::Fault
                                    {
                                        log::error!("Board fault during disable");
                                    }
                                    state = RunnerState::Idle;
                                    store_and_publish(engine, EngineState::Idle);
                                    break;
                                }
                                _ => {}
                            },
                        }
                    }
                }
            }
        }
    }
}

/// Await a motion state operation, flagged as in flight while it runs (see
/// [`PatternRunner::state_operation_in_flight`]).
async fn state_operation(
    engine: &PatternEngine,
    operation: impl Future<Output = StateResponse>,
) -> StateResponse {
    struct InFlight<'a>(&'a AtomicBool);
    impl Drop for InFlight<'_> {
        fn drop(&mut self) {
            self.0.store(false, Ordering::Release);
        }
    }

    engine.state_operation.store(true, Ordering::Release);
    let _in_flight = InFlight(&engine.state_operation);
    operation.await
}

fn set_state(engine: &PatternEngine, current: &mut RunnerState, new_state: RunnerState) {
    *current = new_state;
    let engine_state = new_state.as_engine_state();
    info!("Engine state: {:?}", engine_state);
    store_and_publish(engine, engine_state);
}

fn store_and_publish(engine: &PatternEngine, state: EngineState) {
    engine.state.store(state.encode(), Ordering::Relaxed);
    engine
        .state_channel
        .immediate_publisher()
        .publish_immediate(state);
}

async fn handle_command<const N: usize>(
    engine: &PatternEngine,
    motion: &MotionSender,
    cmd: EngineCommand,
    state: &mut RunnerState,
) {
    match cmd {
        EngineCommand::Play(idx) if idx < N => match *state {
            RunnerState::Idle => set_state(engine, state, RunnerState::Homing(Some(idx))),
            RunnerState::Homing(_) => log::warn!("Ignoring Play command while homing"),
            _ => set_state(engine, state, RunnerState::Playing(idx)),
        },
        EngineCommand::Play(_) => {}
        EngineCommand::Stop => {
            if state_operation(engine, motion.disable()).await == StateResponse::Fault {
                log::error!("Board fault during disable");
            }
            set_state(engine, state, RunnerState::Idle);
        }
        EngineCommand::Home => {
            if let RunnerState::Idle = *state {
                set_state(engine, state, RunnerState::Homing(None));
            }
        }
        EngineCommand::Pause | EngineCommand::Resume => {
            // Only handled inside the Playing inner loop.
        }
    }
}
