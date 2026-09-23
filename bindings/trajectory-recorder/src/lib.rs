extern crate alloc;
use alloc::string::String;

mod recorder;
mod stream_recorder;

use ossm::planner::RuckigPlanner;
use ossm::{MotionLimits, MotionReceiver, MotionSender, Ossm};
use pattern_engine::{AnyPattern, PatternInput, SharedPatternInput};
use recorder::{PatternRecorder, Sample};
use static_cell::StaticCell;
use stream_engine::StreamInput;
use stream_recorder::StreamRecorder;
use wasm_bindgen::prelude::*;

static RECORDER_OSSM_CELL: StaticCell<Ossm> = StaticCell::new();
static STREAM_OSSM_CELL: StaticCell<Ossm> = StaticCell::new();
static RECORDER_INPUT: SharedPatternInput = SharedPatternInput::new();

const LIMITS: MotionLimits = MotionLimits::DEFAULT;
const RANGE_MM: f64 = LIMITS.max_position_mm - LIMITS.min_position_mm;

// Matches firmware UPDATE_INTERVAL_SECS so the graph reflects what hardware actually does.
const TIMESTEP_MS: f64 = 10.0;

#[wasm_bindgen]
pub struct TrajectoryRecorder {
    receiver: MotionReceiver,
    motion: MotionSender,
    stream: StreamRecorder,
}

#[wasm_bindgen]
impl TrajectoryRecorder {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        let (receiver, _observer, motion) = RECORDER_OSSM_CELL.init(Ossm::new()).split();
        let (stream_receiver, _observer, stream_motion) =
            STREAM_OSSM_CELL.init(Ossm::new()).split();
        Self {
            receiver,
            motion,
            stream: StreamRecorder::new(stream_receiver, stream_motion, LIMITS),
        }
    }

    pub fn min_position_mm(&self) -> f64 {
        LIMITS.min_position_mm
    }

    pub fn max_position_mm(&self) -> f64 {
        LIMITS.max_position_mm
    }

    pub fn timestep_ms(&self) -> f64 {
        TIMESTEP_MS
    }

    /// Record a trajectory returning three `Float32Array`s: position,
    /// velocity, and acceleration (all in the 0-1 domain).
    pub fn record(
        &self,
        pattern: usize,
        depth: f64,
        stroke: f64,
        velocity: f64,
        sensation: f64,
        max_samples: usize,
    ) -> TrajectoryResult {
        let timestep_secs = TIMESTEP_MS / 1000.0;

        let mut planner = RuckigPlanner::new(
            LIMITS.max_velocity_mm_s / RANGE_MM,
            LIMITS.max_acceleration_mm_s2 / RANGE_MM,
            LIMITS.max_jerk_mm_s3 / RANGE_MM,
            timestep_secs,
        );

        let mut patterns = AnyPattern::all_builtin();
        let Some(pat) = patterns.get_mut(pattern) else {
            return TrajectoryResult::empty();
        };

        let input = PatternInput {
            depth,
            stroke,
            velocity,
            sensation,
        };

        let rest_position = depth * (1.0 - stroke);

        let recorder = PatternRecorder::new(&self.receiver, &RECORDER_INPUT, &self.motion);
        let samples = recorder.record(
            pat,
            &mut planner,
            input,
            rest_position,
            TIMESTEP_MS,
            max_samples,
        );

        TrajectoryResult::from_samples(&samples)
    }

    /// Record streamed motion (a funscript) returning the same arrays as
    /// [`record`](Self::record).
    ///
    /// Point `k` asks to reach `pos[k]` (0-100, 100 = shallow end) at
    /// `at_ms[k]`. The machine starts at rest at the first point, which is
    /// sample 0; sample `i` is `i` timesteps after `at_ms[0]`. Each following
    /// point is sent `lookahead_points` points before the start of its
    /// segment (0 sends it as its segment starts, like a funscript player).
    /// The points and settings run through the same stream sequencer and
    /// motion controller as the firmware. Recording ends after
    /// `max_samples`, or once the last point is due, nothing is left to
    /// send, and the machine is at rest.
    #[allow(clippy::too_many_arguments)]
    pub fn record_stream(
        &mut self,
        at_ms: &[u32],
        pos: &[f64],
        depth: f64,
        stroke: f64,
        velocity: f64,
        jerk: f64,
        lookahead_points: usize,
        max_samples: usize,
    ) -> TrajectoryResult {
        let input = StreamInput {
            depth,
            stroke,
            velocity,
            jerk,
        };
        let samples = self
            .stream
            .record(at_ms, pos, input, lookahead_points, max_samples);
        TrajectoryResult::from_samples(&samples)
    }

    pub fn pattern_count(&self) -> usize {
        AnyPattern::BUILTIN_PATTERNS.len()
    }

    pub fn pattern_name(&self, index: usize) -> String {
        AnyPattern::BUILTIN_PATTERNS
            .get(index)
            .map(|p| String::from(p.name))
            .unwrap_or_default()
    }
}

#[wasm_bindgen]
pub struct TrajectoryResult {
    position: Box<[f32]>,
    velocity: Box<[f32]>,
    acceleration: Box<[f32]>,
}

#[wasm_bindgen]
impl TrajectoryResult {
    #[wasm_bindgen(getter)]
    pub fn position(&self) -> Box<[f32]> {
        self.position.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn velocity(&self) -> Box<[f32]> {
        self.velocity.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn acceleration(&self) -> Box<[f32]> {
        self.acceleration.clone()
    }

    fn from_samples(samples: &[Sample]) -> Self {
        let collect = |f: fn(&Sample) -> f64| samples.iter().map(|s| f(s) as f32).collect();
        Self {
            position: collect(|s| s.position),
            velocity: collect(|s| s.velocity),
            acceleration: collect(|s| s.acceleration),
        }
    }

    fn empty() -> Self {
        Self {
            position: Box::new([]),
            velocity: Box::new([]),
            acceleration: Box::new([]),
        }
    }
}
