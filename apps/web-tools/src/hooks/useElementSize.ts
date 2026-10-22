import { useEffect, useState, type RefObject } from "react";

/** The content size of the element in `ref`, in px, following resizes; 0 until measured. */
export function useElementSize(ref: RefObject<Element | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(ref.current!);
    return () => observer.disconnect();
  }, []);
  return size;
}
