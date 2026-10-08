/// `value` clamped to 0.0–1.0; non-finite values become 0.0.
pub(crate) fn unit(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

/// The stroke range streamed points are mapped into.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StrokeRange {
    /// Deepest permitted target as a machine position (0.0–1.0).
    pub depth: f64,
    /// Fraction of depth used for travel (0.0–1.0).
    pub stroke: f64,
}

impl StrokeRange {
    /// The whole machine range.
    pub const FULL: Self = Self {
        depth: 1.0,
        stroke: 1.0,
    };

    /// Clamp both settings to 0.0–1.0. Non-finite values fall back to 0.0,
    /// which collapses travel instead of extending it.
    pub fn sanitized(self) -> Self {
        Self {
            depth: unit(self.depth),
            stroke: unit(self.stroke),
        }
    }

    /// Map a stroke position (0.0 = shallowest, 1.0 = deepest) to a machine
    /// position.
    ///
    /// Mirrors the pattern engine's mapping (`compute_command` in
    /// `pattern-engine/src/pattern.rs`): shallow = depth - depth * stroke,
    /// deep = depth.
    pub fn machine_position(&self, stroke_position: f64) -> f64 {
        let Self { depth, stroke } = self.sanitized();
        let stroke_length = depth * stroke;
        let shallow = depth - stroke_length;
        shallow + stroke_position.clamp(0.0, 1.0) * stroke_length
    }

    /// Map a streamed position (0 = deep end, 100 = shallow end, matching
    /// OSSM-Lite) to a machine position.
    pub fn stream_to_machine(&self, stream_position: f64) -> f64 {
        self.machine_position(1.0 - stream_position / 100.0)
    }
}

impl Default for StrokeRange {
    fn default() -> Self {
        Self::FULL
    }
}
