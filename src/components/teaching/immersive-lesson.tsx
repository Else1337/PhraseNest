"use client";

import Link from "next/link";
import Image from "next/image";
import { FormEvent, useMemo, useState } from "react";

const cards = [
  {
    id: "task",
    label: "任务",
    title: "今天只解决一个问题",
    body: "读完两句后，能判断第二句有没有增加新信息。",
    detail: "我们不会修改整篇作文，也不会提前展示范文。接下来的每张卡只解释一个关键点。"
  },
  {
    id: "phenomenon",
    label: "现象",
    title: "两句话都在告诉读者什么？",
    body: "两句用词不同，但承担的叙事任务相同。",
    detail: "第一句和第二句都在传递“我听见了蜂鸟的叫声”，故事还停在同一幅画面。"
  },
  {
    id: "principle",
    label: "原理",
    title: "续写需要不断增加新信息",
    body: "重复不是字数问题，而是故事没有向前走。",
    detail: "如果删掉第二句，读者没有损失新信息，它就可能需要被压缩或改写。"
  },
  {
    id: "example",
    label: "示例",
    title: "让第二句承担新的任务",
    body: "I heard footsteps behind me. I turned and saw Dad at the gate.",
    detail: "第一句负责感知，第二句进入动作和新画面。"
  },
  {
    id: "strategy",
    label: "策略",
    title: "保留、推进、复查",
    body: "保留一次感知信息；让下一句进入动作；最后检查有没有新增错误。",
    detail: "先把方法记清楚，再开始判断和改写。"
  },
  {
    id: "check",
    label: "确认",
    title: "哪一种修改策略最合适？",
    body: "完成阅读后，用一个选择验证理解。",
    detail: ""
  },
  {
    id: "rewrite",
    label: "改写",
    title: "回到原句，写出你的版本",
    body: "AI 提供逐级提示，但不会代替你完成句子。",
    detail: ""
  },
  {
    id: "review",
    label: "复检",
    title: "这次修改解决了什么？",
    body: "只检查原问题、新错误与掌握度变化。",
    detail: ""
  }
] as const;

const original =
  "A familiar squeaking call floated into my ears, breaking the silence. As soon as that familiar squeaking reached my ears, I spun around toward where she'd appeared and waved softly.";

const initial =
  "A familiar squeaking call broke the silence. I spun around toward where she'd appeared and waved softly.";

function answerFor(question: string) {
  if (/为什么|重复/.test(question)) {
    return "两处都在传递“我听见了叫声”。第二句没有增加动作、反应或结果，所以故事仍停在原处。";
  }
  if (/保留|哪部分/.test(question)) {
    return "保留第一次听到叫声，以及后面的 spun around 和 waved softly。第二次“听见叫声”可以压缩。";
  }
  return "把两句话想成两张连续的照片：第一张已经拍到“听见叫声”，第二张最好出现一个新动作或结果。";
}

export function ImmersiveLesson() {
  const [index, setIndex] = useState(0);
  const [answer, setAnswer] = useState<number | null>(null);
  const [rewrite, setRewrite] = useState(initial);
  const [questionOpen, setQuestionOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [conversation, setConversation] = useState<Array<{ q: string; a: string }>>([]);
  const card = cards[index];
  const completed = index === cards.length - 1 && card.id === "review";

  const review = useMemo(() => {
    const text = rewrite.toLowerCase();
    return {
      changed: rewrite.trim() !== original.trim(),
      repetition: !text.includes("that familiar squeaking reached my ears"),
      action: /(spun|turned|waved|looked|saw)/.test(text)
    };
  }, [rewrite]);

  const passed = review.changed && review.repetition && review.action;

  function next() {
    if (card.id === "review" && !passed) {
      setIndex(cards.findIndex((item) => item.id === "rewrite"));
      return;
    }
    setIndex((value) => Math.min(value + 1, cards.length - 1));
  }

  function ask(event: FormEvent) {
    event.preventDefault();
    const value = question.trim();
    if (!value) return;
    setConversation((items) => [...items, { q: value, a: answerFor(value) }]);
    setQuestion("");
  }

  const mascot =
    card.id === "review"
      ? "/mascot-success.png"
      : questionOpen
        ? "/mascot-ask.png"
        : ["principle", "example", "strategy"].includes(card.id)
          ? "/mascot-think.png"
          : "/mascot-guide.png";

  return (
    <main className="lesson-shell">
      <header className="lesson-header">
        <Link href="/">← 退出教学</Link>
        <div>
          <strong>表达重复 · 针对性训练</strong>
          <span>{card.label} · {index + 1}/{cards.length}</span>
        </div>
        <button type="button">历史依据 · 3 次</button>
        <i><b style={{ width: `${((index + 1) / cards.length) * 100}%` }} /></i>
      </header>

      <section className="lesson-workspace">
        <aside className="lesson-evidence">
          <p className="eyebrow">蜂鸟报恩 · 当前证据</p>
          <blockquote>{original}</blockquote>
          <span>先理解句子，再开始修改。</span>
        </aside>

        <section className="lesson-card-wrap">
          <div className="read-tabs">
            {cards.slice(0, index).map((item, itemIndex) => (
              <button type="button" key={item.id} onClick={() => setIndex(itemIndex)}>
                ✓ {item.label}
              </button>
            ))}
          </div>

          <article className="production-lesson-card">
            <header>
              <div>
                <p className="eyebrow">{String(index + 1).padStart(2, "0")} · {card.label}</p>
                <h1>{card.title}</h1>
                <p>{card.body}</p>
              </div>
              <Image src={mascot} alt="铅笔老师正在引导当前任务" width={128} height={128} />
            </header>

            <div className="lesson-card-body">
              {["task", "principle", "strategy"].includes(card.id) && (
                <div className="teaching-note">
                  <strong>{card.id === "strategy" ? "修改方法" : "本张要点"}</strong>
                  <p>{card.detail}</p>
                </div>
              )}

              {card.id === "phenomenon" && (
                <div className="evidence-comparison">
                  <article><span>第一次</span><p>A familiar squeaking call floated into my ears.</p></article>
                  <article><span>第二次</span><p>That familiar squeaking reached my ears.</p></article>
                  <small>{card.detail}</small>
                </div>
              )}

              {card.id === "example" && (
                <div className="example-card">
                  <span>推进示例</span>
                  <p>{card.body}</p>
                  <small>{card.detail}</small>
                </div>
              )}

              {card.id === "check" && (
                <fieldset className="understanding-check">
                  {[
                    "再次描写叫声多么熟悉",
                    "保留一次叫声，让第二句进入人物动作",
                    "删除所有关于叫声的内容"
                  ].map((option, optionIndex) => (
                    <button
                      type="button"
                      key={option}
                      className={answer === optionIndex ? "selected" : ""}
                      onClick={() => setAnswer(optionIndex)}
                    >
                      <span>{String.fromCharCode(65 + optionIndex)}</span>{option}
                    </button>
                  ))}
                  {answer !== null && (
                    <p>{answer === 1 ? "对。第二句应该承担新的叙事任务。" : "既要保留故事事实，也要让下一句增加新画面。"}</p>
                  )}
                </fieldset>
              )}

              {card.id === "rewrite" && (
                <div className="rewrite-box">
                  <label htmlFor="rewrite">在原句上修改</label>
                  <textarea id="rewrite" value={rewrite} onChange={(event) => setRewrite(event.target.value)} />
                  <small>提示：一次感知信息＋一个新的动作画面。</small>
                </div>
              )}

              {card.id === "review" && (
                <div className="review-list">
                  {[
                    ["消除重复信息", review.repetition],
                    ["推动情节", review.action],
                    ["形成新版本", review.changed]
                  ].map(([label, ok]) => (
                    <article key={String(label)} className={ok ? "pass" : "retry"}>
                      <span>{ok ? "✓" : "·"}</span>
                      <strong>{label}</strong>
                    </article>
                  ))}
                  <p>{passed ? "三个检查点都通过了。掌握度 46% → 62%。" : "只需处理未通过的检查点，不必推翻整句话。"}</p>
                </div>
              )}
            </div>

            <footer>
              {index > 0 ? <button type="button" onClick={() => setIndex(index - 1)}>返回上一张</button> : <span />}
              <button
                type="button"
                className="primary-action"
                disabled={card.id === "check" && answer !== 1}
                onClick={next}
              >
                {card.id === "check" ? "确认理解，开始改写" : card.id === "rewrite" ? "提交 AI 复检" : card.id === "review" ? passed ? "本次训练完成" : "返回修改" : "我读懂了，继续"}
              </button>
            </footer>
          </article>
        </section>
      </section>

      <section className={`ask-dock ${questionOpen ? "open" : ""}`}>
        {!questionOpen ? (
          <button type="button" onClick={() => setQuestionOpen(true)}>
            <Image src="/mascot-ask.png" alt="" width={64} height={64} />
            <span><strong>有疑问？随时问笔尖</strong><small>回答会结合当前讲解</small></span>
            <b>提问</b>
          </button>
        ) : (
          <div className="ask-panel">
            <header><strong>问笔尖 · {card.label}</strong><button type="button" onClick={() => setQuestionOpen(false)}>×</button></header>
            {conversation.at(-1) ? (
              <div className="answer-card"><span>“{conversation.at(-1)?.q}”</span><p>{conversation.at(-1)?.a}</p></div>
            ) : (
              <div className="ask-chips">
                {["为什么这算重复？", "我应该保留哪部分？", "我还是没看懂"].map((item) => (
                  <button type="button" key={item} onClick={() => setConversation([{ q: item, a: answerFor(item) }])}>{item}</button>
                ))}
              </div>
            )}
            <form onSubmit={ask}><input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="说说你卡在哪里……" /><button type="submit">发送</button></form>
          </div>
        )}
      </section>
      {completed && <span className="sr-only">教学已完成</span>}
    </main>
  );
}
