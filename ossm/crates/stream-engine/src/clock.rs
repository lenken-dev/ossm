/// How fast the offset estimate rises between stream syncs (100 ppm), so
/// that an engine clock running faster than the remote's is followed.
const CLOCK_CREEP: f64 = 100e-6;

/// The engine's clock minus a remote's, learned from its stream syncs.
///
/// Each sync is a sample of the offset plus the transport delay. The
/// estimate keeps the lowest sample, the one with the least delay, and
/// rises by [`CLOCK_CREEP`] between syncs: a delayed sync is ignored, a
/// slower engine clock lowers the samples, which the estimate follows
/// directly. What remains is the minimum transport delay, a constant bias.
#[derive(Debug, Clone, Copy, Default)]
pub struct ClockOffset {
    /// The offset (ms) and the engine time of the last sync.
    estimate: Option<(f64, u64)>,
}

impl ClockOffset {
    /// Take a sync: the remote's clock read `remote_ms` at `now_ms` on the
    /// engine's clock.
    pub fn sync(&mut self, now_ms: u64, remote_ms: u64) {
        let sample = now_ms as f64 - remote_ms as f64;
        let offset = match self.estimate {
            Some((offset, last_ms)) => {
                sample.min(offset + now_ms.saturating_sub(last_ms) as f64 * CLOCK_CREEP)
            }
            None => sample,
        };
        self.estimate = Some((offset, now_ms));
    }

    /// The estimate (ms), once synced.
    pub fn offset_ms(&self) -> Option<f64> {
        self.estimate.map(|(offset, _)| offset)
    }

    /// `remote_ms` on the engine's clock (whole ms). `None` before the first
    /// sync or when it maps before zero.
    pub fn to_local(&self, remote_ms: u64) -> Option<u64> {
        let local = remote_ms as f64 + self.offset_ms()?;
        (local >= 0.0).then_some(local as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_fastest_sync_and_creeps_up() {
        let mut clock = ClockOffset::default();
        assert_eq!(clock.to_local(0), None);
        clock.sync(5000, 1000);
        assert_eq!(clock.to_local(2000), Some(6000));

        // Delayed by 30 ms: only the creep (0.1 ms per second) applies.
        clock.sync(16030, 12000);
        assert!((clock.offset_ms().unwrap() - 4001.103).abs() < 1e-6);
        // Faster than the estimate: taken directly.
        clock.sync(17000, 13002);
        assert_eq!(clock.offset_ms(), Some(3998.0));

        clock.sync(0, 10);
        assert_eq!(clock.to_local(5), None);
    }
}
