use rsruckig::prelude::*;
use num_traits::float::Float;

use crate::command::{
    Cancelled, MotionCommand, StateCommand, StateResponse, StreamCommand, StreamMove,
};
use crate::planner::stream::{Event, StepStatus, StreamExecutor, StreamGoal, StreamLimits};
use crate::state::MotionPhase;
use crate::{Board, MotionLimits, Ossm};

// Floor applied to velocity requests to prevent degenerate Ruckig inputs.
const MIN_VELOCITY: f64 = 0.001;

#[derive(Debug, Clone, Copy, PartialEq)]
enum MotionState {
    Disabled,
    Enabled,
    Ready,
    Moving,
    /// Ruckig is decelerating to a smooth stop for the given reason.
    Stopping(StopReason),
    /// Motor is stationary; the instructed target is preserved for resume.
    Paused,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum StopReason {
    Pause,
    Disable,
    Home,
    /// Streaming motion ended or could not continue; ends in `Ready`.
    Stream,
}

/// The last-commanded motion intent, independent of what ruckig is currently
/// planning. Pause/resume manipulates the ruckig input while leaving this
/// untouched.
#[derive(Debug, Clone, Copy)]
struct MotionTarget {
    /// Target position (mm).
    position: f64,
    /// Maximum velocity (mm/s).
    velocity: f64,
    /// Maximum acceleration (mm/s/s)
    jerk: f64,
    /// Torque limit as a fraction (0.0–1.0). `None` uses the motor default.
    torque: Option<f64>,
}

/// Drives the motion state machine and enforces safe motion profiles.
///
/// The controller owns a ruckig instance and generates jerk-limited
/// trajectories. Each tick, it samples the trajectory and calls
/// `board.set_position(mm)` with the next point on the curve. The board
/// is a dumb position follower — it never plans its own trajectory.
///
/// # Safety
///
/// Ruckig enforces the acceleration and jerk limits from [`MotionLimits`].
/// No upstream code (patterns, UI, remote) can cause motion that exceeds
/// these limits. The motor's internal trajectory planner is bypassed by
/// configuring it for maximum tracking speed.
pub struct MotionController<'a, B: Board> {
    board: B,
    channels: &'a Ossm,
    state: MotionState,
    limits: MotionLimits,
    /// The last-instructed motion target. `Some` when a move has been commanded,
    /// `None` when there is no active motion intent (e.g. disabled, just homed).
    target: Option<MotionTarget>,
    /// The trajectory was planned from streaming moves. Cleared, with
    /// `stream_ended` signalled, when streaming motion ends.
    streaming: bool,
    /// Plans and samples streaming trajectories on the shared ruckig state.
    stream: StreamExecutor,
    ruckig: Ruckig<1, ThrowErrorHandler>,
    input: InputParameter<1>,
    output: OutputParameter<1>,
}

impl<'a, B: Board> MotionController<'a, B> {
    /// Create a new `MotionController` in the `Disabled` state.
    ///
    /// `update_interval_secs` must match the ticker period the caller uses.
    /// Ruckig uses this as its fixed time step, so timing accuracy matters.
    pub(crate) fn new(
        board: B,
        limits: MotionLimits,
        update_interval_secs: f64,
        channels: &'a Ossm,
    ) -> Self {
        let mut input = InputParameter::new(None);
        input.current_position[0] = limits.min_position_mm;
        input.target_position[0] = limits.min_position_mm;
        input.max_velocity[0] = MIN_VELOCITY;
        input.max_acceleration[0] = limits.max_acceleration_mm_s2;
        input.max_jerk[0] = limits.max_jerk_mm_s3;
        input.synchronization = Synchronization::None;
        input.duration_discretization = DurationDiscretization::Discrete;

        Self {
            board,
            channels,
            state: MotionState::Disabled,
            limits,
            target: None,
            streaming: false,
            stream: StreamExecutor::new(),
            ruckig: Ruckig::<1, ThrowErrorHandler>::new(None, update_interval_secs),
            input,
            output: OutputParameter::new(None),
        }
    }

    /// Advance the motion control loop by one step.
    ///
    /// Returns `Err` if the board reports a critical fault. The caller should
    /// treat this as an unrecoverable error for this control cycle — the
    /// controller will have already transitioned to `Disabled`.
    pub async fn update(&mut self) -> Result<(), B::Error> {
        if let Err(e) = self.board.tick().await {
            log::error!("Board tick fault: {:?}", e);
            self.enter_fault();
            return Err(e);
        }

        // Streaming commands take effect on this tick's sample, so a move
        // can follow one that completes in motion without a coasting tick.
        // Pattern commands keep their place after the tick.
        match self.channels.stream_cmd.try_take() {
            Some(StreamCommand::Move(cmd)) => self.process_stream_move(cmd).await,
            Some(StreamCommand::End) => self.end_stream(),
            None => {}
        }

        self.tick().await?;

        if let Ok(cmd) = self.channels.state_cmd.try_receive() {
            self.process_state_command(cmd).await?;
        }

        if let Ok(cmd) = self.channels.move_cmd.try_receive() {
            self.process_move_command(cmd).await;
        }

        Ok(())
    }

    /// End streaming motion with a controlled stop, dropping any intent to
    /// resume it. `stream_ended` is signalled once streaming has ended.
    fn end_stream(&mut self) {
        if !self.streaming {
            self.channels.stream_ended.signal(());
            return;
        }
        match self.state {
            MotionState::Moving => self.stop_stream(),
            // Already stopping; finish as a stream termination.
            MotionState::Stopping(StopReason::Pause) => {
                self.state = MotionState::Stopping(StopReason::Stream);
            }
            MotionState::Paused => {
                self.target = None;
                self.channels.move_resp.signal(Err(Cancelled));
                self.transition(MotionState::Ready);
            }
            // Stopping for another reason; streaming ends with it.
            _ => {}
        }
    }

    async fn process_state_command(&mut self, cmd: StateCommand) -> Result<(), B::Error> {
        match (&self.state, cmd) {
            (MotionState::Disabled, StateCommand::Enable) => {
                match self.board.enable().await {
                    Ok(()) => {
                        self.transition(MotionState::Enabled);
                        self.respond(StateResponse::Completed);
                    }
                    Err(e) => {
                        log::error!("Board enable failed: {:?}", e);
                        self.respond(StateResponse::Fault);
                        return Err(e);
                    }
                }
            }
            // Idempotent: already in the target state, nothing to do.
            // BLE remote RADR thrashes sometimes causing the catch-all
            // to trigger.
            (MotionState::Enabled, StateCommand::Enable)
            | (MotionState::Disabled, StateCommand::Disable) => {
                self.respond(StateResponse::Completed);
            }
            (MotionState::Enabled | MotionState::Ready, StateCommand::Disable) => {
                self.disable().await;
                self.respond(StateResponse::Completed);
            }
            (MotionState::Paused, StateCommand::Disable) => {
                self.channels.move_resp.signal(Err(Cancelled));
                self.disable().await;
                self.respond(StateResponse::Completed);
            }
            (MotionState::Moving, StateCommand::Disable) => {
                self.channels.move_resp.signal(Err(Cancelled));
                self.stop(StopReason::Disable);
            }
            (MotionState::Stopping(reason), StateCommand::Disable) => {
                // A paused or streaming move is abandoned with the stop.
                if matches!(reason, StopReason::Pause | StopReason::Stream) {
                    self.channels.move_resp.signal(Err(Cancelled));
                }
                self.state = MotionState::Stopping(StopReason::Disable);
            }

            (MotionState::Enabled | MotionState::Ready, StateCommand::Home) => {
                match self.home().await {
                    Ok(()) => self.respond(StateResponse::Completed),
                    Err(e) => {
                        self.respond(StateResponse::Fault);
                        return Err(e);
                    }
                }
            }
            (MotionState::Moving, StateCommand::Home) => {
                self.channels.move_resp.signal(Err(Cancelled));
                self.stop(StopReason::Home);
            }
            (MotionState::Paused, StateCommand::Home) => {
                self.channels.move_resp.signal(Err(Cancelled));
                match self.home().await {
                    Ok(()) => self.respond(StateResponse::Completed),
                    Err(e) => {
                        self.respond(StateResponse::Fault);
                        return Err(e);
                    }
                }
            }

            (MotionState::Moving, StateCommand::Pause) => {
                self.stop(StopReason::Pause);
                self.respond(StateResponse::Completed);
            }

            (MotionState::Paused, StateCommand::Resume) => {
                self.resume().await;
                self.respond(StateResponse::Completed);
            }

            _ => {
                self.respond(StateResponse::InvalidTransition);
            }
        }

        Ok(())
    }

    async fn process_move_command(&mut self, cmd: MotionCommand) {
        if self.streaming {
            // Callers must await `end_stream` first; reject so that no
            // waiter hangs.
            self.channels.move_resp.signal(Err(Cancelled));
            return;
        }
        match self.state {
            MotionState::Ready => {
                self.set_motion_target(cmd);
                self.apply_torque().await;
                self.transition(MotionState::Moving);
            }

            MotionState::Moving => {
                // Only attempt to update the current motion if
                // A. The remaining time of the existing move is more then 1 second
                // B. The current max velocity is 0, indicating the device isn't actually moving
                // C. The current output time is 0, which often indicates an error state.
                // TODO, test again without the output.time check once things are slightly more stable.
                let remaining_time = self.output.trajectory.get_duration() - self.output.time;
                if self.input.max_velocity[0] == 0.0 || remaining_time > 1.0 || self.output.time == 0.0{
                    self.set_motion_target(cmd);
                    self.apply_torque().await;
                }
            }

            _ => {}
        }
    }

    /// Apply a streaming move immediately, bypassing the pattern replanning
    /// gate.
    async fn process_stream_move(&mut self, cmd: StreamMove) {
        let starting = match self.state {
            MotionState::Ready => true,
            MotionState::Moving => !self.streaming,
            MotionState::Stopping(StopReason::Stream) => false,
            _ => return,
        };

        let speed = self.fraction_to_velocity(cmd.speed);
        let target = MotionTarget {
            position: self.fraction_to_mm(cmd.position),
            velocity: speed,
            jerk: self.fraction_to_jerk(cmd.jerk, speed),
            torque: None,
        };
        let range = self.limits.max_position_mm - self.limits.min_position_mm;
        if starting {
            self.stream.start(&self.input, &self.output);
        }
        if !self.request_stream_move(target, cmd.velocity * range, cmd.duration) {
            // A required stop is still being planned.
            return;
        }
        self.target = Some(target);
        self.streaming = true;

        if starting {
            self.apply_torque().await;
        }
        if self.state != MotionState::Moving {
            self.transition(MotionState::Moving);
        }
    }

    /// Request a streaming move toward `target` (mm), arriving with
    /// `velocity` (mm/s) after at least `duration` seconds.
    /// Returns `false` if the executor refused it for an outstanding stop.
    fn request_stream_move(&mut self, target: MotionTarget, velocity: f64, duration: f64) -> bool {
        let goal = StreamGoal {
            position: target.position,
            velocity,
            min_duration: duration,
        };
        let limits = StreamLimits {
            min_position: self.limits.min_position_mm,
            max_position: self.limits.max_position_mm,
            max_velocity: target.velocity,
            max_acceleration: self.limits.max_acceleration_mm_s2,
            jerk: target.jerk,
            max_jerk: self.limits.max_jerk_mm_s3,
        };
        self.stream.request_move(goal, limits)
    }

    /// Bring streaming motion to a controlled stop.
    fn stop_stream(&mut self) {
        self.stream.request_stop();
        self.transition(MotionState::Stopping(StopReason::Stream));
    }

    /// Advance a streaming trajectory, recovering from calculation failures.
    fn step_stream(&mut self) -> StepStatus {
        let step = self
            .stream
            .step(&mut self.ruckig, &mut self.input, &mut self.output);

        if let Some(calc) = step.calculation {
            let kind = if calc.stop { "stop" } else { "move" };
            let attempt = calc.attempt;
            if calc.out_of_range {
                log::warn!("Stream {kind} leaves the machine range (attempt {attempt})");
            } else if !calc.succeeded {
                log::warn!("Stream {kind} calculation failed (attempt {attempt})");
            } else if attempt > 0 {
                log::warn!("Stream {kind} calculated with reduced jerk (attempt {attempt})");
            } else if calc.timed {
                log::trace!("Stream {kind} calculated (timed)");
            } else {
                log::trace!("Stream {kind} calculated");
            }
        }
        if step.coasting {
            log::trace!("Stream coasting");
        }
        match step.event {
            Event::None => {}
            Event::NoFollowUp => {
                log::warn!("Stream move completed in motion without a follow-up, stopping");
            }
            Event::MoveFailed => log::error!("Stream move could not be calculated, stopping"),
            Event::Held => log::error!("Stream stop could not be calculated, holding"),
        }
        if step.event != Event::None && self.state == MotionState::Moving {
            self.transition(MotionState::Stopping(StopReason::Stream));
        }
        step.status
    }

    /// Sample the ruckig trajectory and send the position to the board.
    async fn tick(&mut self) -> Result<(), B::Error> {
        if !matches!(self.state, MotionState::Moving | MotionState::Stopping(_)) {
            return Ok(());
        }

        let status = if self.streaming {
            self.step_stream()
        } else {
            let result = match self.ruckig.update(&self.input, &mut self.output) {
                Ok(result) => result,
                Err(_error) => {
                    // Testing placeholder. Uncomment to see error, but spams the log.
                    // log::info!("Ruckig Error {:?}", _error);
                    return Ok(());
                }
            };

            if !matches!(result, RuckigResult::Working | RuckigResult::Finished) {
                return Ok(());
            }
            if result == RuckigResult::Finished {
                StepStatus::Arrived
            } else {
                StepStatus::Working
            }
        };

        let mm = self.output.new_position[0]
            .clamp(self.limits.min_position_mm, self.limits.max_position_mm);
        if let Err(e) = self.board.set_position(mm).await {
            log::error!("Board set_position failed: {:?}", e);
            self.enter_fault();
            return Err(e);
        }
        self.output.pass_to_input(&mut self.input);
        self.publish_state();

        // `StepStatus::ArrivedInMotion` is not a move completion: the
        // follow-up move usually arrives before the next tick, and the
        // executor stops on the next tick otherwise.
        if status == StepStatus::Arrived {
            match self.state {
                MotionState::Stopping(StopReason::Pause) => {
                    self.transition(MotionState::Paused);
                }
                MotionState::Stopping(StopReason::Disable) => {
                    self.disable().await;
                    self.respond(StateResponse::Completed);
                }
                MotionState::Stopping(StopReason::Home) => match self.home().await {
                    Ok(()) => self.respond(StateResponse::Completed),
                    Err(e) => {
                        self.respond(StateResponse::Fault);
                        return Err(e);
                    }
                },
                MotionState::Stopping(StopReason::Stream) => {
                    self.target = None;
                    self.channels.move_resp.signal(Err(Cancelled));
                    self.transition(MotionState::Ready);
                }
                _ => {
                    self.target = None;
                    self.channels.move_resp.signal(Ok(()));
                    self.transition(MotionState::Ready);
                }
            }
        }

        Ok(())
    }

    /// Run the homing sequence. Transitions to `Ready` on success, stays
    /// `Disabled` on failure.
    async fn home(&mut self) -> Result<(), B::Error> {
        if let Err(e) = self.board.home().await {
            log::error!("Board home failed: {:?}", e);
            self.transition(MotionState::Disabled);
            return Err(e);
        }

        self.input.control_interface = ControlInterface::Position;
        self.input.current_position[0] = self.limits.min_position_mm;
        self.input.target_position[0] = self.limits.min_position_mm;
        self.input.current_velocity[0] = 0.0;
        self.input.current_acceleration[0] = 0.0;

        if let Err(e) = self.board.set_position(self.limits.min_position_mm).await {
            log::error!("Board set_position after home failed: {:?}", e);
            return Err(e);
        }

        self.target = None;
        self.transition(MotionState::Ready);
        Ok(())
    }

    /// Best-effort disable. Logs errors but always transitions to `Disabled`,
    /// because there is no useful recovery if the motor won't turn off.
    async fn disable(&mut self) {
        if let Err(e) = self.board.disable().await {
            log::error!("Board disable failed: {:?}", e);
        }
        self.input.control_interface = ControlInterface::Position;
        self.target = None;
        self.transition(MotionState::Disabled);
    }

    fn stop(&mut self, reason: StopReason) {
        if self.streaming {
            self.stream.request_stop();
            self.transition(MotionState::Stopping(reason));
            return;
        }
        // Switch to velocity control and target zero velocity. Ruckig handles
        // the jerk-limited deceleration trajectory — no manual math needed.
        self.input.control_interface = ControlInterface::Velocity;
        self.input.target_velocity[0] = 0.0;
        self.output.time = 0.0;
        self.transition(MotionState::Stopping(reason));
    }

    async fn resume(&mut self) {
        if self.streaming
            && let Some(target) = self.target
        {
            // Continue to the last streamed target, ending at rest.
            if self.request_stream_move(target, 0.0, 0.0) {
                self.apply_torque().await;
                self.transition(MotionState::Moving);
            }
            return;
        }
        // Switch back to position control and restore the instructed target.
        self.input.control_interface = ControlInterface::Position;
        self.sync_ruckig();
        self.apply_torque().await;
        self.transition(MotionState::Moving);
    }

    /// Cancel any in-flight motion and transition to `Disabled`.
    ///
    /// Called when `board.tick()` reports a critical fault. Signals appropriate
    /// responses on the channels so callers aren't left waiting.
    fn enter_fault(&mut self) {
        match self.state {
            MotionState::Moving | MotionState::Paused => {
                self.channels.move_resp.signal(Err(Cancelled));
            }
            MotionState::Stopping(StopReason::Pause | StopReason::Stream) => {
                self.channels.move_resp.signal(Err(Cancelled));
            }
            MotionState::Stopping(StopReason::Disable | StopReason::Home) => {
                self.respond(StateResponse::Fault);
            }
            _ => {}
        }
        self.target = None;
        self.transition(MotionState::Disabled);
    }

    fn respond(&self, resp: StateResponse) {
        self.channels.state_resp.signal(resp);
    }

    fn fraction_to_mm(&self, fraction: f64) -> f64 {
        let mm = self.limits.min_position_mm
            + fraction * (self.limits.max_position_mm - self.limits.min_position_mm);
        mm.clamp(self.limits.min_position_mm, self.limits.max_position_mm)
    }

    fn fraction_to_velocity(&self, fraction: f64) -> f64 {
        let mm_s = fraction * self.limits.max_velocity_mm_s;
        mm_s.clamp(MIN_VELOCITY, self.limits.max_velocity_mm_s)
    }

    fn ramp_by_exponent(&self, value: f64, exponent: f64) -> f64 {
        let mut ramped = 1.0 - value;
        ramped = ramped.powf(exponent);
        ramped = 1.0 - ramped;
        return ramped.powf(1.0/exponent);
    }

    /// Calculates minimum and maximum jerk values
    /// Minimum based on meeting the requested speed at least momentatirly along the full rail.
    /// Maximum value based on 12mm of jerk distance.
    /// Ramped by the squareroot of the input to allow fine granularity of low values.
    /// Only 95% of the maximum value is potentially used. This seems to make ruckig more stable.
    /// When velocity is slowing, previous jerk is used if it is greater then the new jerk to ensure time to slow down.
    fn fraction_to_jerk(&self, fraction: f64, speed: f64) -> f64 {
        let speed_3 = 2.0 * speed.powf(3.0);
        let max_jerk = 0.95 * speed_3 / 12.0.powf(2.0);
        let rail_2 = (self.limits.max_position_mm - self.limits.min_position_mm).powf(2.0);
        let min_jerk= speed_3 / rail_2;
        let mm_s3 = self.ramp_by_exponent(fraction, 0.5) * max_jerk + min_jerk;
        if self.input.current_velocity[0].abs() > speed && self.input.max_jerk[0] > mm_s3{
            return self.input.max_jerk[0];
        }
        mm_s3.clamp(1.0, self.limits.max_jerk_mm_s3)
    }

    fn set_motion_target(&mut self, cmd: MotionCommand) {
        let speed = self.fraction_to_velocity(cmd.speed);
        self.target = Some(MotionTarget {
            position: self.fraction_to_mm(cmd.position),
            velocity: speed,
            jerk: self.fraction_to_jerk(cmd.jerk, speed),
            torque: cmd.torque,
        });
        self.sync_ruckig();
    }

    /// Write the instructed target into ruckig's input parameters and reset
    /// the trajectory timer so ruckig replans.
    /// If slowing, set current velocity to maximum so that recalculation doesn't overshoot position
    /// This may cause some jerk, but is acceptable compared to the alternative over greatly overshooting the target.
    fn sync_ruckig(&mut self) {
        if let Some(target) = &self.target {
            // Pattern moves end at rest, in position control; a streaming
            // move may have left these set.
            self.input.control_interface = ControlInterface::Position;
            self.input.target_velocity[0] = 0.0;
            self.input.minimum_duration = None;
            self.input.target_position[0] = target.position;
            self.input.max_jerk[0] = target.jerk;
            self.input.max_velocity[0] = target.velocity;
            if self.input.current_velocity[0].abs() > target.velocity {
                self.input.current_velocity[0] = target.velocity * (self.input.current_velocity[0]/self.input.current_velocity[0].abs());
                self.input.current_acceleration[0] = 0.0;
            }
            let _result = match self.ruckig.validate_input(&self.input, true, true){
                Ok(result) => result,
                Err(error) => {
                    log::error!("{:?}", error);
                },
            };
            self.output.time = 0.0;
            self.ruckig.reset();
        }
    }

    async fn apply_torque(&mut self) {
        let fraction = self.target.as_ref().and_then(|t| t.torque).unwrap_or(1.0);
        if let Err(e) = self.board.set_torque(fraction).await {
            log::error!("Board set_torque failed: {:?}", e);
            self.enter_fault();
        }
    }

    fn phase(&self) -> MotionPhase {
        match self.state {
            MotionState::Disabled => MotionPhase::Disabled,
            MotionState::Enabled => MotionPhase::Enabled,
            MotionState::Ready => MotionPhase::Ready,
            MotionState::Moving => MotionPhase::Moving,
            MotionState::Stopping(_) => MotionPhase::Stopping,
            MotionState::Paused => MotionPhase::Paused,
        }
    }

    fn mm_to_fraction(&self, mm: f64) -> f32 {
        let range = self.limits.max_position_mm - self.limits.min_position_mm;
        if range <= 0.0 {
            return 0.0;
        }
        ((mm - self.limits.min_position_mm) / range) as f32
    }

    fn velocity_to_fraction(&self, mm_s: f64) -> f32 {
        if self.limits.max_velocity_mm_s <= 0.0 {
            return 0.0;
        }
        (mm_s / self.limits.max_velocity_mm_s) as f32
    }

    fn acceleration_to_fraction(&self, mm_s2: f64) -> f32 {
        if self.limits.max_acceleration_mm_s2 <= 0.0 {
            return 0.0;
        }
        (mm_s2 / self.limits.max_acceleration_mm_s2) as f32
    }

    fn publish_state(&self) {
        let position_mm = self.output.new_position[0]
            .clamp(self.limits.min_position_mm, self.limits.max_position_mm);
        let velocity_mm_s = self.output.new_velocity[0];
        let acceleration_mm_s2 = self.output.new_acceleration[0];
        let torque = self.target.as_ref().and_then(|t| t.torque).unwrap_or(1.0);

        self.channels.motion_state.update(crate::state::MotionState {
            phase: self.phase(),
            position: self.mm_to_fraction(position_mm),
            velocity: self.velocity_to_fraction(velocity_mm_s.abs()),
            acceleration: self.acceleration_to_fraction(acceleration_mm_s2.abs()),
            torque: torque as f32,
        });
    }

    fn transition(&mut self, new_state: MotionState) {
        if self.streaming
            && !matches!(
                new_state,
                MotionState::Moving | MotionState::Stopping(_) | MotionState::Paused
            )
        {
            self.streaming = false;
            self.channels.stream_ended.signal(());
        }
        self.state = new_state;
        self.publish_state();
        self.channels.motion_state.publish_phase(self.phase());
    }
}
