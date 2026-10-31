export const guideIds = ["chat", "library", "memory", "learning", "tasks", "essay", "focus", "bank", "activation", "teacher"] as const;
export type GuideId = typeof guideIds[number];
export type GuideScope = "student" | "teacher" | "guest";
export const guideVersion = 1;
export type GuideStep = { title: string; text: string; target?: string };
export const guides: Record<GuideId, { scope: GuideScope; steps: GuideStep[] }> = {
  chat: { scope: "student", steps: [
    { title: "嗨，我是 Mia，今天想从哪里开始？", text: "拍道题、发篇作文，或者直接说“这里没懂”都可以。不用先整理好思路，我们边聊边找。", target: "composer" },
    { title: "聊过的，也可以慢慢攒起来。", text: "读到喜欢的表达，选中就能收藏或追问；右上角的小星星，是这次对话的表达口袋。", target: "bank" },
  ] },
  library: { scope: "student", steps: [
    { title: "好资料，也要有个自己的小窝。", text: "讲义、试卷和随手记下的笔记，都可以放进来。点“＋”上传，原件保存后会在后台解析。", target: "library-add" },
    { title: "需要的时候，再一起翻出来。", text: "可以搜标题和正文，也可以在对话里请我查资料。长按一份资料，就能整理、移动或移除它。", target: "library-search" },
  ] },
  memory: { scope: "student", steps: [
    { title: "今天，也来攒一点喜欢的表达吧。", text: "想连着读，就选“长文”；想专心记一条，就切到“聚焦”。上方收起后，拉开小横杆就能调出来。", target: "memory-modes" },
    { title: "碰到没懂的，叫我一声就好。", text: "选中一小段就能询问，也能标记不熟、已会或加入语料。还没有日课时，可以先到定时任务里设置。" },
  ] },
  learning: { scope: "student", steps: [
    { title: "你的学习地图，正在一点点长出来。", text: "我会把对话、批改和练习里的线索放在这里。点开一个关注点，就能找到当时的原句；有不同想法，我们再一起核对。", target: "profile" },
  ] },
  tasks: { scope: "student", steps: [
    { title: "给学习留个小约定吧。", text: "选好时间和内容，我会按设置从资料库准备日课，完成后在站内提醒你。临时想换个节奏？随时回来调整就好。", target: "task-time" },
  ] },
  essay: { scope: "student", steps: [
    { title: "作文摊开啦，我们一句句看。", text: "选中哪里，就能问哪里；下面也可以接着追问，不用退出去重新讲一遍。回答放在小球里，点开、收起都不打断阅读。", target: "essay-inquiry" },
  ] },
  focus: { scope: "student", steps: [
    { title: "先别急着揭晓，给自己几秒钟。", text: "点一下再看释义和语境，按真实感受标记就好。不熟也没关系，留着再练。", target: "focus-reveal" },
  ] },
  bank: { scope: "student", steps: [
    { title: "这句话不错，先收进小口袋。", text: "读完再挑一挑，把真正想留下的表达加入个人记忆，慢慢变成自己的语言。这里只收录你选的，不会自动替你标成掌握。", target: "bank-confirm" },
  ] },
  activation: { scope: "guest", steps: [
    { title: "你的学习小窝，马上就准备好啦。", text: "填上老师给的用户名和激活码，再设一个自己的密码。我们进去看看？", target: "activation-form" },
  ] },
  teacher: { scope: "teacher", steps: [
    { title: "班级建好，就可以一起照看学习啦。", text: "先建一个班级，再批量加入学生。学生用一次性激活码设置自己的密码，不必由您保管。", target: "teacher-class" },
    { title: "看见问题，也能找到它的来处。", text: "学生加入后，点开姓名就能查看学习线索和原始证据。您的复核意见会单独保留，不改动学生原句。", target: "teacher-students" },
  ] },
};
export function guideAllowed(scope: GuideScope, id: GuideId) { return guides[id].scope === scope; }
