import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AppState, Controller } from "./controller";

export const ControllerContext = createContext<Controller | null>(null);

export function useController(): Controller {
  const c = useContext(ControllerContext);
  if (!c) throw new Error("useController outside <ControllerContext>");
  return c;
}

/** A slice of the app's state; the component re-renders when that slice changes. */
export function useApp<T>(select: (s: AppState) => T): T {
  const c = useController();
  return useSyncExternalStore(c.subscribe, () => select(c.getState()));
}

/** An element's width, kept current as it resizes -- for charts drawn to fit. */
export function useWidth<E extends HTMLElement>(): [React.RefObject<E | null>, number] {
  const ref = useRef<E>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}
