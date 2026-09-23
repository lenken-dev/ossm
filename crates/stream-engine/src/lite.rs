//! The OSSM-Lite streaming protocol, as spoken by its funscript player.
//!
//! The player writes streamed points as `<position>:<duration ms>` text and
//! its settings as decimal percent text (0-100). It expresses the stroke
//! range as a minimum and a maximum depth, both as percent of the machine
//! range; these map onto the depth and stroke settings:
//!
//! - maximum depth = depth
//! - minimum depth = depth × (1 − stroke)
//!
//! Changing one of the two depths keeps the other in place. The written
//! depth is clamped so that the minimum never exceeds the maximum.
//!
//! Parsing tolerates surrounding whitespace and trailing NULs.

use crate::StrokeRange;

/// A streamed point as written by the player.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Point {
    /// Stream position, 0 = deep end, 100 = shallow end. Clamped to
    /// `0.0..=100.0`.
    pub position: f64,
    /// Time to reach the position after the previous point.
    pub duration_ms: u32,
}

/// Why a write could not be parsed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParseError {
    /// Not UTF-8 text.
    NotText,
    /// No `:` between position and duration.
    MissingSeparator,
    /// The position is missing, not a number, or not finite.
    Position,
    /// The duration is missing or not a whole number of milliseconds.
    Duration,
    /// The setting is missing, not a number, or not finite.
    Setting,
}

/// Parse a streamed point, `<position>:<duration ms>`.
///
/// The position is a decimal number clamped to `0.0..=100.0`; the duration
/// is an unsigned whole number.
pub fn parse_point(bytes: &[u8]) -> Result<Point, ParseError> {
    let text = text(bytes)?;
    let (position, duration) = text.split_once(':').ok_or(ParseError::MissingSeparator)?;
    let position = number(position).ok_or(ParseError::Position)?;
    let duration_ms = duration
        .trim()
        .parse::<u32>()
        .map_err(|_| ParseError::Duration)?;
    Ok(Point {
        position: position.clamp(0.0, 100.0),
        duration_ms,
    })
}

/// Parse a setting written as decimal percent text, returned as a fraction
/// clamped to `0.0..=1.0`.
pub fn parse_setting(bytes: &[u8]) -> Result<f64, ParseError> {
    let value = number(text(bytes)?).ok_or(ParseError::Setting)?;
    Ok((value / 100.0).clamp(0.0, 1.0))
}

/// A fraction as a whole percent for reading back, rounded to nearest.
/// Clamped to `0..=100`; non-finite values read as zero.
pub fn setting_percent(fraction: f64) -> u8 {
    if !fraction.is_finite() {
        return 0;
    }
    // `as` truncates toward zero, so adding a half rounds a non-negative
    // value to nearest (`f64::round` needs std).
    (fraction.clamp(0.0, 1.0) * 100.0 + 0.5) as u8
}

/// Maximum depth as a machine position (0.0-1.0).
pub fn max_depth(range: StrokeRange) -> f64 {
    range.sanitized().depth
}

/// Minimum depth as a machine position (0.0-1.0).
pub fn min_depth(range: StrokeRange) -> f64 {
    let range = range.sanitized();
    range.depth * (1.0 - range.stroke)
}

/// The stroke range with a new maximum depth (machine position), keeping
/// the minimum depth. The maximum is clamped to at least the minimum.
/// Non-finite values leave the range unchanged.
pub fn with_max_depth(range: StrokeRange, max: f64) -> StrokeRange {
    let range = range.sanitized();
    if !max.is_finite() {
        return range;
    }
    let min = min_depth(range);
    let max = max.clamp(min, 1.0);
    StrokeRange {
        depth: max,
        stroke: stroke_between(min, max, range.stroke),
    }
}

/// The stroke range with a new minimum depth (machine position), keeping
/// the maximum depth. The minimum is clamped to at most the maximum.
/// Non-finite values leave the range unchanged.
pub fn with_min_depth(range: StrokeRange, min: f64) -> StrokeRange {
    let range = range.sanitized();
    if !min.is_finite() {
        return range;
    }
    let max = range.depth;
    let min = min.clamp(0.0, max);
    StrokeRange {
        depth: max,
        stroke: stroke_between(min, max, range.stroke),
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

fn text(bytes: &[u8]) -> Result<&str, ParseError> {
    core::str::from_utf8(bytes)
        .map(|text| text.trim_matches(|c: char| c.is_whitespace() || c == '\0'))
        .map_err(|_| ParseError::NotText)
}

fn number(text: &str) -> Option<f64> {
    text.trim()
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    fn range(depth: f64, stroke: f64) -> StrokeRange {
        StrokeRange { depth, stroke }
    }

    #[test]
    fn parses_points_as_the_player_sends_them() {
        assert_eq!(
            parse_point(b"50:1000"),
            Ok(Point {
                position: 50.0,
                duration_ms: 1000
            })
        );
        assert_eq!(
            parse_point(b"33.5:250"),
            Ok(Point {
                position: 33.5,
                duration_ms: 250
            })
        );
    }

    #[test]
    fn point_parsing_tolerates_whitespace_and_trailing_nul() {
        let expected = Ok(Point {
            position: 100.0,
            duration_ms: 2000,
        });
        assert_eq!(parse_point(b" 100 : 2000 \n"), expected);
        assert_eq!(parse_point(b"100:2000\0"), expected);
        assert_eq!(parse_point(b"100:2000\r\n\0\0"), expected);
    }

    #[test]
    fn point_positions_are_clamped() {
        assert_eq!(parse_point(b"150:10").map(|p| p.position), Ok(100.0));
        assert_eq!(parse_point(b"-5:10").map(|p| p.position), Ok(0.0));
    }

    #[test]
    fn rejects_malformed_points() {
        assert_eq!(parse_point(b""), Err(ParseError::MissingSeparator));
        assert_eq!(parse_point(b"50"), Err(ParseError::MissingSeparator));
        assert_eq!(parse_point(b":100"), Err(ParseError::Position));
        assert_eq!(parse_point(b"abc:100"), Err(ParseError::Position));
        assert_eq!(parse_point(b"NaN:100"), Err(ParseError::Position));
        assert_eq!(parse_point(b"inf:100"), Err(ParseError::Position));
        assert_eq!(parse_point(b"50:"), Err(ParseError::Duration));
        assert_eq!(parse_point(b"50:-1"), Err(ParseError::Duration));
        assert_eq!(parse_point(b"50:1.5"), Err(ParseError::Duration));
        assert_eq!(parse_point(b"50:100:3"), Err(ParseError::Duration));
        assert_eq!(parse_point(b"50:99999999999"), Err(ParseError::Duration));
        assert_eq!(parse_point(&[0xff, b':', b'1']), Err(ParseError::NotText));
    }

    #[test]
    fn parses_settings_as_fractions() {
        assert_eq!(parse_setting(b"42"), Ok(0.42));
        assert_eq!(parse_setting(b" 100\n\0"), Ok(1.0));
        assert_eq!(parse_setting(b"12.5"), Ok(0.125));
        assert_eq!(parse_setting(b"150"), Ok(1.0));
        assert_eq!(parse_setting(b"-3"), Ok(0.0));
    }

    #[test]
    fn rejects_malformed_settings() {
        assert_eq!(parse_setting(b""), Err(ParseError::Setting));
        assert_eq!(parse_setting(b"fast"), Err(ParseError::Setting));
        assert_eq!(parse_setting(b"NaN"), Err(ParseError::Setting));
        assert_eq!(parse_setting(&[0xc3]), Err(ParseError::NotText));
    }

    #[test]
    fn settings_read_back_as_rounded_percent() {
        assert_eq!(setting_percent(0.0), 0);
        assert_eq!(setting_percent(0.424), 42);
        assert_eq!(setting_percent(0.426), 43);
        assert_eq!(setting_percent(1.0), 100);
        assert_eq!(setting_percent(-0.2), 0);
        assert_eq!(setting_percent(1.7), 100);
        assert_eq!(setting_percent(f64::NAN), 0);
    }

    #[test]
    fn depths_follow_depth_and_stroke() {
        let range = range(0.8, 0.75);
        assert!(close(max_depth(range), 0.8));
        assert!(close(min_depth(range), 0.2));
        assert!(close(min_depth(StrokeRange::FULL), 0.0));
    }

    #[test]
    fn setting_max_depth_keeps_min_depth() {
        let updated = with_max_depth(range(0.8, 0.75), 0.5);
        assert!(close(updated.depth, 0.5));
        assert!(close(updated.stroke, 0.6));
        assert!(close(min_depth(updated), 0.2));
    }

    #[test]
    fn setting_min_depth_keeps_max_depth() {
        let updated = with_min_depth(range(0.8, 0.75), 0.4);
        assert!(close(updated.depth, 0.8));
        assert!(close(updated.stroke, 0.5));
        assert!(close(min_depth(updated), 0.4));
    }

    #[test]
    fn written_depth_is_clamped_to_the_other() {
        let below_min = with_max_depth(range(0.8, 0.75), 0.1);
        assert!(close(below_min.depth, 0.2));
        assert!(close(below_min.stroke, 0.0));

        let above_max = with_min_depth(range(0.8, 0.75), 0.9);
        assert!(close(above_max.depth, 0.8));
        assert!(close(above_max.stroke, 0.0));
    }

    #[test]
    fn depths_at_zero_depth() {
        let zero = range(0.0, 0.3);
        assert_eq!(with_min_depth(zero, 0.5), zero);
        let raised = with_max_depth(zero, 0.5);
        assert!(close(raised.depth, 0.5));
        assert!(close(min_depth(raised), 0.0));
    }

    #[test]
    fn non_finite_depths_leave_the_range_unchanged() {
        let range = range(0.8, 0.75);
        assert_eq!(with_max_depth(range, f64::NAN), range);
        assert_eq!(with_min_depth(range, f64::INFINITY), range);
    }

    #[test]
    fn written_percent_reads_back_unchanged() {
        let range = with_min_depth(range(0.8, 0.5), 0.25);
        assert_eq!(setting_percent(min_depth(range)), 25);
        let range = with_max_depth(range, 0.67);
        assert_eq!(setting_percent(max_depth(range)), 67);
        assert_eq!(setting_percent(min_depth(range)), 25);
    }
}
