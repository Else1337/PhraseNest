"use client";

import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";

export type ExpandableTabItem<T extends string> = {
  id: T;
  label: string;
  icon: ReactNode;
};

export function ExpandableTabs<T extends string>({
  items,
  value,
  onValueChange,
  ariaLabel = "Navigation tabs"
}: {
  items: ExpandableTabItem<T>[];
  value: T;
  onValueChange: (value: T) => void;
  ariaLabel?: string;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.nav
      className="be-expandable-tabs"
      aria-label={ariaLabel}
      initial={false}
      layout={reduce ? false : true}
      transition={reduce ? { duration: 0 } : { type: "spring", duration: 0.58, bounce: 0.06 }}
    >
      {items.map((item) => {
        const active = item.id === value;
        return (
          <motion.button
            key={item.id}
            type="button"
            aria-current={active ? "page" : undefined}
            aria-label={item.label}
            className={active ? "active" : ""}
            onClick={() => onValueChange(item.id)}
            initial={false}
            animate={{ width: active ? 116 : 42 }}
            transition={reduce ? { duration: 0 } : { type: "spring", duration: 0.46, bounce: 0.04 }}
          >
            {active && <motion.i layoutId="expandable-tab-pill" transition={reduce ? { duration: 0 } : { type: "spring", duration: 0.46, bounce: 0.04 }} />}
            <span className="be-tab-icon">{item.icon}</span>
            <motion.span
              className="be-tab-label"
              aria-hidden={!active}
              animate={{ width: active ? "auto" : 0, opacity: active ? 1 : 0, marginLeft: active ? 7 : 0 }}
              transition={reduce ? { duration: 0 } : active ? { type: "spring", duration: 0.38, bounce: 0.03 } : { duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
            >
              {item.label}
            </motion.span>
          </motion.button>
        );
      })}
    </motion.nav>
  );
}
