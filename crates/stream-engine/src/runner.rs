use core::sync::atomic::Ordering;

use embassy_time::{Duration, Instant, Ticker};
use log::{info, warn};
use ossm::{MotionLimits, MotionSender};

use crate::PushError;
use crate::engine::{EngineCommand, StreamEngine};
use crate::input::StreamInput;
use crate::sequencer::StreamSequencer;

/// The first point of a stream, as returned by
/// [`StreamRunner::wait_for_stream`] and consumed by [`StreamRunner::run`].
#[derive(Debug, Clone, Copy)]
pub struct StreamStart(Point);

/// A streamed point, stamped with its reception time plus any delay.
#[derive(Debug, Clone, Copy)]
struct Point {
    received_ms: u64,
    position: f64,
    duration_ms: u32,
}

impl Point {
    /// The point a command carries; `None` for a stop.
    fn from_command(cmd: EngineCommand) -> Option<Self> {
        match cmd {
            EngineCommand::Point {
                received_ms,
                position,
                duration_ms,
            } => Some(Self {
                received_ms,
                position,
                duration_ms,
            }),
            EngineCommand::Stop => None,
        }
    }
}

/// Marks streaming as active while it lives.
///
/// Produced by [`StreamRunner::activate`];
/// [`StreamSender::is_active`](crate::StreamSender::is_active) reports
/// whether any guard is alive.
#[must_use = "streaming is only active while the guard lives"]
pub struct ActiveGuard {
    engine: &'static StreamEngine,
}

impl Drop for ActiveGuard {
    fn drop(&mut self) {
        self.engine.active.fetch_sub(1, Ordering::Release);
    }
}

/// Driver capability for the stream engine.
///
/// Produced by [`StreamEngine::split`](crate::StreamEngine::split). A host
/// that switches modes waits for the first point with
/// [`wait_for_stream`](Self::wait_for_stream), prepares the machine, and
/// then drives the engine's main loop via [`run`](Self::run). The loop only
/// returns if the host future is dropped (e.g. a mode switch). Dropping it
/// mid-stream leaves the controller streaming: the current move completes
/// and is braked if it ends in motion, but
/// [`MotionSender::end_stream`](ossm::MotionSender::end_stream) must still be
/// awaited before pattern motion. By convention only one caller drives a
/// runner at a time.
pub struct StreamRunner {
    engine: &'static StreamEngine,
}

impl StreamRunner {
    pub(crate) fn new(engine: &'static StreamEngine) -> Self {
        Self { engine }
    }

    /// Mark streaming as active until the returned guard is dropped.
    ///
    /// [`run`](Self::run) holds a guard of its own; a host takes one to also
    /// cover the time before and after the run (e.g. homing).
    pub fn activate(&self) -> ActiveGuard {
        self.engine.active.fetch_add(1, Ordering::Acquire);
        ActiveGuard {
            engine: self.engine,
        }
    }

    /// Wait for the first point of a new stream.
    ///
    /// Everything queued before the call is dropped, as are stops while
    /// waiting: they belong to no stream this caller will run.
    pub async fn wait_for_stream(&self) -> StreamStart {
        self.engine.commands.clear();
        loop {
            if let Some(point) = Point::from_command(self.engine.commands.receive().await) {
                return StreamStart(point);
            }
        }
    }

    /// Run the engine forever, starting with the stream that `start`
    /// began.
    ///
    /// Steps a [`StreamSequencer`] on the controller's tick and forwards its
    /// moves to `motion`. Without further points the machine finishes at
    /// the last target and the stream stays open. A stop drops queued points
    /// and awaits [`end_stream`](ossm::MotionSender::end_stream); the next
    /// point starts a new stream.
    ///
    /// `limits` must be the motion controller's limits. The controller must
    /// be homed; streamed moves are ignored while it is disabled or paused.
    pub async fn run(&self, start: StreamStart, motion: &MotionSender, limits: &MotionLimits) -> ! {
        let _active = self.activate();
        let mut start = start;
        loop {
            self.stream(start, motion, limits).await;
            start = self.next_stream(motion).await;
        }
    }

    /// Stream from `start` until a stop, then end the stream.
    async fn stream(&self, start: StreamStart, motion: &MotionSender, limits: &MotionLimits) {
        let engine = self.engine;
        let tick = Duration::from_millis(u64::from(StreamSequencer::TICK_MS));

        info!("Stream started");
        let mut sequencer = StreamSequencer::new(limits, self.input());
        self.push(&mut sequencer, start.0);
        let mut ticker = Ticker::every(tick);

        'stream: loop {
            while let Ok(cmd) = engine.commands.try_receive() {
                match Point::from_command(cmd) {
                    Some(point) => self.push(&mut sequencer, point),
                    None => break 'stream,
                }
            }

            sequencer.set_input(self.input());
            let now = Instant::now().as_millis();
            let position = f64::from(motion.state().position);
            if let Some(step) = sequencer.tick(now, position) {
                step.apply(motion);
            }
            ticker.next().await;
        }

        sequencer.clear();
        motion.end_stream().await;
        let stats = sequencer.stats();
        info!(
            "Stream stopped ({} moves, {} skipped, {} collapsed, {} dropped)",
            stats.moves, stats.skipped, stats.collapsed, stats.dropped
        );
    }

    /// Wait for the first point of the next stream. A stop before it makes
    /// sure no earlier stream keeps going.
    async fn next_stream(&self, motion: &MotionSender) -> StreamStart {
        loop {
            match Point::from_command(self.engine.commands.receive().await) {
                Some(point) => return StreamStart(point),
                None => motion.end_stream().await,
            }
        }
    }

    fn input(&self) -> StreamInput {
        self.engine.input.try_get().unwrap_or(StreamInput::DEFAULT)
    }

    /// Queue a point. Drops for a full queue are counted in the engine and
    /// logged at 1, 2, 4, 8, ... per stream.
    fn push(&self, sequencer: &mut StreamSequencer, point: Point) {
        match sequencer.push(point.received_ms, point.position, point.duration_ms) {
            Ok(()) => {}
            Err(PushError::QueueFull) => {
                self.engine.dropped.fetch_add(1, Ordering::Relaxed);
                let dropped = sequencer.stats().dropped;
                if dropped.is_power_of_two() {
                    warn!("Stream queue full, point dropped ({dropped} so far)");
                }
            }
            Err(error) => warn!("Stream point dropped: {error:?}"),
        }
    }
}

#[cfg(test)]
mod tests {
    extern crate std;

    use core::pin::pin;
    use std::boxed::Box;

    use embassy_futures::{block_on, poll_once};

    use super::*;
    use crate::{StreamPlanner, StreamSender};

    fn split() -> (StreamRunner, StreamSender) {
        Box::leak(Box::new(StreamEngine::new())).split()
    }

    #[test]
    fn wait_for_stream_skips_earlier_points_and_stops() {
        let (runner, sender) = split();
        sender.push(10.0, 100).unwrap();
        sender.stop();

        let mut wait = pin!(runner.wait_for_stream());
        assert!(poll_once(wait.as_mut()).is_pending());
        sender.stop();
        sender.push(42.0, 100).unwrap();
        sender.push(50.0, 100).unwrap();

        let start = block_on(wait);
        assert_eq!(start.0.position, 42.0);
        // Later points stay queued for the run.
        assert_eq!(runner.engine.commands.len(), 1);
    }

    #[test]
    fn counts_points_dropped_for_a_full_queue() {
        let (runner, sender) = split();
        for _ in 0..StreamPlanner::CAPACITY {
            sender.push(50.0, 100).unwrap();
        }
        assert_eq!(sender.push(50.0, 100), Err(PushError::QueueFull));
        assert_eq!(sender.dropped(), 1);

        let mut sequencer = StreamSequencer::new(&MotionLimits::DEFAULT, StreamInput::DEFAULT);
        let point = Point {
            received_ms: 0,
            position: 50.0,
            duration_ms: 100,
        };
        for _ in 0..=StreamPlanner::CAPACITY {
            runner.push(&mut sequencer, point);
        }
        assert_eq!(sequencer.stats().dropped, 1);
        assert_eq!(sender.dropped(), 2);
    }

    #[test]
    fn active_while_any_guard_lives() {
        let (runner, sender) = split();
        assert!(!sender.is_active());
        let outer = runner.activate();
        let inner = runner.activate();
        drop(inner);
        assert!(sender.is_active());
        drop(outer);
        assert!(!sender.is_active());
    }
}
