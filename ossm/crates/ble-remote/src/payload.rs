//! Payloads remotes write: stream points and settings, as text.
//!
//! Points are `<position>:<duration ms>` text (or `<position>:<time ms>`
//! for timed points); settings are decimal percent text (0-100).
//!
//! Parsing tolerates surrounding whitespace and trailing NULs.

/// A streamed point as written by a remote.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DurationPoint {
    /// Stream position, 0 = deep end, 100 = shallow end. Clamped to
    /// `0.0..=100.0`.
    pub position: f64,
    /// Time to reach the position after the previous point.
    pub duration_ms: u32,
}

/// A timed stream point: a position and the remote's time to reach it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TimedPoint {
    /// As [`DurationPoint::position`].
    pub position: f64,
    /// When to reach the position, on the remote's clock (see
    /// [`ClockOffset`](stream_engine::ClockOffset)).
    pub at_ms: u64,
}

/// Parse a streamed point, `<position>:<duration ms>`.
///
/// The position is a decimal number clamped to `0.0..=100.0`; the duration
/// is an unsigned whole number.
pub fn parse_duration_point(bytes: &[u8]) -> Option<DurationPoint> {
    let (position, duration_ms) = position_and(bytes)?;
    Some(DurationPoint {
        position,
        duration_ms,
    })
}

/// Parse a timed stream point, `<position>:<time ms>`, as
/// [`parse_duration_point`] does.
pub fn parse_timed_point(bytes: &[u8]) -> Option<TimedPoint> {
    let (position, at_ms) = position_and(bytes)?;
    Some(TimedPoint { position, at_ms })
}

fn position_and<T: core::str::FromStr>(bytes: &[u8]) -> Option<(f64, T)> {
    let (position, value) = text(bytes)?.split_once(':')?;
    let position = number(position)?;
    let value = value.trim().parse::<T>().ok()?;
    Some((position.clamp(0.0, 100.0), value))
}

/// Parse a setting written as decimal percent text, returned as a fraction
/// clamped to `0.0..=1.0`.
pub fn parse_setting(bytes: &[u8]) -> Option<f64> {
    let value = number(text(bytes)?)?;
    Some((value / 100.0).clamp(0.0, 1.0))
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

fn text(bytes: &[u8]) -> Option<&str> {
    core::str::from_utf8(bytes)
        .ok()
        .map(|text| text.trim_matches(|c: char| c.is_whitespace() || c == '\0'))
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

    #[test]
    fn parses_points() {
        assert_eq!(
            parse_duration_point(b"50:1000"),
            Some(DurationPoint {
                position: 50.0,
                duration_ms: 1000
            })
        );
        assert_eq!(
            parse_duration_point(b"33.5:250"),
            Some(DurationPoint {
                position: 33.5,
                duration_ms: 250
            })
        );
    }

    #[test]
    fn point_parsing_tolerates_whitespace_and_trailing_nul() {
        let expected = Some(DurationPoint {
            position: 100.0,
            duration_ms: 2000,
        });
        assert_eq!(parse_duration_point(b" 100 : 2000 \n"), expected);
        assert_eq!(parse_duration_point(b"100:2000\0"), expected);
        assert_eq!(parse_duration_point(b"100:2000\r\n\0\0"), expected);
    }

    #[test]
    fn point_positions_are_clamped() {
        assert_eq!(
            parse_duration_point(b"150:10").map(|p| p.position),
            Some(100.0)
        );
        assert_eq!(
            parse_duration_point(b"-5:10").map(|p| p.position),
            Some(0.0)
        );
    }

    #[test]
    fn rejects_malformed_points() {
        assert!(parse_duration_point(b"").is_none());
        assert!(parse_duration_point(b"50").is_none());
        assert!(parse_duration_point(b":100").is_none());
        assert!(parse_duration_point(b"abc:100").is_none());
        assert!(parse_duration_point(b"NaN:100").is_none());
        assert!(parse_duration_point(b"inf:100").is_none());
        assert!(parse_duration_point(b"50:").is_none());
        assert!(parse_duration_point(b"50:-1").is_none());
        assert!(parse_duration_point(b"50:1.5").is_none());
        assert!(parse_duration_point(b"50:100:3").is_none());
        assert!(parse_duration_point(b"50:99999999999").is_none());
        assert!(parse_duration_point(&[0xff, b':', b'1']).is_none());
    }

    #[test]
    fn parses_settings_as_fractions() {
        assert_eq!(parse_setting(b"42"), Some(0.42));
        assert_eq!(parse_setting(b" 100\n\0"), Some(1.0));
        assert_eq!(parse_setting(b"12.5"), Some(0.125));
        assert_eq!(parse_setting(b"150"), Some(1.0));
        assert_eq!(parse_setting(b"-3"), Some(0.0));
    }

    #[test]
    fn rejects_malformed_settings() {
        assert!(parse_setting(b"").is_none());
        assert!(parse_setting(b"fast").is_none());
        assert!(parse_setting(b"NaN").is_none());
        assert!(parse_setting(&[0xc3]).is_none());
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
}
