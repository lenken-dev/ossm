# OSSM

Firmware for the OSSM machine: a belt-driven linear actuator that runs stroke
patterns, with the same control logic compiled both to the board and to a
browser simulator.

## Language

**LED**:
The single addressable light on the board. It shows whatever colour it is
given and holds no opinion about what that colour means — deciding *which*
colour to show is a separate concern that sits above it.
_Avoid_: status light, pixel, NeoPixel

**Boot colour**:
The colour shown as soon as the firmware is alive. It reports that the
firmware ran at all, and nothing more — it is not a claim that the machine is
ready, and it does not name a fault.
_Avoid_: status colour, ready colour, startup indicator

**Fault**:
A latched condition the firmware has decided the user must be told about. It
names what the user must do, not which subsystem broke, and it only ever
describes — it never commands the machine.
_Avoid_: error, failure

**Fault class**:
The required-action grouping a fault belongs to: *hardware*, meaning something
physical must change, or *firmware*, meaning there is nothing physical to do.
_Avoid_: category, severity

**Error code**:
The displayed identity of a fault — its fault class together with its blink
count. Curated: only faults a user can act on have their own, and every other
fault shares its class's generic code.
_Avoid_: fault code, blink code

**Remote**:
A control surface that drives the machine over a radio. The phone app over BLE
and the M5 handset over ESP-NOW are each a remote; the machine does not
distinguish between them.
_Avoid_: controller, client

**Remote presence**:
The firmware's belief that at least one remote is live. A belief, not a fact:
each radio infers it differently and lags reality by its own timeout, so
presence is always slightly stale and never a guarantee that a command will
arrive.
_Avoid_: connected, connection, link
