"use client";

import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import Image from "next/image";
import { motion, useReducedMotion } from "motion/react";
import { ArrowRight, X } from "@phosphor-icons/react";
import { guideAllowed, guides, guideVersion, type GuideId, type GuideScope, type GuideStep } from "@/lib/onboarding/catalog";
import type { GuideState } from "@/lib/onboarding/store";

type Candidate = { id: GuideId; priority: number; paused: boolean };
type GuideContext = {
  replayEpoch: number;
  active: string | undefined;
  register: (key: string, candidate: Candidate | null) => void;
  finish: (id: GuideId, status: "completed" | "skipped") => void;
  replay: (id: GuideId) => void;
};
const Context = createContext<GuideContext | null>(null);
const guestKey = "phrasenest:mia:anonymous-activation:v1";
const subscribeGuest = (notify: () => void) => { window.addEventListener("storage", notify); return () => window.removeEventListener("storage", notify); };
const guestSnapshot = () => { try { return localStorage.getItem(guestKey) === "done"; } catch { return false; } };
const editable = (element: Element | null) => !!element?.closest("input,textarea,select,[contenteditable='true']");

export function MiaGuideProvider({ scope, children }: { scope: GuideScope; children: ReactNode }) {
  const [state, setState] = useState<GuideState | null>(null), [candidates, setCandidates] = useState<Record<string, Candidate>>({});
  const [dismissed, setDismissed] = useState<Set<GuideId>>(new Set()), [requested, setRequested] = useState<GuideId | null>(null);
  const [typing, setTyping] = useState(false), [notice, setNotice] = useState("");
  const [replayEpoch, setReplayEpoch] = useState(0);
  const guestFinished = useSyncExternalStore(subscribeGuest, guestSnapshot, () => null);
  const endpoint = `/api/${scope}/onboarding`;
  useEffect(() => {
    const controller = new AbortController();
    if (scope === "guest") return;
    // Do not treat an unavailable preferences read as a brand-new account.
    void fetch(endpoint, { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) }).then(async response => {
      if (!response.ok) throw Error("guide-read");
      const body = await response.json();
      if (body.version !== 1 || !body.guides || typeof body.guides !== "object") throw Error("guide-format");
      if (!controller.signal.aborted) setState(body);
    }).catch(() => { /* Explicit replay remains available; learning is never blocked. */ });
    return () => controller.abort();
  }, [endpoint, scope]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const focus = () => { clearTimeout(timer); timer = setTimeout(() => setTyping(editable(document.activeElement)), 60); };
    document.addEventListener("focusin", focus); document.addEventListener("focusout", focus); focus();
    return () => { clearTimeout(timer); document.removeEventListener("focusin", focus); document.removeEventListener("focusout", focus); };
  }, []);
  const register = useCallback((key: string, value: Candidate | null) => setCandidates(previous => {
    if (value) return { ...previous, [key]: value };
    const next = { ...previous }; delete next[key]; return next;
  }), []);
  const finish = useCallback((id: GuideId, status: "completed" | "skipped") => {
    setDismissed(previous => new Set(previous).add(id)); setRequested(null);
    if (scope === "guest") { try { localStorage.setItem(guestKey, "done"); } catch { /* Local-only anonymous state. */ } return; }
    void fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ guideId: id, status }), signal: AbortSignal.timeout(10_000) }).then(async response => {
      if (!response.ok) throw Error("guide-save");
      const body: GuideState = await response.json();
      // Responses from concurrent guide completions can arrive out of order.
      setState(previous => {
        const merged = { ...previous?.guides };
        for (const [key, entry] of Object.entries(body.guides)) if (!merged[key] || merged[key].version < entry.version || merged[key].at <= entry.at) merged[key] = entry;
        return { version: 1, guides: merged };
      });
    }).catch(() => setNotice("引导进度暂未确认保存；不影响学习，可从账号设置重新查看。"));
  }, [endpoint, scope]);
  const replay = useCallback((id: GuideId) => { if (guideAllowed(scope, id)) { setRequested(id); setReplayEpoch(value => value + 1); setNotice(""); } }, [scope]);
  const active = typing ? undefined : Object.entries(candidates).filter(([, item]) => !item.paused && guideAllowed(scope, item.id) && (requested === item.id || (!dismissed.has(item.id) && (scope === "guest" ? guestFinished === false : state && state.guides[item.id]?.version !== guideVersion))))
    .sort(([, a], [, b]) => (Number(b.id === requested) - Number(a.id === requested)) || b.priority - a.priority)[0]?.[0];
  const context = useMemo(() => ({ active, register, finish, replay, replayEpoch }), [active, register, finish, replay, replayEpoch]);
  return <Context.Provider value={context}>{children}{notice && <div className="mia-save-notice" role="status">{notice}<button type="button" onClick={() => setNotice("")} aria-label="关闭引导保存提示"><X size={16} /></button></div>}</Context.Provider>;
}

export function MiaReplay({ id, children = "重新看看 Mia 引导", onReplay, className = "", label }: { id: GuideId; children?: ReactNode; onReplay?: () => void; className?: string; label?: string }) {
  const context = useContext(Context);
  return <button type="button" className={`mia-replay dw-text-button ${className}`} aria-label={label} title={label} onClick={() => { onReplay?.(); context?.replay(id); }}>{children}</button>;
}

export function MiaGuide({ id, paused = false, priority = 0, text, steps }: { id: GuideId; paused?: boolean; priority?: number; text?: string; steps?: GuideStep[] }) {
  const context = useContext(Context), key = useId(), label = useId(), reduced = useReducedMotion();
  const register = context?.register, card = useRef<HTMLDivElement>(null), replayEpoch = context?.replayEpoch;
  const progressKey = `${id}:${replayEpoch}`, [progress, setProgress] = useState({ key: progressKey, step: 0 });
  const step = progress.key === progressKey ? progress.step : 0;
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });
  const active = context?.active === key, definition = steps ? { steps } : guides[id], item = definition.steps[Math.min(step, definition.steps.length - 1)];
  useEffect(() => { if (!register) return; register(key, { id, priority, paused }); return () => register(key, null); }, [register, key, id, priority, paused]);
  useLayoutEffect(() => {
    if (!active) return;
    const element = card.current; if (!element) return;
    let frame = 0;
    const place = () => {
      const bounds = element.getBoundingClientRect(), width = Math.min(360, window.innerWidth - 32), height = bounds.height;
      const anchor = item.target ? document.querySelector<HTMLElement>(`[data-mia-anchor="${item.target}"]`) : null;
      const target = item.target === "essay-inquiry" ? anchor?.querySelector("form") ?? anchor : anchor;
      const targetRect = target?.getBoundingClientRect();
      const visible = targetRect && targetRect.width > 0 && targetRect.height > 0 && targetRect.bottom > 0 && targetRect.top < innerHeight;
      const left = visible ? Math.min(innerWidth - width - 16, Math.max(16, targetRect.left + targetRect.width / 2 - width / 2)) : Math.max(16, (innerWidth - width) / 2);
      const top = visible ? (targetRect.top > height + 32 ? targetRect.top - height - 14 : targetRect.bottom + 14) : Math.min(100, Math.max(16, (innerHeight - height) / 2));
      setPosition({ left, top: Math.max(12, Math.min(innerHeight - height - 12, top)), width, visibility: "visible" });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; place(); }); };
    const observer = new ResizeObserver(schedule); observer.observe(element);
    const anchor = item.target ? document.querySelector(`[data-mia-anchor="${item.target}"]`) : null;
    if (anchor) observer.observe(anchor);
    place(); window.addEventListener("resize", schedule); document.addEventListener("scroll", schedule, true);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); window.removeEventListener("resize", schedule); document.removeEventListener("scroll", schedule, true); };
  }, [active, item.target, step]);
  if (!active || !context) return null;
  return <motion.div ref={card} className="mia-guide" data-mia-guide={id} role="dialog" aria-labelledby={label} style={position}
    initial={reduced ? false : { y: 9, scale: .98 }} animate={{ y: 0, scale: 1 }} transition={{ type: "spring", duration: .28, bounce: .08 }}
    onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); context.finish(id, "skipped"); } }}>
    <button type="button" className="mia-close" aria-label="关闭 Mia 引导" onClick={() => context.finish(id, "skipped")}><X size={17} /></button>
    <div className="mia-guide-heading"><Image src="/mia-guide-v1.webp" alt="" width={88} height={80} unoptimized /><div><small>Mia 陪你逛逛{step >= 0 && definition.steps.length > 1 ? ` · ${step + 1}/${definition.steps.length}` : ""}</small><h2 id={label}>{item.title}</h2></div></div>
    <p>{text && Math.max(0, step) === 0 ? text : item.text}</p>
    <div className="mia-guide-actions"><button type="button" className="mia-skip" onClick={() => context.finish(id, "skipped")}>我先自己逛逛</button><button type="button" className="mia-next" onClick={() => { if (step + 1 < definition.steps.length) setProgress({ key: progressKey, step: step + 1 }); else context.finish(id, "completed"); }}>{step === 0 && definition.steps.length > 1 ? "带我看看" : step + 1 < definition.steps.length ? "下一处" : "好，我来试试"}<ArrowRight size={16} /></button></div>
  </motion.div>;
}
