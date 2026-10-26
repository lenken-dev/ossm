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

    /// Map a streamed position (0 = deep end, 100 = shallow end) to a
    /// machine position.
    pub fn stream_to_machine(&self, stream_position: f64) -> f64 {
        self.machine_position(1.0 - stream_position / 100.0)
    }

    /// Deepest target as a machine position (0.0-1.0).
    pub fn max_depth(self) -> f64 {
        self.sanitized().depth
    }

    /// Shallowest target as a machine position (0.0-1.0).
    pub fn min_depth(self) -> f64 {
        let range = self.sanitized();
        range.depth * (1.0 - range.stroke)
    }

    /// The range with a new maximum depth (machine position), keeping the
    /// minimum depth. The maximum is clamped to at least the minimum.
    /// Non-finite values leave the range unchanged.
    pub fn with_max_depth(self, max: f64) -> Self {
        let range = self.sanitized();
        if !max.is_finite() {
            return range;
        }
        let min = range.min_depth();
        let max = max.clamp(min, 1.0);
        Self {
            depth: max,
            stroke: stroke_between(min, max, range.stroke),
        }
    }

    /// The range with a new minimum depth (machine position), keeping the
    /// maximum depth. The minimum is clamped to at most the maximum.
    /// Non-finite values leave the range unchanged.
    pub fn with_min_depth(self, min: f64) -> Self {
        let range = self.sanitized();
        if !min.is_finite() {
            return range;
        }
        let max = range.depth;
        let min = min.clamp(0.0, max);
        Self {
            depth: max,
            stroke: stroke_between(min, max, range.stroke),
        }
    }
}

/// The stroke setting spanning `min..=max`. At zero depth every stroke
/// gives the same (empty) range, so `current` is kept.
fn stroke_between(min: f64, max: f64, current: f64) -> f64 {
    if max > 0.0 {
        (1.0 - min / max).clamp(0.0, 1.0)
    } else {
        current
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::text::setting_percent;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    fn range(depth: f64, stroke: f64) -> StrokeRange {
        StrokeRange { depth, stroke }
    }

    #[test]
    fn depths_follow_depth_and_stroke() {
        let range = range(0.8, 0.75);
        assert!(close(range.max_depth(), 0.8));
        assert!(close(range.min_depth(), 0.2));
        assert!(close(StrokeRange::FULL.min_depth(), 0.0));
    }

    #[test]
    fn setting_max_depth_keeps_min_depth() {
        let updated = range(0.8, 0.75).with_max_depth(0.5);
        assert!(close(updated.depth, 0.5));
        assert!(close(updated.stroke, 0.6));
        assert!(close(updated.min_depth(), 0.2));
    }

    #[test]
    fn setting_min_depth_keeps_max_depth() {
        let updated = range(0.8, 0.75).with_min_depth(0.4);
        assert!(close(updated.depth, 0.8));
        assert!(close(updated.stroke, 0.5));
        assert!(close(updated.min_depth(), 0.4));
    }

    #[test]
    fn written_depth_is_clamped_to_the_other() {
        let below_min = range(0.8, 0.75).with_max_depth(0.1);
        assert!(close(below_min.depth, 0.2));
        assert!(close(below_min.stroke, 0.0));

        let above_max = range(0.8, 0.75).with_min_depth(0.9);
        assert!(close(above_max.depth, 0.8));
        assert!(close(above_max.stroke, 0.0));
    }

    #[test]
    fn depths_at_zero_depth() {
        let zero = range(0.0, 0.3);
        assert_eq!(zero.with_min_depth(0.5), zero);
        let raised = zero.with_max_depth(0.5);
        assert!(close(raised.depth, 0.5));
        assert!(close(raised.min_depth(), 0.0));
    }

    #[test]
    fn non_finite_depths_leave_the_range_unchanged() {
        let range = range(0.8, 0.75);
        assert_eq!(range.with_max_depth(f64::NAN), range);
        assert_eq!(range.with_min_depth(f64::INFINITY), range);
    }

    #[test]
    fn written_percent_reads_back_unchanged() {
        let range = range(0.8, 0.5).with_min_depth(0.25);
        assert_eq!(setting_percent(range.min_depth()), 25);
        let range = range.with_max_depth(0.67);
        assert_eq!(setting_percent(range.max_depth()), 67);
        assert_eq!(setting_percent(range.min_depth()), 25);
    }
}
