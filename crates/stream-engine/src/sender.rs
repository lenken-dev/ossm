use core::sync::atomic::Ordering;

use embassy_time::Instant;

use crate::PushError;
use crate::engine::{EngineCommand, Point, StreamEngine};

/// Sender half of the stream engine.
///
/// Pushes streamed points and stops the stream. Settings come from the
/// host (see [`StreamRunner::run`](crate::StreamRunner::run)).
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
        self.send_point(position, duration_ms, false)
    }

    /// Stream a point that replaces all queued points and the current move,
    /// due `duration_ms` from now (see
    /// [`StreamPlanner::push_latest`](crate::StreamPlanner::push_latest)):
    /// for a client that sends nothing ahead. Fails as [`push`](Self::push)
    /// does.
    pub fn push_latest(&self, position: f64, duration_ms: u32) -> Result<(), PushError> {
        self.send_point(position, duration_ms, true)
    }

    fn send_point(&self, position: f64, duration_ms: u32, latest: bool) -> Result<(), PushError> {
        if !position.is_finite() {
            return Err(PushError::InvalidPosition);
        }
        self.engine
            .commands
            .try_send(EngineCommand::Point(Point {
                received_ms: Instant::now().as_millis(),
                position,
                duration_ms,
                latest,
            }))
            .map_err(|_| PushError::QueueFull)
    }

    /// Stop streaming: drop queued points and bring the machine to a
    /// controlled stop. Points pushed afterwards start a new stream.
    pub fn stop(&self) {
        self.engine.commands.clear();
        let _ = self.engine.commands.try_send(EngineCommand::Stop);
    }

    /// Whether streaming is active: the runner is running, or its host holds
    /// an [`ActiveGuard`](crate::ActiveGuard) (see
    /// [`StreamRunner::activate`](crate::StreamRunner::activate)).
    pub fn is_active(&self) -> bool {
        self.engine.active.load(Ordering::Acquire) > 0
    }
}
