export type TeachingStage =
  | "plan"
  | "explanation"
  | "exercise"
  | "rewrite"
  | "review"
  | "summary";

export type EvidenceRange = {
  start: number;
  end: number;
  quote: string;
};

export type TeachingCard = {
  id: string;
  stage: TeachingStage;
  title: string;
  body: string;
  evidence: EvidenceRange[];
  required: boolean;
};

export type TeachingSessionView = {
  id: string;
  studentId: string;
  submissionId: string;
  issueId: string;
  stage: TeachingStage;
  cards: TeachingCard[];
  completedCardIds: string[];
  masteryBefore: number;
  masteryAfter: number | null;
};

export type RewriteReview = {
  originalIssueResolved: boolean;
  newErrors: string[];
  masteryDelta: number;
  feedback: string;
};

export type StudentQuestion = {
  id: string;
  sessionId: string;
  cardId: string;
  content: string;
  answer: string;
  createdAt: string;
};
