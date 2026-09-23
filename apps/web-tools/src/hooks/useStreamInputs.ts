import { useCallback } from "react";
import { usePersistedState } from "./usePersistedState";
import { TRAJECTORY_DEFAULTS, type UnitMode } from "./useTrajectoryInputs";

const DEFAULTS = {
  depth: TRAJECTORY_DEFAULTS.depth,
  stroke: TRAJECTORY_DEFAULTS.stroke,
  velocity: 1.0,
  // Matches the pattern motion jerk setting.
  jerk: 0.5,
  // 0 sends each point as its segment starts, like a funscript player.
  lookahead: 0,
  windowSecs: 10,
  unitMode: TRAJECTORY_DEFAULTS.unitMode,
};

export { DEFAULTS as STREAM_DEFAULTS };

export function useStreamInputs() {
  const [depth, setDepth] = usePersistedState("ossm:stream:depth", DEFAULTS.depth);
  const [stroke, setStroke] = usePersistedState("ossm:stream:stroke", DEFAULTS.stroke);
  const [velocity, setVelocity] = usePersistedState("ossm:stream:velocity", DEFAULTS.velocity);
  const [jerk, setJerk] = usePersistedState("ossm:stream:jerk", DEFAULTS.jerk);
  const [lookahead, setLookahead] = usePersistedState("ossm:stream:lookahead", DEFAULTS.lookahead);
  const [windowSecs, setWindowSecs] = usePersistedState("ossm:stream:window", DEFAULTS.windowSecs);
  const [unitMode, setUnitMode] = usePersistedState<UnitMode>("ossm:unitMode", DEFAULTS.unitMode);

  const resetDefaults = useCallback(() => {
    setDepth(DEFAULTS.depth);
    setStroke(DEFAULTS.stroke);
    setVelocity(DEFAULTS.velocity);
    setJerk(DEFAULTS.jerk);
    setLookahead(DEFAULTS.lookahead);
    setWindowSecs(DEFAULTS.windowSecs);
    setUnitMode(DEFAULTS.unitMode);
  }, [setDepth, setStroke, setVelocity, setJerk, setLookahead, setWindowSecs, setUnitMode]);

  return {
    depth, setDepth,
    stroke, setStroke,
    velocity, setVelocity,
    jerk, setJerk,
    lookahead, setLookahead,
    windowSecs, setWindowSecs,
    unitMode, setUnitMode,
    resetDefaults,
  };
}
