# 智笔｜浙江高考英语作文批改 Skill v1.0

**独立、可移植的规则型 Skill。** 适配应用文与读后续写的高考模拟评估、内容/情节诊断、语法词块改进、按需深度教学，并保留不同命题年份的评分规则差异。

## 安装

将整个文件夹 `zhibi-gaokao-writing-review` 放入支持 Agent Skills 的宿主 Skills 路径（如项目的 `.agents/skills/` 或该框架实际支持的目录）。让 Agent 能读取顶层 `SKILL.md` 与 `references/`；路径因运行环境而异，不假定 Codex/智笔已接入成功。

## 适用模式

- **估分与诊断**：完整题目＋作文→预测分数（量规、区间、置信）＋高影响问题。
- **只看内容/情节**：不重写学生的英语表达；优先纠正应用文信息不足和续写的因果问题。
- **逐句精批**：原句→错误/风险/优化分类→最小修复→自然替代→迁移。
- **深度教学**：针对重复性语法或核心情节问题做一段完整小课，用户可选练习。
- **只要修改稿**：修订稿即为结束，不要求第二轮审核。

## 重要限制

1. `15/25` 是题型常见满分，不表示公开示例细则就是任意年份官方细则；评分档数、字数规则可覆盖。
2. **未提供原题时不能完成对任务完成度的可信评分**；但可以做充分的语言/内部逻辑分析。
3. 模型估分不是高考阅卷分数；与真实两位教师评价校准之前，不能承诺±1分。
4. 自动读取Notion需要宿主连接器；本Skill不会自动写库、存作文、部署或运行后台任务。

## 文件

- `SKILL.md`：Agent主规则与工作流。
- `references/scoring-and-rubrics.md`：多来源细则优先级、15分五档、25分七档、定档流程。
- `references/practical-writing.md`：应用文交际任务、内容具体化与信息密度。
- `references/continuation-writing.md`：原文伏笔、人物动机、段间因果与语言描写。
- `references/error-and-revision.md`：错误/风险/优化/亮点分类与示例。
- `references/teaching-and-personalization.md`：讲解深度、语料调用、用户习惯。
- `references/calibration-and-integration.md`：人类教师校准、模型评测和智笔接入。
- `references/evaluation-cases.md`：题型、边界及反过度约束测试。
- `references/sources.md`：一线教学与评分研究及用户资料链接。
- `schemas/review.schema.json`：结构化 JSON Schema（供产品后端接入）。
- `schemas/sample-review.json`：纯自编示例，缺题目不评分。
- `scripts/validate_review.py`：本地基础校验；不代替英语质量或教师评分评测。

## 快速运行

```bash
python scripts/validate_review.py schemas/sample-review.json
python -m unittest discover -s tests -v
```

## 推荐集成顺序

先阅读项目 `AGENTS.md` 及既有作文处理代码；先把量规和证据结构接入现有评分管线，再把「内容/情节精批」与「教学」做分层输出；最后收集教师真实评分样本独立校准。不要因创建Skill重建存储层或模型调用系统。

## 来源

见 `references/sources.md`。本包基于已可访问的 Notion主库、Library历史Skill、智笔功能规格及公开一线教研材料，没读取不存在的项目源码。没有向 Notion 或实际仓库执行任何写操作。
