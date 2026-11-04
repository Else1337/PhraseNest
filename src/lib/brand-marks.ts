// Exploratory directions using the project's MIT-licensed Phosphor family.
// These are not exclusive or trademark-cleared logo designs.
export const brandMarks = [
  { id: "nest", name: "语巢", description: "小鸟轮廓，呼应 PhraseNest", icon: "Bird", weight: "fill" },
  { id: "pages", name: "拾页", description: "翻开的书页，连接阅读与表达", icon: "BookOpenText", weight: "bold" },
  { id: "growth", name: "生长", description: "新芽与枝叶，呼应学习的积累", icon: "Plant", weight: "fill" }
] as const;
export type BrandMarkId = typeof brandMarks[number]["id"];
