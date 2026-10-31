"use client";
import { useEffect, useRef, type RefObject } from "react";

// A real tap dismisses the floating answer; a scroll, text selection drag, or
// cancelled touch must not. No preventDefault: reading stays native.
export function useOutsideTap(ref: RefObject<HTMLElement | null>, enabled: boolean, dismiss: () => void) {
  const callback = useRef(dismiss);
  useEffect(() => { callback.current = dismiss; }, [dismiss]);
  useEffect(() => {
    if (!enabled) return;
    let start: { id: number; x: number; y: number } | undefined;
    const down = (event: PointerEvent) => {
      start = event.isPrimary && event.button === 0 && !event.composedPath().includes(ref.current as EventTarget)
        ? { id: event.pointerId, x: event.clientX, y: event.clientY } : undefined;
    };
    const up = (event: PointerEvent) => {
      if (start?.id === event.pointerId && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 10 && !event.composedPath().includes(ref.current as EventTarget)) callback.current();
      start = undefined;
    };
    const cancel = () => { start = undefined; };
    document.addEventListener("pointerdown", down, true); document.addEventListener("pointerup", up, true); document.addEventListener("pointercancel", cancel, true);
    return () => { document.removeEventListener("pointerdown", down, true); document.removeEventListener("pointerup", up, true); document.removeEventListener("pointercancel", cancel, true); };
  }, [enabled, ref]);
}
