import { useState, type Dispatch, type SetStateAction } from "react";
import { usePersistedState } from "../hooks/usePersistedState";
import { gridParams, type GridFields } from "./transforms";

/** The advanced editor's Grid tool: whether it is open, its fields, and the grid points snap to. */
export interface Grid {
  /** The grid tool is open; unlike the other tools, editing goes on, points added, dragged and placed snapping to it. */
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  /** Its fields, as typed: Time every in s, Depth every, and depths of their own. */
  fields: GridFields;
  setFields: Dispatch<SetStateAction<GridFields>>;
  /** The grid, while its tool is open and `enabled`. */
  grid: ReturnType<typeof gridParams> | null;
  /** `at` on the nearest of the grid's times, counted from the time shown as 0; as it is without them. */
  at(at: number): number;
  /** `pos` on the nearest of the grid's depths; as it is without any. */
  pos(pos: number): number;
}

/** The Grid tool, its grid only while `enabled`: in the advanced editor with no other tool open; its times counted from `zero`. */
export function useGrid(enabled: boolean, zero: number): Grid {
  const [open, setOpen] = useState(false);
  const [fields, setFields] = usePersistedState<GridFields>("ossm:editorGrid", { time: "1", depth: "10", depths: "" }, localStorage);
  const grid = enabled && open ? gridParams(fields) : null;
  const at = (at: number) => (grid?.step ? zero + Math.round((at - zero) / grid.step) * grid.step : at);
  const pos = (pos: number) => (grid?.positions.length ? grid.positions.reduce((a, b) => (Math.abs(b - pos) < Math.abs(a - pos) ? b : a)) : pos);
  return { open, setOpen, fields, setFields, grid, at, pos };
}
