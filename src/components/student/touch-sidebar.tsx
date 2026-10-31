"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import { X } from "@phosphor-icons/react";

// A drawer anchored to the left follows the finger: right opens, left closes.
const OPEN_DIRECTION = 1;
const clamp = (value: number, width: number) => Math.max(-width, Math.min(0, value));
type Gesture = { startX: number; startY: number; origin: number; lastX: number; lastAt: number; velocity: number; dragging: boolean; wasOpen: boolean };

export function TouchSidebar({ open, enabled, onOpenChange, children }: { open: boolean; enabled: boolean; onOpenChange: (open: boolean) => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const [width, setWidth] = useState(308);
  const x = useMotionValue(-308);
  const opacity = useTransform(x, [-width, 0], [0, 1]);
  const reduced = useReducedMotion();
  const target = useRef(false);
  const gesture = useRef<Gesture | null>(null);
  const bodyOverflow = useRef<string | null>(null);

  const reveal = useCallback(() => {
    if (!dialog.current?.open) dialog.current?.showModal();
    if (bodyOverflow.current === null) {
      bodyOverflow.current = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
  }, []);
  const dismiss = useCallback(() => {
    dialog.current?.close();
    if (bodyOverflow.current !== null) {
      document.body.style.overflow = bodyOverflow.current;
      bodyOverflow.current = null;
    }
  }, []);
  const settle = useCallback((next: boolean, velocity = 0) => {
    target.current = next;
    onOpenChange(next);
    if (next) reveal();
    x.stop();
    const animation = animate(x, next ? 0 : -width, reduced ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 42, mass: 1, velocity });
    void animation.then(() => { if (!target.current && !gesture.current?.dragging) dismiss(); });
  }, [dismiss, onOpenChange, reduced, reveal, width, x]);

  useEffect(() => {
    const resize = () => {
      const next = Math.min(308, Math.max(220, innerWidth - 60));
      setWidth(next);
      x.stop();
      x.set(target.current ? 0 : -next);
      gesture.current = null;
    };
    resize();
    addEventListener("resize", resize);
    return () => removeEventListener("resize", resize);
  }, [x]);
  useEffect(() => {
    if (!enabled) { target.current = false; onOpenChange(false); x.stop(); x.set(-width); dismiss(); }
    else if (open !== target.current) settle(open);
  }, [dismiss, enabled, onOpenChange, open, settle, width, x]);
  useEffect(() => () => {
    x.stop();
    if (bodyOverflow.current !== null) document.body.style.overflow = bodyOverflow.current;
  }, [x]);

  useEffect(() => {
    if (!enabled) return;
    const start = (event: TouchEvent) => {
      gesture.current = null;
      if (window.getSelection()?.type === "Range") return;
      if (event.touches.length !== 1) { gesture.current = null; return; }
      const node = event.target instanceof Element ? event.target : null;
      if (!node || node.closest("input,textarea,select,[contenteditable=true],pre,table,.dw-table-scroll,.rich-board-text,[data-no-sidebar-swipe]")) return;
      if (node.closest('[role="dialog"]') && !node.closest("#dw-touch-sidebar")) return;
      const topDialog = document.querySelector("dialog[open]:not(#dw-touch-sidebar)") ?? document.querySelector("dialog[open]");
      if (topDialog && topDialog !== dialog.current) return;
      if (!target.current && !node.closest(".dialogue")) return;
      const point = event.touches[0];
      // Content gestures belong to reading. Opening a closed drawer is an
      // edge gesture, never a global recognizer competing with diagonal pans
      // over a list/table or a student's text selection.
      if (!target.current && point.clientX > 28) return;
      gesture.current = { startX: point.clientX, startY: point.clientY, origin: x.get(), lastX: point.clientX, lastAt: event.timeStamp, velocity: 0, dragging: false, wasOpen: target.current };
    };
    const move = (event: TouchEvent) => {
      const current = gesture.current;
      if (!current) return;
      if (event.touches.length !== 1) { gesture.current = null; settle(current.wasOpen); return; }
      const point = event.touches[0], dx = point.clientX - current.startX, dy = point.clientY - current.startY;
      if (!current.dragging) {
        if (window.getSelection()?.type === "Range") { gesture.current = null; return; }
        if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { gesture.current = null; return; }
        if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.35) return;
        if (!current.wasOpen && dx * OPEN_DIRECTION <= 0) { gesture.current = null; return; }
        current.dragging = true;
        x.stop();
        current.origin = x.get();
        reveal();
      }
      event.preventDefault();
      const elapsed = Math.max(1, event.timeStamp - current.lastAt);
      current.velocity = OPEN_DIRECTION * (point.clientX - current.lastX) / elapsed * 1000;
      current.lastX = point.clientX;
      current.lastAt = event.timeStamp;
      x.set(clamp(current.origin + dx * OPEN_DIRECTION, width));
    };
    const finish = (event: TouchEvent) => {
      const current = gesture.current;
      gesture.current = null;
      if (!current?.dragging) return;
      if (event.cancelable) event.preventDefault();
      const velocity = event.timeStamp - current.lastAt > 100 ? 0 : current.velocity;
      settle(x.get() + velocity * .15 > -width * .5, velocity);
    };
    const cancel = () => { const current = gesture.current; gesture.current = null; if (current?.dragging) settle(current.wasOpen); };
    addEventListener("touchstart", start, { passive: true });
    addEventListener("touchmove", move, { passive: false });
    addEventListener("touchend", finish, { passive: false });
    addEventListener("touchcancel", cancel);
    return () => {
      removeEventListener("touchstart", start); removeEventListener("touchmove", move);
      removeEventListener("touchend", finish); removeEventListener("touchcancel", cancel);
    };
  }, [enabled, reveal, settle, width, x]);

  return <dialog ref={dialog} id="dw-touch-sidebar" className="dw-touch-dialog" aria-labelledby={title} onCancel={(event) => { event.preventDefault(); settle(false); }}>
    <motion.button className="dw-touch-scrim" style={{ opacity }} aria-label="关闭侧栏遮罩" tabIndex={-1} onClick={() => settle(false)} />
    <motion.header className="dw-touch-heading" style={{ x, left: width + 8 }}><h2 id={title} className="dw-sr">学习空间</h2><button className="dw-icon" aria-label="关闭侧栏" onClick={() => settle(false)}><X size={22} /></button></motion.header>
    <motion.aside className="dw-touch-panel" style={{ x, width }}>
      <div className="dw-mobile-nav">{children}</div>
    </motion.aside>
  </dialog>;
}
