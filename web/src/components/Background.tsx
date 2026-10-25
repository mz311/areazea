"use client";

import { motion } from "framer-motion";

/** Fond animé fixe : grille néon + halos violets en lente dérive. */
export function Background() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div className="grid-bg absolute inset-0" />
      <motion.div
        className="absolute -left-40 -top-40 h-[520px] w-[520px] rounded-full bg-neon-600/25 blur-[140px]"
        animate={{ x: [0, 60, 0], y: [0, 40, 0] }}
        transition={{ duration: 18, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        className="absolute -right-32 top-1/3 h-[460px] w-[460px] rounded-full bg-fuchsia-600/15 blur-[140px]"
        animate={{ x: [0, -50, 0], y: [0, -30, 0] }}
        transition={{ duration: 22, repeat: Infinity, ease: "easeInOut" }}
      />
    </div>
  );
}
