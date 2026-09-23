use core::convert::Infallible;
use core::pin::pin;
use core::task::{Context, Poll, Waker};

use alloc::vec::Vec;

use ossm::{
    Board, MotionCommand, MotionController, MotionLimits, MotionPhase, MotionReceiver, MotionSender,
};
use stream_engine::{StreamInput, StreamSequencer};

use crate::recorder::Sample;

/// Controller updates allowed for an unrecorded state change or positioning
/// move before giving up.
const MAX_SETUP_TICKS: usize = 100_000;

/// A board that follows every command at once.
struct RecorderBoard {
    position_mm: f64,
}

impl Board for RecorderBoard {
    type Error = Infallible;

    async fn enable(&mut self) -> Result<(), Infallible> {
        Ok(())
    }

    async fn disable(&mut self) -> Result<(), Infallible> {
        Ok(())
    }

    async fn home(&mut self) -> Result<(), Infallible> {
        Ok(())
    }

    async fn set_position(&mut self, position_mm: f64) -> Result<(), Infallible> {
        self.position_mm = position_mm;
        Ok(())
    }

    async fn set_torque(&mut self, _fraction: f64) -> Result<(), Infallible> {
        Ok(())
    }

    async fn position_mm(&mut self) -> Result<f64, Infallible> {
        Ok(self.position_mm)
    }

    async fn tick(&mut self) -> Result<(), Infallible> {
        Ok(())
    }
}

/// Records streamed motion by running points through a [`StreamSequencer`]
/// and the real [`MotionController`], polled synchronously once per
/// controller tick.
pub struct StreamRecorder {
    controller: MotionController<'static, RecorderBoard>,
    motion: MotionSender,
    limits: MotionLimits,
}

impl StreamRecorder {
    pub fn new(receiver: MotionReceiver, motion: MotionSender, limits: MotionLimits) -> Self {
        let tick_secs = f64::from(StreamSequencer::TICK_MS) / 1000.0;
        let board = RecorderBoard {
            position_mm: limits.min_position_mm,
        };
        Self {
            controller: receiver.into_controller(board, limits.clone(), tick_secs),
            motion,
            limits,
        }
    }

    /// Record the trajectory of a funscript-like stream: point `k` asks to
    /// reach `positions[k]` (0 = deep end, 100 = shallow end) at
    /// `at_ms[k]`.
    ///
    /// The machine starts at rest at the first point, which is sample 0 at
    /// `at_ms[0]`; sample `i` is `i` controller ticks later. Each following
    /// point is pushed `lookahead_points` points before the start of its
    /// segment (0: as its segment starts, as a funscript player sends
    /// them). Recording ends `max_samples` samples in, or once the last
    /// point is due, nothing is left to send, and the machine is at rest.
    pub fn record(
        &mut self,
        at_ms: &[u32],
        positions: &[f64],
        input: StreamInput,
        lookahead_points: usize,
        max_samples: usize,
    ) -> Vec<Sample> {
        let count = at_ms.len().min(positions.len());
        if count == 0 || max_samples == 0 {
            return Vec::new();
        }
        let input = input.clamped();

        self.reset();
        let start = input.stroke_range().stream_to_machine(positions[0]);
        self.move_to(start);

        let mut sequencer = StreamSequencer::new(&self.limits, input);
        let tick_ms = u64::from(StreamSequencer::TICK_MS);
        let first_ms = u64::from(at_ms[0]);
        let last_ms = at_ms[..count].iter().copied().max().map_or(0, u64::from);
        let script_ticks = (last_ms - first_ms) / tick_ms + 1;

        let mut samples = Vec::with_capacity(max_samples.min(script_ticks as usize + 1));
        samples.push(self.sample());

        let mut next = 1;
        let mut push_ms = first_ms;
        let mut now = first_ms;
        while samples.len() < max_samples {
            while next < count {
                let sent_at = (next - 1).saturating_sub(lookahead_points);
                // Sent in order, even if the script is not sorted.
                push_ms = push_ms.max(u64::from(at_ms[sent_at]));
                if push_ms > now {
                    break;
                }
                let duration = at_ms[next].saturating_sub(at_ms[next - 1]);
                let _ = sequencer.push(push_ms, positions[next], duration);
                next += 1;
            }

            let position = f64::from(self.motion.state().position);
            if let Some(step) = sequencer.tick(now, position) {
                step.apply(&self.motion);
            }
            self.update();
            samples.push(self.sample());
            now += tick_ms;

            let done = next == count && now > last_ms && sequencer.is_idle();
            if done && self.motion.state().phase == MotionPhase::Ready {
                break;
            }
        }
        samples
    }

    fn sample(&self) -> Sample {
        let (position, velocity, acceleration) = self.controller.planned_motion();
        Sample {
            position,
            velocity,
            acceleration,
        }
    }

    /// Bring the controller to a known state: homed, at rest at the minimum
    /// position, with no stream or move in progress.
    fn reset(&mut self) {
        drive(&mut self.controller, self.motion.disable());
        drive(&mut self.controller, self.motion.enable());
        drive(&mut self.controller, self.motion.home());
    }

    /// Move to `position` with a pattern move, unrecorded.
    fn move_to(&mut self, position: f64) {
        self.motion.begin_motion(MotionCommand {
            position,
            speed: 1.0,
            jerk: 0.5,
            torque: None,
        });
        // Nothing cancels it: the controller is ready and not streaming.
        let _ = drive(&mut self.controller, self.motion.await_motion());
    }

    fn update(&mut self) {
        update(&mut self.controller);
    }
}

/// Poll `future` to completion, updating the controller between polls.
fn drive<F: Future>(
    controller: &mut MotionController<'static, RecorderBoard>,
    future: F,
) -> F::Output {
    let mut future = pin!(future);
    let mut cx = Context::from_waker(Waker::noop());
    for _ in 0..MAX_SETUP_TICKS {
        if let Poll::Ready(output) = future.as_mut().poll(&mut cx) {
            return output;
        }
        update(controller);
    }
    panic!("motion controller did not settle");
}

fn update(controller: &mut MotionController<'static, RecorderBoard>) {
    let mut future = pin!(controller.update());
    let mut cx = Context::from_waker(Waker::noop());
    // The recorder board completes every call at once, so an update never
    // waits.
    let Poll::Ready(Ok(())) = future.as_mut().poll(&mut cx) else {
        unreachable!("recorder board never waits or fails");
    };
}
