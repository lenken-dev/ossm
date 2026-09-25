# OSSM Motion and Patterns

OSSM controls a motor-driven linear actuator through bounded motion and adjustable patterns. This glossary describes the machine, motion, and pattern vocabulary used by this fork.

## Language

### Travel and motion

**Machine range**:
The configured interval of permitted travel, from the minimum to the maximum position relative to home.
_Avoid_: Full rail length, stroke range

**Machine position**:
A location within the machine range, expressed as a fraction with zero at its minimum and one at its maximum.
_Avoid_: Depth, stroke position

**Motion limits**:
The configured bounds on position, speed, acceleration, and jerk for planned motion.

**Move**:
A motion toward one target position under requested motion constraints. Its target can change while it is in progress.
_Avoid_: Pattern, cycle

**Trajectory**:
The planned progression of position, velocity, and acceleration over time for a move or a controlled stop.

**Homing**:
The operation that establishes a known reference position for subsequent travel.
_Avoid_: Return to minimum depth

**Home reference**:
The coordinate origin established by homing, from which physical travel positions are expressed. The minimum of the machine range can be offset from this origin.
_Avoid_: Minimum machine position

**Move completion**:
The end of the planned trajectory at its target. Completion alone does not confirm that the physical actuator has reached that target.
_Avoid_: Verified arrival

**Move cancellation**:
The termination of a move's outstanding intent, for example by disabling or homing. Cancellation does not itself mean that physical motion has stopped.
_Avoid_: Pause, emergency stop

**Pause requested**:
A pending request to suspend motion while preserving the intent to resume. The actuator may still be moving or decelerating.
_Avoid_: Paused

**Stopping**:
The deceleration interval leading to a stationary condition, including when fulfilling a pause request.
_Avoid_: Paused, stationary

**Paused**:
A fully stationary condition reached after suspending motion, with the intent to resume preserved.
_Avoid_: Pause requested, stopping

**Jerk setting**:
A motion adjustment from zero to one selecting a smoother or choppier profile within the configured jerk limit.
_Avoid_: Sensation, physical jerk value

**Motion phase**:
The motion controller's operational condition: disabled, enabled, ready, moving, stopping, or paused.
_Avoid_: Playback state

**Motion state**:
The reported motion phase, planned position and motion rates, and requested torque limit. These values do not establish the actuator's measured physical state.
_Avoid_: Motor feedback, measured state

**Motor feedback**:
Information about the motor's position or condition obtained through the available hardware feedback mechanism; position may be measured or inferred from emitted steps.
_Avoid_: Planned motion state

### Patterns

**Pattern**:
A named behavior that produces a sequence of moves and optional delays, adjusted by live user input.
_Avoid_: Move, trajectory

**Pattern input**:
The user's depth, stroke, speed, and sensation settings that shape pattern behavior.

**Speed setting**:
The unsigned user control expressed as a fraction of maximum motion speed. Zero requests a position hold.
_Avoid_: Directional velocity

**Position hold**:
The intent to remain stationary at a position rather than continue travel toward a pattern target.
_Avoid_: Minimum positive speed

**Depth**:
The deepest permitted target of a pattern, expressed as a machine position.
_Avoid_: Stroke length, distance from home

**Stroke setting**:
The fraction of depth used for travel between the shallowest and deepest pattern targets. Zero collapses the stroke range to the depth target; one extends it from the minimum machine position to that target.
_Avoid_: Stroke length, fraction of machine range

**Stroke length**:
The travel distance between the shallowest and deepest targets of the stroke range, equal to depth multiplied by stroke setting multiplied by the length of the machine range.
_Avoid_: Stroke setting, round-trip distance

**Stroke range**:
The interval between a pattern's shallowest and deepest permitted targets within the machine range.
_Avoid_: Machine range

**Stroke position**:
A target location within the stroke range, expressed as a fraction with zero at its shallowest point and one at its deepest point.
_Avoid_: Machine position

**Sensation**:
A pattern-specific adjustment from minus one to one whose effect is defined by the selected pattern.
_Avoid_: Speed, torque

**Playback state**:
The pattern engine's operational condition: idle, homing, ready, playing a selected pattern, or paused on a selected pattern.
_Avoid_: Motion phase

**Torque limit**:
A requested cap on motor output expressed as a fraction of the motor's maximum output, with a hardware-dependent effect.
_Avoid_: Measured torque, contact force

### Streaming

**Streaming**:
The mode in which a remote client drives motion with timed stream points instead of a pattern. It uses the depth, stroke, and speed settings, and lasts until the next pattern command.
_Avoid_: Pattern playback

**Stream point**:
A streamed target: a position from zero (deepest) to one hundred (shallowest) within the stroke range, and a duration. It is due that duration after the later of its reception, plus any stream delay, and the previous point's scheduled arrival.
_Avoid_: Stroke position, move

**Stream delay**:
The time added to a stream point's reception by a remote that sends its points that far ahead of their schedule. It gives look-ahead without shifting the stream's timing. The official OSSM funscript player sets it as its buffer while latency compensation is enabled.
_Avoid_: Latency, buffering

**Stream move**:
A move toward a stream point with a requested arrival time and arrival velocity. Unlike a pattern move it may end in motion, so another stream move or a controlled stop must follow it.
_Avoid_: Stream point

**Look-ahead**:
The stream points queued beyond the target of the current stream move. A stream move arrives in motion only when look-ahead exists; otherwise it ends at rest.
_Avoid_: Buffering

**Skipped point**:
A stream point passed over for a later one: a late point (one that can no longer be reached on time) whenever another point follows, or a point that cannot be reached in time on the way to a later point in the same direction. Direction reversals are only protected from the second kind.
_Avoid_: Dropped point

**Dropped point**:
A stream point discarded on receipt because a queue was full.
_Avoid_: Skipped point

**Armed**:
The condition under which preparing the machine for streaming continues: the speed setting is above zero and no pattern command is pending. Otherwise preparing aborts. Taking over requires more: a stream point starts streaming only while the pattern engine is idle or ready, no motion state operation is in flight, and the speed setting is above zero.
_Avoid_: Enabled

**Stream end**:
The controlled stop that closes a stream, discarding queued stream points and any intent to resume. The next stream point starts a new stream. Running out of stream points is not a stream end: the machine rests at the last target and the stream stays open.
_Avoid_: Pause, stopping

### Status indication

**Status indicator**:
The machine's physical output for communicating status to a person, such as a colored light, an on/off light, or a buzzer.

**Status system**:
The policy that determines which machine conditions to communicate and how to express them through a status indicator.
