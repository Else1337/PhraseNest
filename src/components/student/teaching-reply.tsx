"use client";
import type { ReactNode } from "react";
import { EssayReader } from "./essay-reader";
import type { DialogueMessage, DialogueWorkspace } from "@/lib/student/dialogue-model";
import type { ReadingSource } from "@/lib/student/inline-sources";
import { compactSourceLabels } from "@/lib/student/inline-sources";
import { essayReviewPresentation, teachingLabel } from "@/lib/student/reading-flow";
import { hasToolProtocol } from "@/lib/ai/tool-protocol";
import { RichBoardText } from "@/components/ui/rich-board-text";
import { ReadingSources, SourceCorners } from "./reading-citations";
import { AccumulateButton, ReadingSurface } from "./reading-session";

export function AgentStatus({ label }: { label?: string }) {
  return <div className="dw-agent-status" role="status"><span className="dw-search-book" aria-hidden="true"><i /><i /><i /></span><span>{label || "正在整理…"}</span></div>;
}

export function AgentProgress({ entries, active = false }: { entries: string[]; active?: boolean }) {
  if (!entries.length) return null;
  return <ol className="dw-agent-progress" aria-label="解答进程" aria-live="polite">{entries.map((label, index) => <li key={index}>{active && index === entries.length - 1 ? <AgentStatus label={label} /> : <span className="dw-progress-done"><span aria-hidden="true">✓</span>{label}</span>}</li>)}</ol>;
}

export function TeachingReply({ message, question, sources, marks, aliases = [], onRetry, afterContent }: { message: DialogueMessage; question: string; sources: ReadingSource[]; marks: DialogueWorkspace["marks"]; aliases?: string[]; onRetry?: () => void; afterContent?: ReactNode }) {
  const formatted = compactSourceLabels(message.content, sources.filter(source => message.documentIds.includes(source.id)));
  if (hasToolProtocol(message.content)) return <div className="dw-inline-error">这条旧回复没有正确完成，原问题还在。<button className="dw-text-button" onClick={onRetry}>重新解答</button></div>;
  const essay = essayReviewPresentation(message.task, question, message.content);
  return <ReadingSources sources={sources} ids={message.documentIds} marks={marks} messageId={message.id}>
    {essay ? <EssayReader message={message} content={formatted} aliases={aliases} /> : <>
      <div className="dw-teaching-label">{teachingLabel(message.task, question)}</div>
      <ReadingSurface messageId={message.id} aliases={aliases}><RichBoardText content={formatted} /></ReadingSurface>
      {message.documentIds.length > 0 && !formatted.includes("#source:") && <SourceCorners ids={message.documentIds} />}
    </>}
    {afterContent}
    {!essay && <AccumulateButton messageId={message.id} />}
  </ReadingSources>;
}
