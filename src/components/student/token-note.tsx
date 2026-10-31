"use client";
import { useEffect, useState } from "react";
import type { DialogueMessage } from "@/lib/student/dialogue-model";
const count = (n: number | null) => n === null ? "未报告" : n.toLocaleString("zh-CN");
export function TokenNote({ usage: supplied, turnId, createdAt, failed = false }: { usage?: DialogueMessage["usage"]; turnId?: string; createdAt?: string; failed?: boolean }) {
  const [stored, setStored] = useState<DialogueMessage["usage"]>(), [loaded, setLoaded] = useState(false);
  const hasSupplied = Boolean(supplied);
  useEffect(() => {
    if (!turnId) return;
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const response = await fetch(`/api/student/usage?turnId=${encodeURIComponent(turnId)}`, { cache: "no-store", signal: controller.signal });
        if (response.ok) { const body = await response.json(); if (!controller.signal.aborted) { setStored(body.usage ?? undefined); setLoaded(true); } }
      } catch { /* Keep verified supplied usage when a non-critical refresh fails. */ }
    };
    const recent = createdAt && Date.now() - Date.parse(createdAt) < 120_000;
    if (!hasSupplied || recent) void refresh();
    // Observer usage can arrive after the business reply finishes. Bounded
    // refreshes only for recent turns, not a poller for every historical message.
    const timers = recent ? [3_000, 12_000, 40_000, 90_000].map(delay => setTimeout(() => void refresh(), delay)) : [];
    const expanded = () => void refresh();
    window.addEventListener(`zhibi-usage:${turnId}`, expanded);
    return () => { controller.abort(); timers.forEach(clearTimeout); window.removeEventListener(`zhibi-usage:${turnId}`, expanded); };
  }, [hasSupplied, turnId, createdAt]);
  const usage = stored && (!supplied || stored.calls >= supplied.calls) ? stored : supplied;
  if (!usage) return !turnId || loaded ? <p className="dw-token-note" title="历史回复或中断请求没有返回可核验的用量，不按字符数推算。">tokens 未报告</p> : null;
  return <details className="dw-token-note" onToggle={event => { if (event.currentTarget.open && turnId) window.dispatchEvent(new Event(`zhibi-usage:${turnId}`)); }}><summary>{usage.total === null ? "用量部分报告" : `${count(usage.total)} tokens`}</summary>
    <p>输入 {count(usage.input)} · 输出 {count(usage.output)} · 输入缓存 {count(usage.cachedInput)}</p>
    <p>{usage.calls} {usage.measurement ? "条已报告用量" : "次模型调用"} · {usage.attempts} 次生成尝试，包含本轮重试及记忆辅助调用。缓存是输入的一部分，不另加计；输出包含模型报告的推理用量。</p>
    {usage.measurement === "mixed" && <p>本轮包含历史统计口径，用量不可作为新计量的精确对比。</p>}
    {usage.surfaces.map((item) => <p key={`${item.name}:${item.model}`}>{item.name === "dialogue" ? "对话" : item.name === "observer" ? "记忆观察" : item.name === "reflector" ? "记忆整合" : item.name} · {item.model} · 输入 {count(item.input)} / 输出 {count(item.output)} · {item.calls} 次</p>)}
    <p>{failed ? "本次回复中断，以上为已报告用量，可能不完整。" : "以上为已报告用量，后台记忆调用可能稍后补充。"}展开时刷新；不推算服务商未报告的 token。</p>
  </details>;
}
