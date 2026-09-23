//! Execution of streaming moves on a single-axis Ruckig instance.
//!
//! A streaming move targets a position, an arrival velocity, and a minimum
//! duration. Unlike pattern moves it may end in motion, so it must be
//! followed by another move or a controlled stop.
//!
//! [`StreamExecutor`] works on a caller-owned Ruckig instance, input, and
//! output, so the motion controller and simulators run the same code path.
//! It is unit-agnostic: positions, velocities, and limits use whatever units
//! the Ruckig input uses (the motion controller uses millimetres).
//!
//! Trajectory calculations are expensive on target (several milliseconds
//! each), so the executor runs at most one per control cycle. When a
//! calculation fails, it keeps following the current trajectory and retries
//! with reduced jerk on later cycles.

use num_traits::float::Float;
use rsruckig::prelude::*;

/// Single-axis Ruckig instance as used by the motion controller.
pub type AxisRuckig = Ruckig<1, ThrowErrorHandler>;

/// Recalculations with reduced jerk after a failed calculation, one per
/// control cycle. Each halves the jerk limit. When they are used up, a move
/// is replaced by a controlled stop and a failing stop by holding still.
pub const MAX_JERK_RETRIES: u32 = 4;

const JERK_RETRY_FACTOR: f64 = 0.5;

/// Current velocity below this fraction of the velocity limit is zeroed
/// before planning. Ruckig 2.1.3 fails on such residuals left behind by a
/// completed trajectory.
const RESIDUAL_VELOCITY: f64 = 1e-9;

/// Current acceleration below this fraction of the acceleration limit is
/// zeroed before planning.
const RESIDUAL_ACCELERATION: f64 = 1e-7;

/// Planning raises the jerk limit so that removing the current acceleration
/// changes the velocity by at most this fraction of the velocity limit (up to
/// the machine's jerk limit). With a low jerk setting, a state with high
/// acceleration would otherwise take seconds to settle and run away.
const ACCELERATION_ABSORB_VELOCITY: f64 = 1.0;

/// Trajectories may exceed the position range by this fraction of it, to
/// allow for rounding at targets on its ends.
const RANGE_TOLERANCE: f64 = 1e-9;

/// A trajectory counts as completed once sampled more than this fraction
/// of a cycle past its end, so that a sample landing on the end (with
/// rounding) is not mistaken for coasting.
const END_TOLERANCE_CYCLES: f64 = 0.5;

/// Velocity below this fraction of the velocity limit counts as at rest.
const REST_VELOCITY: f64 = 1e-6;

/// Extra travel, in control cycles at the arrival velocity, reserved when
/// limiting the arrival velocity near the end of the position range: up to
/// one and a half cycles of coasting before a missing follow-up is
/// detected, and half a cycle for duration discretization of the stop.
const STOP_MARGIN_CYCLES: f64 = 2.0;

/// The requested streaming move.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StreamGoal {
    /// Target position.
    pub position: f64,
    /// Signed velocity at arrival. Limited to the velocity limit, and to a
    /// velocity that can still be stopped before the end of the position
    /// range.
    pub velocity: f64,
    /// Minimum duration in seconds, counted from the current state.
    pub min_duration: f64,
}

/// Bounds for a streaming move and the stops that follow it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StreamLimits {
    pub min_position: f64,
    pub max_position: f64,
    /// Velocity limit of the move.
    pub max_velocity: f64,
    pub max_acceleration: f64,
    /// Jerk limit of the move, from the jerk setting.
    pub jerk: f64,
    /// Machine jerk limit. The move's jerk is raised toward it when the
    /// current acceleration requires.
    pub max_jerk: f64,
}

/// Where the trajectory stands after a control cycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepStatus {
    /// The trajectory continues, or a requested plan is still outstanding.
    Working,
    /// The trajectory completed at rest.
    Arrived,
    /// The trajectory completed in motion. A controlled stop is now
    /// mandatory and runs from the next cycle ([`Event::NoFollowUp`]).
    ArrivedInMotion,
}

/// A trajectory calculation run in a control cycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Calculation {
    /// Whether it planned a controlled stop rather than a move.
    pub stop: bool,
    /// Zero for the first attempt, otherwise the number of jerk reductions.
    pub attempt: u32,
    /// Whether the move was given a minimum duration, which makes the
    /// calculation considerably more expensive.
    pub timed: bool,
    /// Whether the calculated trajectory leaves the position range. Such a
    /// move counts as failed and is replaced by an urgent stop, since less
    /// jerk would only overshoot further. Such a stop is retried at the
    /// machine jerk limit, then kept, since holding would stop even more
    /// abruptly.
    pub out_of_range: bool,
    pub succeeded: bool,
}

/// Something the caller may need to react to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    None,
    /// A move completed in motion before a follow-up was calculated; a
    /// controlled stop replaces it.
    NoFollowUp,
    /// A move could not be calculated, even with reduced jerk, or failed
    /// with nothing valid left to follow; a controlled stop replaces it.
    MoveFailed,
    /// Not even a stop could be calculated; the state was frozen at the
    /// current position with zero velocity and acceleration.
    Held,
}

/// Result of one control cycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Step {
    pub status: StepStatus,
    /// The calculation run in this cycle, if any. At most one runs.
    pub calculation: Option<Calculation>,
    pub event: Event,
    /// The sample continues past the end of the followed trajectory, or
    /// extrapolates without one, in motion. Lasts at most one cycle.
    pub coasting: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Plan {
    Move(StreamGoal, StreamLimits),
    Stop,
    /// A trajectory calculated elsewhere, such as a pattern move, followed
    /// until the first streaming calculation succeeds.
    Adopted,
}

enum Outcome {
    Calculated,
    OutOfRange,
    Failed,
}

/// Executes streaming moves and controlled stops, running at most one
/// trajectory calculation per control cycle.
///
/// Call [`start`](Self::start) when streaming begins, request plans with
/// [`request_move`](Self::request_move) and
/// [`request_stop`](Self::request_stop), and call [`step`](Self::step) once
/// per control cycle. Only the latest request is kept, but a requested or
/// required stop cannot be replaced by a move until it is calculated.
pub struct StreamExecutor {
    /// Scratch space, so a failed calculation leaves the followed trajectory
    /// intact.
    scratch: Trajectory<1>,
    /// Requested plan not yet calculated.
    pending: Option<Plan>,
    /// The plan of the trajectory in the output. `None` while there is
    /// none: the state then extrapolates at its current velocity.
    active: Option<Plan>,
    /// A stop is outstanding and moves are refused.
    stop_required: bool,
    /// The outstanding stop recovers from a failure and uses the machine
    /// jerk limit rather than the jerk setting.
    urgent: bool,
    /// Consecutive failed move and stop calculations, across replaced
    /// requests. Any successful calculation resets both.
    move_failures: u32,
    stop_failures: u32,
    /// Limits of the last requested move. Stops use them.
    limits: Option<StreamLimits>,
}

impl Default for StreamExecutor {
    fn default() -> Self {
        Self::new()
    }
}

impl StreamExecutor {
    pub fn new() -> Self {
        Self {
            scratch: Trajectory::new(None),
            pending: None,
            active: None,
            stop_required: false,
            urgent: false,
            move_failures: 0,
            stop_failures: 0,
            limits: None,
        }
    }

    /// Start streaming from the current state. The trajectory in `output` is
    /// followed until the first streaming calculation succeeds, if the
    /// current state lies on it.
    pub fn start(&mut self, input: &InputParameter<1>, output: &OutputParameter<1>) {
        *self = Self {
            scratch: core::mem::replace(&mut self.scratch, Trajectory::new(None)),
            ..Self::new()
        };
        if on_trajectory(input, output) {
            self.active = Some(Plan::Adopted);
        }
    }

    /// Request a move from the state at the next [`step`](Self::step),
    /// replacing any outstanding move request. Returns `false`, ignoring the
    /// move, while a stop is outstanding.
    pub fn request_move(&mut self, goal: StreamGoal, limits: StreamLimits) -> bool {
        if self.stop_required {
            return false;
        }
        self.pending = Some(Plan::Move(goal, limits));
        self.limits = Some(limits);
        true
    }

    /// Request a controlled stop. Has no effect while stopping already.
    pub fn request_stop(&mut self) {
        if self.active != Some(Plan::Stop) || self.pending.is_some() {
            self.require_stop(false);
        }
    }

    fn require_stop(&mut self, urgent: bool) {
        self.pending = Some(Plan::Stop);
        self.stop_required = true;
        self.urgent |= urgent;
    }

    /// Advance by one control cycle, calculating the outstanding plan first
    /// if there is one.
    ///
    /// Like `Ruckig::update`, the new state is in `output` and must be passed
    /// to `input` by the caller. The executor sets the targets and limits in
    /// `input` itself.
    pub fn step(
        &mut self,
        ruckig: &mut AxisRuckig,
        input: &mut InputParameter<1>,
        output: &mut OutputParameter<1>,
    ) -> Step {
        let cycle = ruckig.delta_time;
        let mut event = Event::None;

        if self.pending_repeats_active(output, cycle) {
            self.pending = None;
        }

        // A move ending in motion before the next sample, with no follow-up:
        // plan the stop from its end state now rather than coast.
        let stop_from_end = self.pending.is_none() && self.ends_in_motion(input, output, cycle);
        let resume_time = output.time;
        if stop_from_end {
            event = Event::NoFollowUp;
            self.require_stop(true);
        }

        let mut calculation = None;
        if let Some(plan) = self.pending {
            let stop = plan == Plan::Stop;
            let attempt = if stop {
                self.stop_failures
            } else {
                self.move_failures
            };
            let outcome = self.calculate(ruckig, input, plan, attempt);
            let out_of_range = matches!(outcome, Outcome::OutOfRange);
            let coasting = self.coasting(input, output, cycle);
            let succeeded = match outcome {
                Outcome::Calculated => true,
                // Out of range even at the machine jerk limit, or with
                // nothing else to follow: braking cannot do better.
                Outcome::OutOfRange => stop && (self.urgent || coasting),
                Outcome::Failed => false,
            };
            calculation = Some(Calculation {
                stop,
                attempt,
                timed: input.minimum_duration.is_some(),
                out_of_range,
                succeeded,
            });

            if succeeded {
                let end = output.trajectory.get_duration();
                core::mem::swap(&mut output.trajectory, &mut self.scratch);
                // A stop from the end state continues where the move ended.
                output.time = if stop_from_end {
                    resume_time - end
                } else {
                    0.0
                };
                self.pending = None;
                self.active = Some(plan);
                self.move_failures = 0;
                self.stop_failures = 0;
                self.stop_required = false;
                self.urgent = false;
            } else if stop && out_of_range {
                // Brake harder: retry at the full machine jerk limit. Happens
                // once per stop, so the failure budget stays bounded.
                self.urgent = true;
                self.stop_failures = 0;
            } else {
                if stop {
                    self.stop_failures += 1;
                    if coasting || self.stop_failures > MAX_JERK_RETRIES {
                        self.hold(input, output);
                        return Step {
                            status: StepStatus::Arrived,
                            calculation,
                            event: Event::Held,
                            coasting: false,
                        };
                    }
                } else {
                    self.move_failures += 1;
                    if out_of_range || coasting || self.move_failures > MAX_JERK_RETRIES {
                        event = Event::MoveFailed;
                        self.require_stop(true);
                    } else {
                        self.pending = Some(plan.later(cycle));
                    }
                }
            }
        }

        let finished = self.advance(input, output, cycle);
        let moving = output.new_velocity[0].abs() > input.max_velocity[0] * REST_VELOCITY;
        let status = if !finished {
            StepStatus::Working
        } else if moving {
            // Only one cycle of coasting: stop next cycle, whatever arrives.
            if !self.stop_required {
                event = Event::NoFollowUp;
                self.require_stop(true);
            }
            StepStatus::ArrivedInMotion
        } else if self.pending.is_some() {
            StepStatus::Working
        } else {
            StepStatus::Arrived
        };

        Step {
            status,
            calculation,
            event,
            coasting: finished && moving,
        }
    }

    /// Whether the active move ends in motion before the next sample. If so,
    /// sets the current state in `input` to the move's end state.
    fn ends_in_motion(
        &self,
        input: &mut InputParameter<1>,
        output: &OutputParameter<1>,
        cycle: f64,
    ) -> bool {
        if !matches!(self.active, Some(Plan::Move(..) | Plan::Adopted)) {
            return false;
        }
        let end = output.trajectory.get_duration();
        if output.time + cycle <= end + END_TOLERANCE_CYCLES * cycle {
            return false;
        }
        let mut state = input.clone();
        output.trajectory.at_time(
            end,
            &mut Some(&mut state.current_position),
            &mut Some(&mut state.current_velocity),
            &mut Some(&mut state.current_acceleration),
            &mut None,
            &mut None,
        );
        if state.current_velocity[0].abs() <= input.max_velocity[0] * REST_VELOCITY {
            return false;
        }
        *input = state;
        true
    }

    /// Whether the outstanding request is the move that is already being
    /// followed, so it need not be calculated.
    fn pending_repeats_active(&self, output: &OutputParameter<1>, cycle: f64) -> bool {
        let (Some(Plan::Move(goal, limits)), Some(Plan::Move(active_goal, active_limits))) =
            (self.pending, self.active)
        else {
            return false;
        };
        let remaining = output.trajectory.get_duration() - output.time;
        self.move_failures == 0
            && goal.position == active_goal.position
            && goal.velocity == active_goal.velocity
            && limits == active_limits
            && (goal.min_duration - remaining).abs() <= cycle
    }

    /// Calculate `plan` from the current state into the scratch trajectory.
    fn calculate(
        &mut self,
        ruckig: &mut AxisRuckig,
        input: &mut InputParameter<1>,
        plan: Plan,
        attempt: u32,
    ) -> Outcome {
        let limits = match plan {
            Plan::Move(goal, limits) => {
                configure_move(input, &goal, &limits, ruckig.delta_time);
                Some(limits)
            }
            // Adopted trajectories are never requested.
            Plan::Stop | Plan::Adopted => {
                input.control_interface = ControlInterface::Velocity;
                input.target_velocity[0] = 0.0;
                input.target_acceleration[0] = 0.0;
                input.minimum_duration = None;
                self.limits
            }
        };
        sanitize(input);
        if let Some(limits) = limits {
            input.max_jerk[0] = if plan == Plan::Stop && self.urgent {
                limits.max_jerk
            } else {
                absorbing_jerk(input, &limits)
            };
        }
        input.max_jerk[0] *= Float::powi(JERK_RETRY_FACTOR, attempt as i32);

        if !matches!(
            ruckig.calculate(input, &mut self.scratch),
            Ok(RuckigResult::Working | RuckigResult::Finished)
        ) {
            return Outcome::Failed;
        }
        let Some(limits) = limits else {
            return Outcome::Calculated;
        };
        // A state already outside the range (after a stop that could not
        // stay inside) may head back, but not further out.
        let position = input.current_position[0];
        let tolerance = (limits.max_position - limits.min_position).abs() * RANGE_TOLERANCE;
        let min = limits.min_position.min(position) - tolerance;
        let max = limits.max_position.max(position) + tolerance;
        let (low, high) = position_bounds(&self.scratch);
        if low < min || high > max {
            return Outcome::OutOfRange;
        }
        Outcome::Calculated
    }

    /// Nothing valid is left to follow while moving: the active trajectory
    /// ended in motion, or there is none.
    fn coasting(&self, input: &InputParameter<1>, output: &OutputParameter<1>, cycle: f64) -> bool {
        let moving = input.current_velocity[0].abs() > input.max_velocity[0] * REST_VELOCITY;
        let ended = output.time > output.trajectory.get_duration() + END_TOLERANCE_CYCLES * cycle;
        moving && (self.active.is_none() || ended)
    }

    /// Sample the next state. Returns whether the trajectory has completed.
    fn advance(
        &self,
        input: &InputParameter<1>,
        output: &mut OutputParameter<1>,
        cycle: f64,
    ) -> bool {
        if self.active.is_none() {
            let velocity = input.current_velocity[0];
            output.new_position[0] = input.current_position[0] + velocity * cycle;
            output.new_velocity[0] = velocity;
            output.new_acceleration[0] = 0.0;
            return true;
        }
        output.time += cycle;
        output.trajectory.at_time(
            output.time,
            &mut Some(&mut output.new_position),
            &mut Some(&mut output.new_velocity),
            &mut Some(&mut output.new_acceleration),
            &mut Some(&mut output.new_jerk),
            &mut Some(output.new_section),
        );
        output.time > output.trajectory.get_duration() + END_TOLERANCE_CYCLES * cycle
    }

    /// Stop dead at the current position. Only used when no stop can be
    /// calculated at all.
    fn hold(&mut self, input: &mut InputParameter<1>, output: &mut OutputParameter<1>) {
        self.pending = None;
        self.active = None;
        self.stop_required = false;
        self.urgent = false;
        self.move_failures = 0;
        self.stop_failures = 0;
        input.current_velocity[0] = 0.0;
        input.current_acceleration[0] = 0.0;
        output.new_position[0] = input.current_position[0];
        output.new_velocity[0] = 0.0;
        output.new_acceleration[0] = 0.0;
    }
}

impl Plan {
    /// The plan as seen one cycle later: a move keeps its arrival time.
    fn later(self, cycle: f64) -> Self {
        match self {
            Plan::Move(mut goal, limits) => {
                goal.min_duration = (goal.min_duration - cycle).max(0.0);
                Plan::Move(goal, limits)
            }
            plan => plan,
        }
    }
}

/// Lowest and highest position the trajectory reaches.
///
/// Replaces `Trajectory::get_position_extrema`, which in rsruckig 2.1.3
/// misses turning points inside constant-acceleration phases.
fn position_bounds(trajectory: &Trajectory<1>) -> (f64, f64) {
    let profile = &trajectory.get_profiles()[0][0];
    let mut bounds = (profile.pf, profile.pf);
    let mut include = |p: f64| bounds = (bounds.0.min(p), bounds.1.max(p));
    let brake = &profile.brake;
    let accel = &profile.accel;
    let phases = (0..2)
        .map(|i| (brake.t[i], brake.p[i], brake.v[i], brake.a[i], brake.j[i]))
        .chain((0..7).map(|i| {
            (
                profile.t[i],
                profile.p[i],
                profile.v[i],
                profile.a[i],
                profile.j[i],
            )
        }))
        .chain((0..2).map(|i| (accel.t[i], accel.p[i], accel.v[i], accel.a[i], accel.j[i])));
    for (duration, p, v, a, j) in phases {
        if duration <= 0.0 || duration.is_nan() {
            continue;
        }
        let at = |t: f64| p + t * (v + t * (a / 2.0 + t * j / 6.0));
        include(p);
        include(at(duration));
        // Turning points: roots of v + a t + j t^2 / 2 within the phase.
        let roots = if j == 0.0 {
            [(a != 0.0).then(|| -v / a), None]
        } else {
            let d = a * a - 2.0 * j * v;
            if d < 0.0 {
                [None, None]
            } else {
                let d = Float::sqrt(d);
                [Some((-a - d) / j), Some((-a + d) / j)]
            }
        };
        for t in roots.into_iter().flatten() {
            if t > 0.0 && t < duration {
                include(at(t));
            }
        }
    }
    bounds
}

/// Whether the current state in `input` is the state sampled from the
/// trajectory in `output` at its current time.
fn on_trajectory(input: &InputParameter<1>, output: &OutputParameter<1>) -> bool {
    let mut position = DataArrayOrVec::<f64, 1>::new(None, 0.0);
    let mut velocity = DataArrayOrVec::<f64, 1>::new(None, 0.0);
    output.trajectory.at_time(
        output.time,
        &mut Some(&mut position),
        &mut Some(&mut velocity),
        &mut None,
        &mut None,
        &mut None,
    );
    let close = |a: f64, b: f64| (a - b).abs() <= 1e-9 * (1.0 + a.abs().max(b.abs()));
    output.trajectory.get_duration() > 0.0
        && close(position[0], input.current_position[0])
        && close(velocity[0], input.current_velocity[0])
}

fn configure_move(
    input: &mut InputParameter<1>,
    goal: &StreamGoal,
    limits: &StreamLimits,
    cycle: f64,
) {
    let position = finite_or(goal.position, input.current_position[0])
        .clamp(limits.min_position, limits.max_position);
    let velocity = finite_or(goal.velocity, 0.0).clamp(-limits.max_velocity, limits.max_velocity);
    // Arriving in motion only makes sense while continuing the direction of
    // travel; otherwise the move would overshoot and turn back.
    let travel = position - input.current_position[0];
    let velocity = if velocity * travel > 0.0 {
        limit_to_stop_in_range(velocity, position, limits, cycle)
    } else {
        0.0
    };

    // Set the minimum duration only where it may bind: it makes the
    // calculation expensive, and a move meant to arrive as soon as possible
    // does not need it. No move is faster than covering the distance at the
    // highest velocity involved. The check is conservative: it ignores
    // acceleration and jerk, so it keeps some durations that cannot bind.
    let min_duration = finite_or(goal.min_duration, 0.0);
    let top_velocity = limits.max_velocity.max(input.current_velocity[0].abs());
    let fastest = travel.abs() / top_velocity;
    let binds = min_duration > cycle && min_duration > fastest;

    input.control_interface = ControlInterface::Position;
    input.target_position[0] = position;
    input.target_velocity[0] = velocity;
    input.target_acceleration[0] = 0.0;
    input.minimum_duration = binds.then_some(min_duration);
    input.max_velocity[0] = limits.max_velocity;
    input.max_acceleration[0] = limits.max_acceleration;
}

/// The move's jerk, raised toward the machine limit so that removing the
/// current acceleration changes the velocity by a bounded amount.
fn absorbing_jerk(input: &InputParameter<1>, limits: &StreamLimits) -> f64 {
    let acceleration = input.current_acceleration[0];
    let needed =
        acceleration * acceleration / (2.0 * ACCELERATION_ABSORB_VELOCITY * limits.max_velocity);
    let jerk = limits.jerk.max(needed.min(limits.max_jerk));
    if jerk.is_finite() { jerk } else { limits.jerk }
}

/// Discard residual velocity and acceleration Ruckig cannot plan from.
fn sanitize(input: &mut InputParameter<1>) {
    if input.current_velocity[0].abs() < input.max_velocity[0] * RESIDUAL_VELOCITY {
        input.current_velocity[0] = 0.0;
    }
    if input.current_acceleration[0].abs() < input.max_acceleration[0] * RESIDUAL_ACCELERATION {
        input.current_acceleration[0] = 0.0;
    }
}

/// Limit `velocity` at `position` so that a stop without a follow-up move
/// ends inside the position range.
fn limit_to_stop_in_range(
    velocity: f64,
    position: f64,
    limits: &StreamLimits,
    cycle_secs: f64,
) -> f64 {
    if velocity == 0.0 {
        return 0.0;
    }
    let room = if velocity > 0.0 {
        limits.max_position - position
    } else {
        position - limits.min_position
    };
    let room = room - STOP_MARGIN_CYCLES * velocity.abs() * cycle_secs;
    let max = stoppable_velocity(room, limits.max_acceleration, limits.jerk);
    velocity.clamp(-max, max)
}

/// Highest velocity that a jerk-limited stop from zero acceleration brings
/// to rest within `distance`.
///
/// The stop's acceleration profile is symmetric, so it covers
/// `v / 2 * duration`, with a duration of `v / a + a / j` when the
/// acceleration limit is reached and `2 * sqrt(v / j)` otherwise.
fn stoppable_velocity(distance: f64, acceleration: f64, jerk: f64) -> f64 {
    if !(distance > 0.0 && acceleration > 0.0 && jerk > 0.0) {
        return 0.0;
    }
    // Stopping distance from the velocity at which the limit is just reached.
    let limit_distance = Float::powi(acceleration, 3) / Float::powi(jerk, 2);
    if distance >= limit_distance {
        let b = acceleration * acceleration / jerk;
        (-b + Float::sqrt(b * b + 8.0 * acceleration * distance)) / 2.0
    } else {
        Float::cbrt(distance * distance * jerk)
    }
}

fn finite_or(value: f64, fallback: f64) -> f64 {
    if value.is_finite() { value } else { fallback }
}
