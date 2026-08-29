# 11 — Trajectory planning, limits, and units

> Prerequisites: [10-core-ossm.md](10-core-ossm.md)

## The problem

A pattern says "go to the far end". The motor accepts an absolute position and
will slam towards it as fast as its internal loop allows. Between those two
lies the question this layer answers: *what position should the motor be at,
right now, on this tick, such that the whole movement is smooth and within
safe limits?*

## Why jerk, not just acceleration

Jerk is the derivative of acceleration — how fast the acceleration changes.
A trapezoidal velocity profile (constant acceleration, then constant velocity,
then constant deceleration) has infinite jerk at the corners: the acceleration
steps instantly from 0 to its maximum. Mechanically that is a hammer blow into
the belt and the bearings, and it is audible.

An S-curve profile ramps acceleration in over a finite time. That is what
Ruckig produces.

```
velocity                     velocity
   │    ┌────────┐              │      ╭────────╮
   │   ╱          ╲             │     ╱          ╲
   │  ╱            ╲            │   ╭╯            ╰╮
   └─────────────────── t       └──────────────────── t
     trapezoidal (∞ jerk)          S-curve (jerk-limited)
```

## Ruckig

[Ruckig](https://github.com/pantor/ruckig) is a real-time trajectory
generator; this project uses `rsruckig`, a pure-Rust port, with
`default-features = false, features = ["libm", "alloc"]` so it works without
an OS or a C math library.

The usage pattern is: fill an `InputParameter`, call `update` once per fixed
timestep, read the `OutputParameter`, feed the output back into the input.

```rust
let mut input = InputParameter::new(None);
input.current_position[0] = limits.min_position_mm;
input.target_position[0]  = limits.min_position_mm;
input.max_velocity[0]     = MIN_VELOCITY;
input.max_acceleration[0] = limits.max_acceleration_mm_s2;
input.max_jerk[0]         = limits.max_jerk_mm_s3;
input.synchronization         = Synchronization::None;
input.duration_discretization = DurationDiscretization::Discrete;
```

The `[0]` is because Ruckig is generic over the number of degrees of freedom —
`Ruckig<1, ThrowErrorHandler>` here, since there is exactly one axis.
`DurationDiscretization::Discrete` rounds trajectory durations to whole
timesteps, which keeps the fixed 10 ms cadence exact.

`Ruckig` is *replanned*, not queued: when a new target arrives mid-move,
`sync_ruckig()` writes the new target, resets the timer, and the planner
computes a fresh curve from the current position/velocity/acceleration. That
is what makes live slider dragging work.

### Guards around replanning

Two pieces of defensive logic are worth knowing about because they look odd
out of context.

Replanning is throttled while moving — a replan is expensive (5–15 ms) and
must not starve the 10 ms loop:

```rust
let remaining_time = self.output.trajectory.get_duration() - self.output.time;
if self.input.max_velocity[0] == 0.0 || remaining_time > 1.0 || self.output.time == 0.0 {
    self.set_motion_target(cmd);
    self.apply_torque().await;
}
```

And when a *slower* speed is requested mid-flight, the current velocity is
clamped down before replanning, to stop Ruckig computing a curve that
overshoots the target:

```rust
if self.input.current_velocity[0].abs() > target.velocity {
    self.input.current_velocity[0] =
        target.velocity * (self.input.current_velocity[0] / self.input.current_velocity[0].abs());
    self.input.current_acceleration[0] = 0.0;
}
```

(The `x / x.abs()` is a sign extraction: `+1.0` or `-1.0`.)

## `MotionLimits` — the safety envelope

```rust
pub struct MotionLimits {
    pub min_position_mm: f64,
    pub max_position_mm: f64,
    pub max_velocity_mm_s: f64,
    pub max_acceleration_mm_s2: f64,
    pub max_jerk_mm_s3: f64,
}

impl MotionLimits {
    pub const DEFAULT: Self = Self {
        min_position_mm: 10.0,
        max_position_mm: 190.0,
        max_velocity_mm_s: 600.0,
        max_acceleration_mm_s2: 30_000.0,
        max_jerk_mm_s3: 2_800_000.0,
    };
}
```

These are per-machine and are handed to the controller at construction. They
are the *only* place absolute physical safety is defined, and nothing upstream
can widen them — a `MotionCommand` carries fractions, so the worst a
misbehaving pattern can ask for is 1.0, which maps to `max_position_mm`.

## The fraction ↔ millimetre boundary

The controller is where the 0.0–1.0 domain becomes physical:

```rust
fn fraction_to_mm(&self, fraction: f64) -> f64 {
    let mm = self.limits.min_position_mm
        + fraction * (self.limits.max_position_mm - self.limits.min_position_mm);
    mm.clamp(self.limits.min_position_mm, self.limits.max_position_mm)
}
```

and back again for telemetry (`mm_to_fraction`, `velocity_to_fraction`,
`acceleration_to_fraction`). Everything published to observers is a fraction,
which is why the browser UI can render a machine it knows no dimensions of.

## Jerk as a user-facing knob

Patterns pass a `jerk` fraction (0.0 = smooth, 1.0 = choppy) alongside
position and speed. Translating that into mm/s³ is not linear, because the
useful range depends on how fast you are going:

```rust
fn fraction_to_jerk(&self, fraction: f64, speed: f64) -> f64 {
    let speed_3 = 2.0 * speed.powf(3.0);
    let max_jerk = 0.95 * speed_3 / 12.0.powf(2.0);       // ~12 mm of "jerk distance"
    let rail_2 = (self.limits.max_position_mm - self.limits.min_position_mm).powf(2.0);
    let min_jerk = speed_3 / rail_2;                       // just reaches speed over the full rail
    let mm_s3 = self.ramp_by_exponent(fraction, 0.5) * max_jerk + min_jerk;
    if self.input.current_velocity[0].abs() > speed && self.input.max_jerk[0] > mm_s3 {
        return self.input.max_jerk[0];                     // keep old jerk while slowing down
    }
    mm_s3.clamp(1.0, self.limits.max_jerk_mm_s3)
}
```

The floor (`min_jerk`) is the jerk at which the requested speed is reached at
least momentarily across the full rail; the ceiling corresponds to reaching it
within ~12 mm. `ramp_by_exponent(x, 0.5)` gives finer resolution at the low end
of the slider. The last branch keeps the previous, higher jerk while
decelerating so there is always enough authority to stop.

## `MechanicalConfig` — geometry

This lives one layer lower, at the board:

```rust
pub struct MechanicalConfig {
    pub pulley_teeth: u32,
    pub belt_pitch_mm: f32,
    pub reverse_direction: bool,
}

impl MechanicalConfig {
    pub fn mm_per_rev(&self) -> f32 { self.pulley_teeth as f32 * self.belt_pitch_mm }
    pub fn steps_per_mm(&self, steps_per_rev: u32) -> f32 {
        steps_per_rev as f32 / self.mm_per_rev()
    }
    pub fn mm_to_steps(&self, mm: f64, steps_per_rev: u32) -> i32 { /* ... */ }
}
```

With 20 teeth × 2 mm pitch = 40 mm/rev and a 32768-step motor, that is 819.2
steps/mm. `as f32` / `as i32` are explicit casts — Rust has no implicit
numeric conversions at all, which is why they appear so often.

`reverse_direction` flips the sign of commanded steps, and is deliberately
paired with `Rs485Motor::set_dir_polarity` at the motor layer so that homing
direction and travel direction move together under one flag.

## The standalone `Planner` trait

`ossm/src/planner/` contains a *second*, simpler planner API that does not
involve the state machine, the board, or any hardware:

```rust
pub trait Planner {
    fn set_position(&mut self, position: f64);
    fn set_target(&mut self, position: f64, velocity_fraction: f64, jerk_fraction: f64);
    fn tick(&mut self) -> PlannerOutput;
    fn is_moving(&self) -> bool;
    fn position(&self) -> f64;
    fn home(&mut self) { self.set_position(0.0); }   // default method
}
```

Two implementations: `RuckigPlanner` (same maths, but working directly in the
0.0–1.0 domain) and `LinearPlanner` (constant-velocity lerp, no smoothing, for
testing pattern logic in isolation).

`home()` shows a trait *default method* — an implementation supplied by the
trait itself that implementors may override, like a non-pure virtual with a
body.

This trait exists for the trajectory recorder, which needs to compute what a
pattern would do without a motor, a controller, or real time. See
[21-trajectory-recorder.md](21-trajectory-recorder.md).
