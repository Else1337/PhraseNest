import type { StudentDashboard, StudentProjectView } from "@/lib/domain/student-project";

export const demoDashboard: StudentDashboard = {
  student: { id: "7caa6b2e-835c-48ae-9d41-75100515aa0e", username: "student", displayName: "林同学" },
  today: { wordCount: 6, materialCount: 1 },
  projects: [
    { id: "the-rescue", title: "The Rescue", writingKind: "continuation", writingKindLabel: "读后续写", status: "ready", statusLabel: "等待批改", updatedLabel: "今天", detail: "已完成 OCR 校对，分层批改已生成" },
    { id: "a-special-gift", title: "A Special Gift", writingKind: "continuation", writingKindLabel: "读后续写", status: "learning", statusLabel: "进行中", updatedLabel: "昨天", detail: "正在学习：让动作推进情节" },
    { id: "invite-teacher", title: "邀请外教参加活动", writingKind: "application", writingKindLabel: "应用文", status: "completed", statusLabel: "已完成", updatedLabel: "8 月 8 日", detail: "完成一次针对性改写与自评" }
  ],
  materials: [
    { id: "flicker-of-hope", tag: "情绪转折", phrase: "a flicker of hope", note: "用于人物从犹豫到看见希望的细微变化", source: "系统推荐 · 读后续写" },
    { id: "second-thought", tag: "动作链", phrase: "without a second thought", note: "强调人物反应迅速，适合冲突或救援场景", source: "我的收藏 · The Rescue" },
    { id: "invitation-opening", tag: "应用文开头", phrase: "I am writing to extend my sincere invitation", note: "正式邀请信的清楚开场，适合替换普通表达", source: "系统推荐 · 应用文" }
  ],
  vocabulary: [
    { id: "hesitate", word: "hesitate", meaning: "犹豫，迟疑", source: "The Rescue", dueLabel: "今天" },
    { id: "reassuring", word: "reassuring", meaning: "令人安心的", source: "语言表现课程", dueLabel: "今天" },
    { id: "convey", word: "convey", meaning: "传达，表达", source: "应用文词库", dueLabel: "明天" }
  ]
};

export const demoProject: StudentProjectView = {
  ...demoDashboard.projects[0],
  promptTitle: "The Rescue",
  currentVersion: 1,
  currentVersionLabel: "初稿 · 2026.08.11",
  content: "With the ropes and pulleys in place, Ryan began organizing the rescue. He had went towards the narrow crack and called Mia's name.\n\nEmma stayed beside him, her voice was very soft. When the opening grew wide enough, a rescuer carefully moved inside.\n\nRyan saw the dog and felt happy. Then they went home together.",
  wordCount: 168,
  rewriteCount: 1,
  layers: [
    {
      key: "mechanics", label: "规范纠错", tone: "correction", issues: [{ id: "issue-had-went", title: "had went", original: "had went", suggestion: "had gone", reason: "过去完成时由 had + 过去分词构成，went 应改为 gone。", basis: "时态与动词形式", startOffset: 74, endOffset: 82, actions: ["ask", "disagree", "save", "start_course"] }]
    },
    {
      key: "language", label: "语言表现", tone: "language", issues: [{ id: "issue-soft", title: "was very soft", original: "her voice was very soft", suggestion: "her voice softened into a whisper", reason: "用动作和声音变化呈现情绪，而不是直接下结论。", basis: "语言表现与细节描写", startOffset: 156, endOffset: 179, actions: ["ask", "disagree", "save", "start_course"] }]
    },
    {
      key: "content", label: "情节与人物", tone: "story", issues: [{ id: "issue-happy", title: "felt happy", original: "felt happy", suggestion: "froze for a beat, then ran toward the trembling dog", reason: "让人物反应推动画面，并为下一步行动留出空间。", basis: "人物反应与情节推进", startOffset: 273, endOffset: 283, actions: ["ask", "disagree", "save", "start_course"] }]
    },
    {
      key: "exam", label: "衔接与应试", tone: "exam", issues: [{ id: "issue-home", title: "went home", original: "went home", suggestion: "walked home side by side as the last rays of sun faded", reason: "回收开头的傍晚场景，使结尾和前文形成呼应。", basis: "续写衔接与首尾呼应", startOffset: 294, endOffset: 303, actions: ["ask", "disagree", "save", "start_course"] }]
    }
  ]
};
