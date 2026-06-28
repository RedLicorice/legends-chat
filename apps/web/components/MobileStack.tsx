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
 * `level`. Push (level↑) slides in from the right. Pop (level↓) is INSTANT — the
 * OS swipe-back already plays its own native page transition, so animating ours
 * on top produced a visible double-animation. Button Back (router.back) is also
 * a pop, so it's instant too. Keyed by LEVEL not route, so sibling navigations
 * at the same level are a plain content swap (no slide, no remount churn).
 */
export function MobileStack({ level, children }: Props) {
  const prevLevel = useRef(level);
  const dir = level >= prevLevel.current ? 1 : -1; // 1 = push (R→L), -1 = pop
  useEffect(() => {
    prevLevel.current = level;
  }, [level]);
  const reduce = useReducedMotion();
  // Animate only on push; pop (incl. swipe-back) and reduced-motion swap instantly.
  const animateSlide = dir > 0 && !reduce;

  return (
    <div className="relative flex-1 min-w-0 overflow-hidden">
      <AnimatePresence initial={false} custom={dir}>
        <motion.div
          key={level}
          custom={dir}
          className="absolute inset-0 flex flex-col"
          variants={variants}
          initial={animateSlide ? "initial" : false}
          animate="animate"
          exit={animateSlide ? "exit" : { opacity: 0 }}
          transition={animateSlide ? { duration: 0.24, ease: [0.32, 0.72, 0, 1] } : { duration: 0 }}
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
