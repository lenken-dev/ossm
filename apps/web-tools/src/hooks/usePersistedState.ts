import { useState, useCallback, type Dispatch, type SetStateAction } from "react";

export function usePersistedState<T>(
  key: string,
  defaultValue: T,
  storage: Storage = sessionStorage,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = storage.getItem(key);
      if (raw != null) return JSON.parse(raw) as T;
    } catch {}
    return defaultValue;
  });

  const setPersisted = useCallback<Dispatch<SetStateAction<T>>>(
    (action) => {
      setValue((prev) => {
        const next = action instanceof Function ? action(prev) : action;
        storage.setItem(key, JSON.stringify(next));
        return next;
      });
    },
    [key, storage],
  );

  return [value, setPersisted];
}
