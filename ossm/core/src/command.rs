use embassy_sync::blocking_mutex::raw::CriticalSectionRawMutex;
use embassy_sync::channel::Channel;
use embassy_sync::signal::Signal;

pub(crate) type MoveChannel = Channel<CriticalSectionRawMutex, MotionCommand, 1>;
pub(crate) type StateChannel = Channel<CriticalSectionRawMutex, StateCommand, 1>;
pub(crate) type StateResponseSignal = Signal<CriticalSectionRawMutex, StateResponse>;
pub(crate) type MoveResponseSignal = Signal<CriticalSectionRawMutex, Result<(), Cancelled>>;
pub(crate) type StreamSignal = Signal<CriticalSectionRawMutex, StreamCommand>;
pub(crate) type StreamEndedSignal = Signal<CriticalSectionRawMutex, ()>;

#[derive(Debug, Clone, Copy)]
pub struct MotionCommand {
    /// Target position as a fraction of the machine range (0.0–1.0).
    pub position: f64,
    /// Velocity as a fraction of max velocity (0.0–1.0).
    pub speed: f64,
    /// Jerk modifies motion profile between smooth and choppy (0.0-1.0)
    pub jerk: f64,
    /// Torque limit as a fraction (0.0–1.0). `None` uses the motor default.
    pub torque: Option<f64>,
}

impl MotionCommand {
    pub fn clamped(self) -> Self {
        Self {
            position: self.position.clamp(0.0, 1.0),
            speed: self.speed.clamp(0.0, 1.0),
            jerk: self.jerk.clamp(0.0, 1.0),
            torque: self.torque.map(|t| t.clamp(0.0, 1.0)),
        }
    }
}

/// A streaming move: reach `position` no sooner than `duration` from now,
/// arriving with `velocity`.
///
/// Unlike a [`MotionCommand`], it replaces the current move on the next
/// controller tick and may end in motion. It is meant to be followed by the
/// next streaming move; if none arrives by the time it completes in motion,
/// the controller brings the stream to a controlled stop.
#[derive(Debug, Clone, Copy)]
pub struct StreamMove {
    /// Target position as a fraction of the machine range (0.0–1.0).
    pub position: f64,
    /// Velocity at arrival in machine range fractions per second; positive
    /// toward the maximum position. Limited to the velocity set by `speed`
    /// and to a velocity that can still stop inside the machine range.
    pub velocity: f64,
    /// Minimum duration in seconds. The controller applies the move before
    /// its next sample, planning from the state it sampled last, so the
    /// duration counts from about the time of sending (up to one tick
    /// earlier).
    pub duration: f64,
    /// Velocity limit as a fraction of max velocity (0.0–1.0).
    pub speed: f64,
    /// Jerk modifies motion profile between smooth and choppy (0.0-1.0)
    pub jerk: f64,
}

impl StreamMove {
    pub fn clamped(self) -> Self {
        let finite = |value: f64| if value.is_finite() { value } else { 0.0 };
        Self {
            position: self.position.clamp(0.0, 1.0),
            velocity: finite(self.velocity),
            duration: finite(self.duration).max(0.0),
            speed: self.speed.clamp(0.0, 1.0),
            jerk: self.jerk.clamp(0.0, 1.0),
        }
    }
}

/// The latest streaming instruction. A later one replaces a pending one, so
/// a move after an end continues the stream and an end after a move drops
/// the move.
#[derive(Debug, Clone, Copy)]
pub(crate) enum StreamCommand {
    Move(StreamMove),
    End,
}

#[derive(Debug, Clone, Copy)]
pub enum StateCommand {
    Enable,
    Disable,
    Home,
    Pause,
    Resume,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum StateResponse {
    Completed,
    InvalidTransition,
    /// A board-level fault occurred while processing the command.
    Fault,
}

/// Returned when an in-flight move is cancelled by a state command (e.g. disable, home).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Cancelled;
