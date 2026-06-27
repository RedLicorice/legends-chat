"use client";
import { useRef } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

interface Props {
  level: 0 | 1 | 2;
  children: React.ReactNode;
}

/**
 * Full-screen drill-down stack for mobile. One pane visible at a time, keyed by
 * `level` so push (level↑) slides in from the right and pop (level↓) slides back
 * out. Keyed by LEVEL not route, so sibling navigations at the same level are a
 * plain content swap (no slide, no remount churn).
 */
export function MobileStack({ level, children }: Props) {
  const prevLevel = useRef(level);
  const dir = level >= prevLevel.current ? 1 : -1; // 1 = push (R→L), -1 = pop
  prevLevel.current = level;
  const reduce = useReducedMotion();

  return (
    <div className="relative flex-1 min-w-0 overflow-hidden">
      <AnimatePresence initial={false} custom={dir}>
        <motion.div
          key={level}
          custom={dir}
          className="absolute inset-0 flex flex-col"
          initial={reduce ? false : { x: dir > 0 ? "100%" : "-30%" }}
          animate={{ x: 0 }}
          exit={reduce ? { opacity: 0 } : { x: dir > 0 ? "-30%" : "100%" }}
          transition={{ duration: 0.24, ease: [0.32, 0.72, 0, 1] }}
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
