"use client";
import { MotionConfig } from "motion/react";

/** Shared motion defaults: short ease-out, and no motion for people who asked for less. */
export function MotionRoot({ children }: { children: React.ReactNode }) {
  return <MotionConfig reducedMotion="user" transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}>{children}</MotionConfig>;
}
