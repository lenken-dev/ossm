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
