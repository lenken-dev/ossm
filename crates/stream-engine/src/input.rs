use crate::StrokeRange;
use crate::range::unit;

/// User settings applied to streamed motion.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StreamInput {
    /// Deepest permitted target as a fraction of the machine range (0.0–1.0).
    pub depth: f64,
    /// Stroke as a fraction of depth (0.0–1.0).
    /// Shallowest point = `depth * (1.0 - stroke)`.
    pub stroke: f64,
    /// Velocity limit as a fraction of max velocity (0.0–1.0). Zero holds
    /// the position: streamed points are consumed on schedule but not
    /// executed.
    pub velocity: f64,
    /// Jerk setting (0.0 = smooth, 1.0 = choppy).
    pub jerk: f64,
}

impl StreamInput {
    /// Mirrors the pattern engine's defaults; the jerk setting matches the
    /// pattern motion default.
    pub const DEFAULT: Self = Self {
        depth: 0.5,
        stroke: 0.5,
        velocity: 0.0,
        jerk: 0.5,
    };

    /// All settings clamped to 0.0–1.0; non-finite values become 0.0.
    pub fn clamped(self) -> Self {
        Self {
            depth: unit(self.depth),
            stroke: unit(self.stroke),
            velocity: unit(self.velocity),
            jerk: unit(self.jerk),
        }
    }

    /// The stroke range streamed points are mapped into.
    pub fn stroke_range(&self) -> StrokeRange {
        StrokeRange {
            depth: self.depth,
            stroke: self.stroke,
        }
    }
}

impl Default for StreamInput {
    fn default() -> Self {
        Self::DEFAULT
    }
}
