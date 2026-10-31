"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";

// Native scrolling keeps pen/touch movement 1:1. Only overlapping edges fade;
// the readable centre is never blurred or made transparent.
export function ScrollFade({ children, className = "", label, maxHeight }: { children: ReactNode; className?: string; label: string; maxHeight?: string }) {
  const viewport = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: false, bottom: false, offset: 0, size: 100 });
  useEffect(() => {
    const element = viewport.current, inner = content.current;
    if (!element || !inner) return;
    const update = () => {
      const overflow = element.scrollHeight - element.clientHeight;
      const size = Math.min(100, Math.max(12, element.clientHeight / Math.max(1, element.scrollHeight) * 100));
      const next = { top: element.scrollTop > 2, bottom: overflow - element.scrollTop > 2, size, offset: overflow > 0 ? element.scrollTop / overflow * (100 - size) : 0 };
      setPosition((old) => old.top === next.top && old.bottom === next.bottom && Math.abs(old.offset - next.offset) < .1 && Math.abs(old.size - size) < .1 ? old : next);
    };
    const observer = new ResizeObserver(update); observer.observe(element); observer.observe(inner);
    element.addEventListener("scroll", update, { passive: true }); const frame = requestAnimationFrame(update);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); element.removeEventListener("scroll", update); };
  }, []);
  return <div className={`dw-soft-scroll ${className}`} data-scroll-top={position.top} data-scroll-bottom={position.bottom}>
    <div ref={viewport} className="dw-soft-scroll-viewport" style={{ maxHeight }} role="region" aria-label={label} tabIndex={0}><div ref={content}>{children}</div></div>
    <span className="dw-soft-scroll-edge is-top" aria-hidden="true" /><span className="dw-soft-scroll-edge is-bottom" aria-hidden="true" />
    {(position.top || position.bottom) && <span className="dw-soft-scroll-track" aria-hidden="true"><i style={{ top: `${position.offset}%`, height: `${position.size}%` }} /></span>}
  </div>;
}
