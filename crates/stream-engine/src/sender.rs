use embassy_time::Instant;

use crate::PushError;
use crate::engine::{EngineCommand, StreamEngine};
use crate::input::StreamInput;

/// Sender half of the stream engine.
///
/// Pushes streamed points, mutates the live stream input (`set_speed`,
/// `set_depth`, `set_stroke`, `set_jerk`), and stops the stream.
///
/// Produced by [`StreamEngine::split`](crate::StreamEngine::split). Not
/// [`Clone`] and not publicly constructible.
pub struct StreamSender {
    engine: &'static StreamEngine,
}

impl StreamSender {
    pub(crate) fn new(engine: &'static StreamEngine) -> Self {
        Self { engine }
    }

    /// Stream a point: reach `position` (0 = deep end, 100 = shallow end)
    /// `duration_ms` after the previous point, or after now if the stream
    /// has caught up (see [`StreamPlanner::push`](crate::StreamPlanner::push)).
    ///
    /// The point is stamped with the current time. A point that does not fit
    /// into the command queue is dropped with [`PushError::QueueFull`] and,
    /// unlike a point dropped by the planner, does not advance the stream
    /// timeline.
    pub fn push(&self, position: f64, duration_ms: u32) -> Result<(), PushError> {
        if !position.is_finite() {
            return Err(PushError::InvalidPosition);
        }
        self.engine
            .commands
            .try_send(EngineCommand::Point {
                received_ms: Instant::now().as_millis(),
                position,
                duration_ms,
            })
            .map_err(|_| PushError::QueueFull)
    }

    /// Stop streaming: drop queued points and bring the machine to a
    /// controlled stop. Points pushed afterwards start a new stream.
    pub fn stop(&self) {
        self.engine.commands.clear();
        let _ = self.engine.commands.try_send(EngineCommand::Stop);
    }

    /// Set velocity as a fraction of max velocity. Clamped to `0.0..=1.0`.
    /// Zero holds the position while the stream keeps its schedule.
    pub fn set_speed(&self, value: f64) {
        self.modify(|input| input.velocity = value);
    }

    /// Set stroke as a fraction of depth. Clamped to `0.0..=1.0`.
    pub fn set_stroke(&self, value: f64) {
        self.modify(|input| input.stroke = value);
    }

    /// Set depth as a fraction of machine range. Clamped to `0.0..=1.0`.
    pub fn set_depth(&self, value: f64) {
        self.modify(|input| input.depth = value);
    }

    /// Set the jerk setting (0.0 = smooth, 1.0 = choppy). Clamped to
    /// `0.0..=1.0`.
    pub fn set_jerk(&self, value: f64) {
        self.modify(|input| input.jerk = value);
    }

    /// Current stream input (depth, stroke, velocity, jerk).
    pub fn input(&self) -> StreamInput {
        self.engine.input.try_get().unwrap_or(StreamInput::DEFAULT)
    }

    fn modify(&self, f: impl Fn(&mut StreamInput)) {
        self.engine.input.sender().send_modify(|opt| {
            if let Some(input) = opt {
                f(input);
                *input = input.clamped();
            }
        });
    }
}
