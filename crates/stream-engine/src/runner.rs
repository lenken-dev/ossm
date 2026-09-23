use embassy_time::{Duration, Instant, Ticker};
use log::{info, warn};
use ossm::{MotionLimits, MotionSender};

use crate::engine::{EngineCommand, StreamEngine};
use crate::input::StreamInput;
use crate::sequencer::StreamSequencer;

/// Driver capability for the stream engine.
///
/// Produced by [`StreamEngine::split`](crate::StreamEngine::split). Drives
/// the engine's main loop via [`run`](Self::run). The loop only returns if
/// the host future is dropped (e.g. a mode switch). Dropping it mid-stream
/// leaves the controller streaming: the current move completes and is
/// braked if it ends in motion, but
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

    /// Run the engine forever.
    ///
    /// Idle until the first point arrives, then steps a [`StreamSequencer`]
    /// on the controller's tick and forwards its moves to `motion`. Without
    /// further points the machine finishes at the last target and the
    /// stream stays open. A stop drops queued points and awaits
    /// [`end_stream`](ossm::MotionSender::end_stream) before going idle.
    ///
    /// `limits` must be the motion controller's limits. The controller must
    /// be homed; streamed moves are ignored while it is disabled or paused.
    pub async fn run(&self, motion: &MotionSender, limits: &MotionLimits) -> ! {
        let engine = self.engine;
        let tick = Duration::from_millis(u64::from(StreamSequencer::TICK_MS));

        loop {
            let first = engine.commands.receive().await;
            let EngineCommand::Point {
                received_ms,
                position,
                duration_ms,
            } = first
            else {
                // Make sure no stream from before this run keeps going.
                motion.end_stream().await;
                continue;
            };

            info!("Stream started");
            let mut sequencer = StreamSequencer::new(limits, self.input());
            push(&mut sequencer, received_ms, position, duration_ms);
            let mut ticker = Ticker::every(tick);

            'stream: loop {
                while let Ok(cmd) = engine.commands.try_receive() {
                    match cmd {
                        EngineCommand::Point {
                            received_ms,
                            position,
                            duration_ms,
                        } => push(&mut sequencer, received_ms, position, duration_ms),
                        EngineCommand::Stop => break 'stream,
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
    }

    fn input(&self) -> StreamInput {
        self.engine.input.try_get().unwrap_or(StreamInput::DEFAULT)
    }
}

fn push(sequencer: &mut StreamSequencer, received_ms: u64, position: f64, duration_ms: u32) {
    if let Err(error) = sequencer.push(received_ms, position, duration_ms) {
        warn!("Stream point dropped: {error:?}");
    }
}
