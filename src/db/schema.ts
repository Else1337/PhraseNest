import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector
} from "drizzle-orm/pg-core";

export const userRole = pgEnum("user_role", ["student", "teacher", "admin"]);
export const writingKind = pgEnum("writing_kind", ["continuation", "application"]);
export const diagnosisLayerKey = pgEnum("diagnosis_layer_key", ["mechanics", "language", "content", "exam"]);
export const diagnosisIssueActionType = pgEnum("diagnosis_issue_action_type", ["ask", "disagree", "save", "start_course"]);
export const submissionStatus = pgEnum("submission_status", [
  "draft",
  "ocr_pending",
  "diagnosing",
  "ready",
  "failed"
]);
export const jobStatus = pgEnum("job_status", [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled"
]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
};

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  role: userRole("role").notNull(),
  email: text("email"),
  username: text("username"),
  passwordHash: text("password_hash"),
  displayName: text("display_name").notNull(),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  ...timestamps
}, (table) => [
  uniqueIndex("users_email_unique").on(table.email),
  uniqueIndex("users_username_unique").on(table.username)
]);

export const studentProfiles = pgTable("student_profiles", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  grade: integer("grade"),
  schoolStudentId: text("school_student_id"),
  profileSummary: jsonb("profile_summary").notNull().default({})
});

export const classes = pgTable("classes", {
  id: uuid("id").defaultRandom().primaryKey(),
  teacherId: uuid("teacher_id").notNull().references(() => users.id),
  name: text("name").notNull(),
  joinCode: text("join_code").notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  ...timestamps
}, (table) => [uniqueIndex("classes_join_code_unique").on(table.joinCode)]);

export const classMemberships = pgTable("class_memberships", {
  classId: uuid("class_id").notNull().references(() => classes.id, { onDelete: "cascade" }),
  studentId: uuid("student_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow().notNull()
}, (table) => [
  primaryKey({ columns: [table.classId, table.studentId] }),
  index("class_memberships_student_idx").on(table.studentId)
]);

export const writingTasks = pgTable("writing_tasks", {
  id: uuid("id").defaultRandom().primaryKey(),
  kind: writingKind("kind").notNull(),
  title: text("title").notNull(),
  prompt: jsonb("prompt").notNull(),
  ownerTeacherId: uuid("owner_teacher_id").references(() => users.id),
  ...timestamps
});

export const submissions = pgTable("submissions", {
  id: uuid("id").defaultRandom().primaryKey(),
  studentId: uuid("student_id").notNull().references(() => users.id),
  taskId: uuid("task_id").notNull().references(() => writingTasks.id),
  status: submissionStatus("status").notNull().default("draft"),
  currentVersionNumber: integer("current_version_number").notNull().default(1),
  ...timestamps
}, (table) => [
  index("submissions_student_created_idx").on(table.studentId, table.createdAt)
]);

export const submissionVersions = pgTable("submission_versions", {
  id: uuid("id").defaultRandom().primaryKey(),
  submissionId: uuid("submission_id").notNull().references(() => submissions.id, { onDelete: "cascade" }),
  versionNumber: integer("version_number").notNull(),
  content: text("content").notNull(),
  source: text("source").notNull(),
  parentVersionId: uuid("parent_version_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
}, (table) => [
  uniqueIndex("submission_versions_number_unique").on(table.submissionId, table.versionNumber)
]);

export const diagnoses = pgTable("diagnoses", {
  id: uuid("id").defaultRandom().primaryKey(),
  submissionVersionId: uuid("submission_version_id").notNull().references(() => submissionVersions.id),
  layerResults: jsonb("layer_results").notNull(),
  summary: jsonb("summary").notNull(),
  rawModelResult: jsonb("raw_model_result").notNull(),
  modelJobId: uuid("model_job_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});

export const issueEvidence = pgTable("issue_evidence", {
  id: uuid("id").defaultRandom().primaryKey(),
  diagnosisId: uuid("diagnosis_id").notNull().references(() => diagnoses.id, { onDelete: "cascade" }),
  layerKey: diagnosisLayerKey("layer_key").notNull(),
  skillKey: text("skill_key").notNull(),
  startOffset: integer("start_offset").notNull(),
  endOffset: integer("end_offset").notNull(),
  quote: text("quote").notNull(),
  suggestion: text("suggestion").notNull(),
  explanation: text("explanation").notNull(),
  assessmentBasis: text("assessment_basis").notNull()
});

export const diagnosisIssueActions = pgTable("diagnosis_issue_actions", {
  id: uuid("id").defaultRandom().primaryKey(),
  issueId: uuid("issue_id").notNull().references(() => issueEvidence.id, { onDelete: "cascade" }),
  studentId: uuid("student_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  action: diagnosisIssueActionType("action").notNull(),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
}, (table) => [index("diagnosis_issue_actions_student_idx").on(table.studentId, table.createdAt)]);

export const teachingPlans = pgTable("teaching_plans", {
  id: uuid("id").defaultRandom().primaryKey(),
  studentId: uuid("student_id").notNull().references(() => users.id),
  submissionId: uuid("submission_id").notNull().references(() => submissions.id),
  status: text("status").notNull().default("active"),
  currentStep: integer("current_step").notNull().default(0),
  ...timestamps
});

export const teachingSteps = pgTable("teaching_steps", {
  id: uuid("id").defaultRandom().primaryKey(),
  planId: uuid("plan_id").notNull().references(() => teachingPlans.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  kind: text("kind").notNull(),
  content: jsonb("content").notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true })
}, (table) => [uniqueIndex("teaching_steps_position_unique").on(table.planId, table.position)]);

export const exerciseAttempts = pgTable("exercise_attempts", {
  id: uuid("id").defaultRandom().primaryKey(),
  teachingStepId: uuid("teaching_step_id").notNull().references(() => teachingSteps.id),
  studentId: uuid("student_id").notNull().references(() => users.id),
  answer: jsonb("answer").notNull(),
  correct: boolean("correct").notNull(),
  feedback: text("feedback").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});

export const masteryItems = pgTable("mastery_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  studentId: uuid("student_id").notNull().references(() => users.id),
  skillKey: text("skill_key").notNull(),
  score: integer("score").notNull(),
  evidenceCount: integer("evidence_count").notNull().default(0),
  lastEvidenceAt: timestamp("last_evidence_at", { withTimezone: true }),
  ...timestamps
}, (table) => [uniqueIndex("mastery_student_skill_unique").on(table.studentId, table.skillKey)]);

export const studentSelfAssessments = pgTable("student_self_assessments", {
  id: uuid("id").defaultRandom().primaryKey(),
  studentId: uuid("student_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  teachingPlanId: uuid("teaching_plan_id").notNull().references(() => teachingPlans.id, { onDelete: "cascade" }),
  understanding: text("understanding").notNull(),
  helpfulness: integer("helpfulness").notNull(),
  note: text("note"),
  aiObservation: jsonb("ai_observation").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
}, (table) => [index("student_self_assessments_plan_idx").on(table.teachingPlanId, table.createdAt)]);

export const modelJobs = pgTable("model_jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerId: uuid("owner_id").notNull().references(() => users.id),
  type: text("type").notNull(),
  status: jobStatus("status").notNull().default("queued"),
  provider: text("provider"),
  model: text("model"),
  inputRef: jsonb("input_ref").notNull(),
  progress: jsonb("progress").notNull().default({}),
  error: jsonb("error"),
  attemptCount: integer("attempt_count").notNull().default(0),
  ...timestamps
});

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  actorId: uuid("actor_id").references(() => users.id),
  action: text("action").notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id").notNull(),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
}, (table) => [index("audit_logs_resource_idx").on(table.resourceType, table.resourceId)]);

export const promptTemplates = pgTable("prompt_templates", {
  id: uuid("id").defaultRandom().primaryKey(),
  key: text("key").notNull(),
  version: integer("version").notNull(),
  source: text("source").notNull(),
  content: text("content").notNull(),
  contentHash: text("content_hash").notNull(),
  outputSchemaKey: text("output_schema_key"),
  active: boolean("active").notNull().default(false),
  metadata: jsonb("metadata").notNull().default({}),
  ...timestamps
}, (table) => [
  uniqueIndex("prompt_templates_key_version_unique").on(table.key, table.version),
  index("prompt_templates_active_idx").on(table.key, table.active)
]);

export const seedImports = pgTable("seed_imports", {
  id: uuid("id").defaultRandom().primaryKey(),
  kind: text("kind").notNull(),
  sourcePath: text("source_path").notNull(),
  sourceHash: text("source_hash").notNull(),
  manifest: jsonb("manifest").notNull(),
  importedAt: timestamp("imported_at", { withTimezone: true }).defaultNow().notNull()
}, (table) => [uniqueIndex("seed_imports_kind_hash_unique").on(table.kind, table.sourceHash)]);

export const knowledgeDocuments = pgTable("knowledge_documents", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerId: uuid("owner_id").references(() => users.id),
  scope: text("scope").notNull(),
  sourceType: text("source_type").notNull(),
  title: text("title").notNull(),
  sourcePath: text("source_path").notNull(),
  objectKey: text("object_key"),
  contentHash: text("content_hash").notNull(),
  mimeType: text("mime_type"),
  rights: jsonb("rights").notNull().default({}),
  provenance: jsonb("provenance").notNull().default({}),
  parseStatus: text("parse_status").notNull().default("pending"),
  ...timestamps
}, (table) => [
  uniqueIndex("knowledge_documents_scope_hash_unique").on(table.scope, table.contentHash)
]);

export const knowledgeChunks = pgTable("knowledge_chunks", {
  id: uuid("id").defaultRandom().primaryKey(),
  documentId: uuid("document_id").notNull().references(() => knowledgeDocuments.id, { onDelete: "cascade" }),
  ordinal: integer("ordinal").notNull(),
  content: text("content").notNull(),
  contentHash: text("content_hash").notNull(),
  pageNumber: integer("page_number"),
  paragraphNumber: integer("paragraph_number"),
  labels: jsonb("labels").notNull().default({}),
  embeddingModel: text("embedding_model"),
  embedding: vector("embedding", { dimensions: 1536 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
}, (table) => [
  uniqueIndex("knowledge_chunks_document_ordinal_unique").on(table.documentId, table.ordinal),
  index("knowledge_chunks_document_idx").on(table.documentId)
]);
