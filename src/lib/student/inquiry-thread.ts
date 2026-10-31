import type { ReadingAnchor, ReadingAnnotation } from "./dialogue-model";
import { normalizedQuote } from "./reading-flow";

// A thread belongs to one immutable selection in one owned conversation.
export function inquiryThread(annotations: readonly ReadingAnnotation[], conversationId: string, anchor: ReadingAnchor) {
  return annotations.filter(item => item.conversationId === conversationId && item.anchor.messageId === anchor.messageId && item.anchor.sourceId === anchor.sourceId && item.anchor.section === anchor.section && (item.anchor.occurrence ?? 0) === (anchor.occurrence ?? 0) && normalizedQuote(item.anchor.quote) === normalizedQuote(anchor.quote)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function essayReadingAnchor(messageId: string, content: string): ReadingAnchor {
  return { messageId, section: "作文批改", quote: normalizedQuote(content).slice(0, 240) };
}
