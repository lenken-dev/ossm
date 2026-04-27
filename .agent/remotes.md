# Remotes

Two crates today:

- [crates/ble-remote](../crates/ble-remote) - GATT server for the modern RADR BLE remote (and any future BLE control surface).
- [crates/ossm-m5-remote](../crates/ossm-m5-remote) - ESP-NOW receiver for the legacy [OSSM M5 Remote](https://github.com/ortlof/OSSM-M5-Remote).

Both are `no_std` and both deliver `pattern_engine::commands` (`PlaybackCommand`, `InputCommand`) into the engine. The protocols differ; the destination format does not. **Don't define new command formats in either crate** - put them in [pattern-engine.md](pattern-engine.md) so all transports stay aligned.

Today both crates depend on `esp-radio` for the actual radio driver, so they only build on ESP. The wire formats, GATT layout, and command parsing are HAL-agnostic - those parts stay HAL-agnostic even when the radio driver underneath isn't. If a future chip family wants a BLE remote, the path is to either gate the radio bring-up behind features or pull a HAL-agnostic GATT layer out into a new crate consumed by both. Don't fork the parsers.

## ble-remote

`esp-radio`'s BLE driver via `trouble-host`. ESP32-S3 only today.

The protocol UUIDs and string formats are stable - they're the public ABI for the RADR remote, so don't reshape them without coordinating with that firmware.

### GATT surface

One service `522b443a-4f53-534d-0001-420badbabe69` ("OSSM Service") with five characteristics:

| Characteristic | UUID suffix | Direction | Purpose |
|---|---|---|---|
| `primary_command` | `1000-...` | read/write | string-encoded `PlaybackCommand` (play, pause, resume, stop, home, etc.) |
| `speed_knob` | `1010-...` | read/write | string-encoded `InputCommand` knob update (depth/stroke/velocity/sensation) |
| `current_state` | `2000-...` | read/notify | engine state + motion telemetry as a string |
| `pattern_list` | `3000-...` | read | JSON array of `{name, idx}` for the engine's `BUILTIN_PATTERNS` |
| `pattern_description` | `3010-...` | read/write | name + description of a selected pattern |

The exact string formats live in [pattern_engine::commands](../crates/pattern-engine/src/commands.rs). Parse via `commands::InputCommand::parse(...)` etc - don't reinvent.

### Concurrency

- **Connection task**: runs the `trouble-host` event loop. `CONNECTIONS_MAX = 1`.
- **Notify task**: ticks every N ms while connected, formats the current `EngineState` + `MotionState`, notifies on `current_state`.
- **Write handler**: parses `primary_command` / `speed_knob` writes and forwards to the engine.

The static `CONNECTED: AtomicBool` gates the notify loop. Don't add a mutex around connection state - keep it lock-free.

### Adding a characteristic

1. Add a UUID const at the top of [crates/ble-remote/src/lib.rs](../crates/ble-remote/src/lib.rs).
2. Add a `#[characteristic(...)]` field to the `OssmService` struct.
3. Plumb writes into `pattern_engine::commands` (don't define new command formats here - they belong upstream so the M5 remote and any future transport can share them).
4. If it's a notify, push to it from the notify task.

### Adding a transport built on the same payload format

If you want a non-BLE remote that uses the same wire format (e.g. WebSocket from the web app), don't fork this crate - reuse the parsers from [pattern_engine::commands](../crates/pattern-engine/src/commands.rs) and write a new transport crate.

### Memory notes

- `CONNECTIONS_MAX = 1`, `L2CAP_CHANNELS_MAX = 2`. Bumping these costs RAM the ESP32 may not have (it already drops ESP-NOW to fit BLE + Wifi).
- Strings are `heapless::String<N>` with explicit caps. `MAX_PATTERN_LENGTH = 256` covers the seven built-ins; if more are added, the JSON serializer truncates and logs a warning rather than panicking.
- A single static `CONNECTED` plus `embassy_sync` channels is the entire shared state. If you reach for a `Mutex`, reconsider.

## ossm-m5-remote

ESP-NOW receiver for the legacy M5StickC-based remote ([source we match](https://github.com/ortlof/OSSM-M5-Remote)). This crate re-implements the wire protocol the M5 firmware speaks so users with an M5 remote can keep using it against ossm-rs.

The wire format is set in stone by the M5 firmware - see [reference/OSSM-M5-Remote](../reference/OSSM-M5-Remote) for the source we're matching.

### Wire protocol

ESP-NOW broadcasts on the device's MAC. Each frame is a `repr(C)` struct that `zerocopy` decodes into one of the `M5Command` variants. The IDs (sender ID, receiver ID), command codes, and value semantics all come from the original firmware - **don't change them.** Match what the existing M5 remote sends.

The M5 hardware has a hardcoded pattern roller with eight entries. Five map to ossm-rs patterns; the others (`RoboStroke`, `Insist`, `Knot`) don't exist in the engine yet so they map to the `None` pattern (which holds position). See `RemotePattern::to_engine_index` in [crates/ossm-m5-remote/src/lib.rs](../crates/ossm-m5-remote/src/lib.rs) for the exact mapping.

If a pattern is added to the engine that has an M5 equivalent name, update the mapping in this crate so M5 users get it automatically.

### Heartbeat

The M5 remote sends a heartbeat. We track `LAST_HEARTBEAT` and `CONNECTED` as atomics. If no heartbeat arrives for `MAX_NO_REMOTE_HEARTBEAT_MS` (10s), we mark the remote as disconnected so the firmware can show that state. Don't tighten this timeout without checking the remote's actual ping rate.

### When to change this crate

- Bug-for-bug compatibility with the M5 firmware. If their firmware updates, mirror it.
- Mapping new engine patterns to existing M5 slots when there's a sensible match.

### When not to

- Inventing a new protocol. The BLE path above is the modern foundation; the M5 protocol exists for backwards compatibility only.
- Adding features the M5 hardware can't show. The remote can't display knobs we don't already wire to its existing buttons.
