"use client";
import { useEffect, useRef } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

interface Props {
  level: 0 | 1 | 2;
  children: React.ReactNode;
}

// Variant FUNCTIONS so AnimatePresence's `custom` can thread the live direction
// into the exiting element (plain objects bake the direction at mount → pops
// would animate the wrong way).
const variants = {
  initial: (dir: number) => ({ x: dir > 0 ? "100%" : "-30%" }),
  animate: { x: 0 },
  exit: (dir: number) => ({ x: dir > 0 ? "-30%" : "100%" }),
};

/**
 * Full-screen drill-down stack for mobile. One pane visible at a time, keyed by
 * `level` so push (level↑) slides in from the right and pop (level↓) slides back
 * out to the right. Keyed by LEVEL not route, so sibling navigations at the same
 * level are a plain content swap (no slide, no remount churn).
 */
export function MobileStack({ level, children }: Props) {
  const prevLevel = useRef(level);
  const dir = level >= prevLevel.current ? 1 : -1; // 1 = push (R→L), -1 = pop
  useEffect(() => {
    prevLevel.current = level;
  }, [level]);
  const reduce = useReducedMotion();

  return (
    <div className="relative flex-1 min-w-0 overflow-hidden">
      <AnimatePresence initial={false} custom={dir}>
        <motion.div
          key={level}
          custom={dir}
          className="absolute inset-0 flex flex-col"
          variants={variants}
          initial={reduce ? false : "initial"}
          animate="animate"
          exit={reduce ? { opacity: 0 } : "exit"}
          transition={{ duration: 0.24, ease: [0.32, 0.72, 0, 1] }}
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
