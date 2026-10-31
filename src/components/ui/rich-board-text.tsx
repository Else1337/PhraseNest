"use client";

import { Streamdown, type Components } from "streamdown";
import {memo} from "react";
import { ReadingCitationLink } from "@/components/student/reading-citations";
import { safeReadingUrl } from "@/lib/student/inline-sources";
import { cleanStudyMetadata } from "@/lib/student/memory-presentation";

const components: Components = {
  strong: ({ children }) => <strong>{children}</strong>,
  em: ({ children }) => <em>{children}</em>,
  del: ({ children }) => <del>{children}</del>,
  code: ({ children }) => <code>{children}</code>,
  a: ({ href, children }) => <ReadingCitationLink href={href}>{children}</ReadingCitationLink>,
  table: ({ children }) => <div className="dw-table-scroll" role="region" aria-label="学习内容表格，可横向滑动" tabIndex={0}><table>{children}</table></div>
};

// Stable renderer identities preserve selection while the next block streams.
// Native HTML and remote images stay disabled; source anchors are owner-checked.
export const RichBoardText=memo(function RichBoardText({ content, streaming = false, hideStudyMetadata = false }: { content: string; streaming?: boolean; hideStudyMetadata?: boolean }) {
  return <Streamdown className={`rich-board-text ${streaming ? "is-streaming" : ""}`} mode={streaming ? "streaming" : "static"} isAnimating={false} parseIncompleteMarkdown={streaming} components={components} controls={false} skipHtml disallowedElements={["img", "iframe", "video", "audio", "input", "form"]} urlTransform={safeReadingUrl}>{hideStudyMetadata ? cleanStudyMetadata(content) : content}</Streamdown>;
});
