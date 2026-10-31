"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ReadingAnnotation } from "@/lib/student/dialogue-model";
import { useReadingSession } from "./reading-session-context";
export function ReadingSurface({ messageId, section = "正文", sourceId, aliases = [], children }: { messageId: string; section?: string; sourceId?: string; aliases?: string[]; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null), session = useReadingSession();
  const [markers, setMarkers] = useState<{ entry: ReadingAnnotation; left: number; top: number }[]>([]);
  const matching = session?.annotations.filter((item) => (item.anchor.messageId === messageId || aliases.includes(item.anchor.messageId)) && item.anchor.section === section && item.anchor.sourceId === sourceId) ?? [];
  const entries = matching.filter((item, index) => matching.findIndex(other => other.anchor.messageId === item.anchor.messageId && other.anchor.quote === item.anchor.quote && (other.anchor.occurrence ?? 0) === (item.anchor.occurrence ?? 0)) === index);
  const signature = entries.map((entry) => `${entry.id}:${entry.status}`).join("|");
  useEffect(() => {
    const element = ref.current;
    if (!element || !entries.length) return;
    const names: string[] = []; let alive = true;
    const update = () => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, { acceptNode: (node) => node.parentElement?.closest("button,style,script") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
      const nodes: Text[] = []; let text = ""; let node: Node | null;
      while ((node = walker.nextNode())) { nodes.push(node as Text); text += node.textContent; }
      const markers: { entry: ReadingAnnotation; left: number; top: number }[] = [];
      for (const entry of entries) {
        let start = text.indexOf(entry.anchor.quote);
        for (let occurrence = 0; occurrence < (entry.anchor.occurrence ?? 0) && start >= 0; occurrence++) start = text.indexOf(entry.anchor.quote, start + entry.anchor.quote.length);
        if (start < 0) continue;
        const locate = (offset: number) => { let consumed = 0; for (const textNode of nodes) { if (consumed + textNode.length >= offset) return { node: textNode, offset: offset - consumed }; consumed += textNode.length; } return null; };
        const a = locate(start), b = locate(start + entry.anchor.quote.length); if (!a || !b) continue;
        const range = document.createRange(); range.setStart(a.node, a.offset); range.setEnd(b.node, b.offset);
        const highlights = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
        const NativeHighlight = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
        const name = `annotation-${entry.id}`;
        if (highlights && NativeHighlight) { highlights.set(name, new NativeHighlight(range)); names.push(name); }
        const rect = Array.from(range.getClientRects()).at(-1), origin = element.getBoundingClientRect();
        if (rect) markers.push({ entry, left: Math.min(element.clientWidth - 26, rect.right - origin.left + 4), top: rect.top - origin.top });
      }
      setMarkers((previous) => previous.length === markers.length && previous.every((marker, index) => marker.entry === markers[index].entry && Math.abs(marker.left - markers[index].left) < .5 && Math.abs(marker.top - markers[index].top) < .5) ? previous : markers);
    };
    const frame = requestAnimationFrame(update), observer = new ResizeObserver(update); observer.observe(element);
    void document.fonts.ready.then(() => { if (alive) update(); });
    return () => { alive = false; cancelAnimationFrame(frame); observer.disconnect(); const highlights = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights; names.forEach((name) => highlights?.delete(name)); };
    // Anchors are immutable; status changes refresh marker contents after an answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageId, section, sourceId, signature, children]);
  return <div ref={ref} className="dw-reading-surface" data-reading-message={messageId} data-reading-section={section} data-reading-source={sourceId}><style>{entries.map((entry) => `::highlight(annotation-${entry.id}){background:#edf2e9;text-decoration:underline;text-decoration-color:#c2d2b7;text-underline-offset:4px;}`).join("")}</style>{children}{markers.map(({ entry, left, top }, index) => <button key={entry.id} className="dw-annotation-marker" data-annotation-id={entry.id} style={{ left, top }} aria-label={`询问 ${index + 1}`} onClick={(event) => session?.openAnnotation(entry, event.currentTarget.getBoundingClientRect())}>{index + 1}</button>)}</div>;
}
