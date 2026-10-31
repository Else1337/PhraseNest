"use client";
import { createContext, useContext } from "react";
import type { ReadingAnchor, ReadingAnnotation, BankEntry } from "@/lib/student/dialogue-model";
export const ReadingSessionContext = createContext<{
  add: (anchor: ReadingAnchor) => Promise<void>;
  openBank: (messageId?: string) => void;
  openAnnotation: (entry: ReadingAnnotation, rect?: DOMRect) => void;
  thread: (anchor: ReadingAnchor) => ReadingAnnotation[];
  inquire: (anchor: ReadingAnchor, id: string, question: string, onDelta: (delta: string) => void) => Promise<unknown>;
  mountPortalHost: (host: HTMLElement | null) => void;
  portalHost: HTMLElement | null;
  annotations: ReadingAnnotation[];
  bank: (BankEntry & { pending?: boolean })[];
} | null>(null);
export const useReadingSession = () => useContext(ReadingSessionContext);
