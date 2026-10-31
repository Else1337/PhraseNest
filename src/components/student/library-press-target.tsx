"use client";
import { useEffect, useRef, type ReactNode } from "react";

// Recognize a hold without taking over the browser's vertical pan or pinch.
export function LibraryPressTarget({ children, className, selected, label, open }: { children: ReactNode; className: string; selected?: boolean; label: string; open: () => void }) {
  const hold = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const start = useRef({ x: 0, y: 0 }), consumed = useRef(false);
  function cancel() { clearTimeout(hold.current); hold.current = undefined; }
  useEffect(() => { window.addEventListener("scroll", cancel, true); return () => { cancel(); window.removeEventListener("scroll", cancel, true); }; }, []);
  return <article className={className} data-selected={selected || undefined} tabIndex={0} aria-label={label}
    onPointerDown={event => { cancel(); consumed.current = false; if (!event.isPrimary || event.button !== 0 || (event.target instanceof Element && event.target.closest("input,select,textarea"))) return; start.current = { x: event.clientX, y: event.clientY }; hold.current = setTimeout(() => { consumed.current = true; open(); }, 480); }}
    onPointerMove={event => { if (Math.hypot(event.clientX - start.current.x, event.clientY - start.current.y) > 9) cancel(); }}
    onPointerUp={cancel} onPointerCancel={cancel} onPointerLeave={cancel}
    onClickCapture={event => { if (consumed.current) { event.preventDefault(); event.stopPropagation(); consumed.current = false; } }}
    onContextMenu={event => { event.preventDefault(); cancel(); consumed.current = true; open(); }}
    onKeyDown={event => { if (event.target !== event.currentTarget) return; if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10") || event.key === "Enter") { event.preventDefault(); open(); } }}>
    {children}
  </article>;
}
