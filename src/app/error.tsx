"use client";

export default function StudentError({ reset }: { reset: () => void }) {
  return <main className="student-loading error-state"><span>暂时无法打开学生工作台</span><p>你的项目没有丢失，可以重新加载。</p><button type="button" className="dark-button" onClick={reset}>重新加载</button></main>;
}
