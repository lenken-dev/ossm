import { useEffect, useRef } from "react";

/**
 * Listen to `type` on the window with the latest `handler`. The listener is
 * added once: one re-added on every render can miss an event, when another
 * listener's state update re-renders while the event is being dispatched.
 */
export function useWindowEvent<K extends keyof WindowEventMap>(type: K, handler: (e: WindowEventMap[K]) => void) {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    const listener = (e: WindowEventMap[K]) => latest.current(e);
    window.addEventListener(type, listener);
    return () => window.removeEventListener(type, listener);
  }, [type]);
}
