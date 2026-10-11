use embedded_hal_async::delay::DelayNs;
use embassy_time::Instant;

use crate::pattern::{Pattern, PatternCtx};

pub struct Humanize;

fn xorshift(seed: u64) -> u64 {
    let mut x = seed;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    x
}

fn get_vals(seed: u64, scale: f64) -> (f64, f64, f64) {
    let rand1 = xorshift(Instant::now().as_nanos() + seed);
    let rand2 = xorshift(Instant::now().as_nanos() + seed + 100);
    let rand3 = xorshift(Instant::now().as_nanos() + seed + 200);
    (
        (rand1 % scale as u64) as f64 / 100.0,
        (rand2 % scale as u64) as f64 / 100.0,
        (rand3 % scale as u64) as f64 / 100.0
    )
}

impl Pattern for Humanize {
    const NAME: &'static str = "Humanize";
    const DESCRIPTION: &'static str = "Makes each stroke a little different, based on sensation.";

    async fn run(&mut self, ctx: &mut PatternCtx<'_, impl DelayNs>) -> Result<(), ossm::Cancelled> {
        let mut seed = 0;
        loop {
            let scale = ctx.scale_sensation(5.0, 40.0);
            let (position, speed, jerk) = get_vals(seed, scale);
            seed += 1;
            ctx.motion().position(1.0 - position).speed(1.0 - speed).jerk(0.5 - scale/200.0 + jerk).send().await?;
            let (position, speed, jerk) = get_vals(seed, scale);
            seed += 1;
            ctx.motion().position(0.0 + position).speed(1.0 - speed).jerk(0.5 - scale/200.0 + jerk).send().await?;
        }
    }
}
