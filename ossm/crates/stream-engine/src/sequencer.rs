use embassy_futures::poll_once;
use ossm::{MotionLimits, MotionSender, StreamMove};

use crate::input::StreamInput;
use crate::{PlannerConfig, PlannerStats, PushError, StreamPlanner};

/// What a [`StreamSequencer`] asks of the motion controller in a tick.
#[derive(Debug, Clone, Copy)]
pub enum StreamStep {
    /// Send this streaming move.
    Move(StreamMove),
    /// Bring streaming motion to a controlled stop.
    Stop,
}

impl StreamStep {
    /// Forward the step to the motion controller without waiting.
    ///
    /// A stop is requested with
    /// [`MotionSender::end_stream`](ossm::MotionSender::end_stream), whose
    /// first poll signals the controller; the stream keeps going with the
    /// next move instead of waiting for the stop to finish.
    pub fn apply(self, motion: &MotionSender) {
        match self {
            Self::Move(cmd) => motion.stream_move(cmd),
            Self::Stop => {
                let _ = poll_once(motion.end_stream());
            }
        }
    }
}

/// Synchronous core of the stream engine: turns streamed points into
/// [`StreamMove`]s for the motion controller, one controller tick at a time.
///
/// Owns a [`StreamPlanner`] and the current [`StreamInput`], and maps the
/// settings onto both the planner and the moves it emits. The async
/// [`StreamRunner`](crate::StreamRunner) and simulators share it, so they
/// behave identically.
///
/// Call [`push`](Self::push) for every received point and
/// [`tick`](Self::tick) once per controller tick; forward each returned step
/// with [`StreamStep::apply`].
#[derive(Debug)]
pub struct StreamSequencer {
    planner: StreamPlanner,
    input: StreamInput,
    /// Speed at velocity setting 1.0, in machine fraction per second.
    full_speed: f64,
    /// A move was sent since the last stop, so the controller may be
    /// streaming.
    streaming: bool,
}

impl StreamSequencer {
    /// Controller tick the sequencer expects to be called at.
    pub const TICK_MS: u32 = 10;

    /// `limits` must be the motion controller's limits, so that the planner
    /// judges reachability with the speed the controller will allow.
    pub fn new(limits: &MotionLimits, input: StreamInput) -> Self {
        let range = limits.max_position_mm - limits.min_position_mm;
        let full_speed = if range > 0.0 {
            limits.max_velocity_mm_s / range
        } else {
            0.0
        };
        let input = input.clamped();
        let config = PlannerConfig {
            tick_ms: Self::TICK_MS,
            max_velocity: input.velocity * full_speed,
            ..PlannerConfig::default()
        };
        Self {
            planner: StreamPlanner::new(config, input.stroke_range()),
            input,
            full_speed,
            streaming: false,
        }
    }

    pub fn input(&self) -> StreamInput {
        self.input
    }

    /// Apply new settings (clamped, see [`StreamInput::clamped`]).
    ///
    /// A stroke range change re-requests the current or last target. A
    /// velocity or jerk change applies from the next move on.
    pub fn set_input(&mut self, input: StreamInput) {
        let input = input.clamped();
        if input == self.input {
            return;
        }
        self.planner
            .set_max_velocity(input.velocity * self.full_speed);
        self.planner.set_stroke_range(input.stroke_range());
        self.input = input;
    }

    /// Queue a point (see [`StreamPlanner::push`]).
    pub fn push(&mut self, now_ms: u64, position: f64, duration_ms: u32) -> Result<(), PushError> {
        self.planner.push(now_ms, position, duration_ms)
    }

    /// Forget all queued points and the current move. The caller must end
    /// the stream on the controller, since the last move may end in motion.
    pub fn clear(&mut self) {
        self.planner.clear();
        self.streaming = false;
    }

    /// Whether nothing is left to send: no point is queued and no stroke
    /// range change is outstanding.
    pub fn is_idle(&self) -> bool {
        self.planner.is_idle()
    }

    pub fn stats(&self) -> PlannerStats {
        self.planner.stats()
    }

    /// Return what to send to the controller in this tick, if anything.
    ///
    /// `machine_position` is the controller's current planned machine
    /// position (0.0–1.0).
    ///
    /// A velocity setting of zero holds the position: the first tick at zero
    /// stops the stream, and due requests are consumed but not sent, so the
    /// stream keeps its schedule. Once the velocity rises again, streaming
    /// resumes with the next request, never with a target consumed while
    /// holding.
    pub fn tick(&mut self, now_ms: u64, machine_position: f64) -> Option<StreamStep> {
        let request = self.planner.poll(now_ms, machine_position);
        if self.input.velocity <= 0.0 {
            self.planner.discard_current();
            return core::mem::take(&mut self.streaming).then_some(StreamStep::Stop);
        }
        let request = request?;
        self.streaming = true;
        Some(StreamStep::Move(StreamMove {
            position: request.position,
            velocity: request.velocity,
            duration: request.duration_secs(now_ms),
            speed: self.input.velocity,
            jerk: self.input.jerk,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    fn step_move(step: Option<StreamStep>) -> StreamMove {
        match step {
            Some(StreamStep::Move(cmd)) => cmd,
            other => panic!("expected a move, got {other:?}"),
        }
    }

    fn full(velocity: f64, jerk: f64) -> StreamInput {
        StreamInput {
            depth: 1.0,
            stroke: 1.0,
            velocity,
            jerk,
        }
    }

    #[test]
    fn maps_settings_to_planner_and_moves() {
        let limits = MotionLimits::DEFAULT; // 600 mm/s over 180 mm
        let mut seq = StreamSequencer::new(&limits, full(0.5, 0.25));
        assert!(close(
            seq.planner.config().max_velocity,
            0.5 * 600.0 / 180.0
        ));

        seq.push(0, 50.0, 500).unwrap();
        seq.push(0, 0.0, 1000).unwrap(); // continues toward the deep end
        let first = step_move(seq.tick(0, 0.0));
        assert!(close(first.position, 0.5));
        assert!(close(first.duration, 0.5));
        assert!(close(first.velocity, 0.5)); // slower adjacent average speed
        assert!(close(first.speed, 0.5));
        assert!(close(first.jerk, 0.25));

        // Settings are clamped and reach the next move.
        seq.set_input(StreamInput {
            depth: 0.8,
            stroke: 0.5,
            velocity: 2.0,
            jerk: f64::NAN,
        });
        assert!(close(seq.planner.config().max_velocity, 600.0 / 180.0));
        let second = step_move(seq.tick(500, 0.5));
        assert!(close(second.position, 0.8)); // stream 0 = depth
        assert!(close(second.speed, 1.0));
        assert_eq!(second.jerk, 0.0);
    }

    #[test]
    fn emits_moves_only_when_the_planner_requests() {
        let limits = MotionLimits::DEFAULT;
        let mut seq = StreamSequencer::new(&limits, full(1.0, 0.5));
        assert!(seq.tick(0, 0.0).is_none());

        seq.push(0, 0.0, 1000).unwrap();
        step_move(seq.tick(0, 0.0));
        for now in (10..1000).step_by(10) {
            assert!(seq.tick(now, now as f64 / 1000.0).is_none());
        }
        assert_eq!(seq.stats().moves, 1);
    }

    #[test]
    fn zero_velocity_holds_but_keeps_the_schedule() {
        let limits = MotionLimits::DEFAULT;
        let mut seq = StreamSequencer::new(&limits, full(0.0, 0.5));
        seq.push(0, 0.0, 500).unwrap();
        seq.push(0, 100.0, 500).unwrap();
        assert!(seq.tick(0, 0.0).is_none());
        assert_eq!(seq.stats().moves, 1); // consumed on schedule

        seq.set_input(full(1.0, 0.5));
        let request = step_move(seq.tick(500, 0.0));
        assert!(close(request.position, 0.0)); // the second point
        assert!(close(request.duration, 0.5));
    }

    #[test]
    fn zero_velocity_stops_once_and_resumes_with_the_next_point() {
        let limits = MotionLimits::DEFAULT;
        let mut seq = StreamSequencer::new(&limits, full(1.0, 0.5));
        seq.push(0, 50.0, 1000).unwrap();
        step_move(seq.tick(0, 0.0));

        seq.set_input(full(0.0, 0.5));
        assert!(matches!(seq.tick(100, 0.1), Some(StreamStep::Stop)));
        assert!(seq.tick(110, 0.1).is_none());
        // A follow-up would refine the current move, and a range change
        // re-request it, but that target was consumed while holding.
        seq.push(200, 0.0, 1000).unwrap();
        seq.set_input(StreamInput {
            depth: 0.8,
            ..full(0.0, 0.5)
        });
        assert!(seq.tick(200, 0.1).is_none());

        seq.set_input(StreamInput {
            depth: 0.8,
            ..full(1.0, 0.5)
        });
        for now in (300..1000).step_by(10) {
            assert!(seq.tick(now, 0.1).is_none(), "re-requested at {now} ms");
        }
        let resumed = step_move(seq.tick(1000, 0.1));
        assert!(close(resumed.position, 0.8)); // the next point, stream 0
        assert!(close(resumed.duration, 1.0));
        assert!(seq.is_idle());
    }
}
