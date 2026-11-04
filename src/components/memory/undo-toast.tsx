"use client";
import { useEffect } from "react";
import { AnimatePresence, motion } from "motion/react";
import { clsx } from "clsx";

/** A small floating note at the bottom: "Forgotten. Undo". Leaves after a few seconds. */
export function UndoToast({ toast, onUndo, onClose, canUndo }: {
  toast: { id: string; text: string; error?: boolean } | null;
  onUndo: (id: string) => void;
  onClose: () => void;
  canUndo: (id: string) => boolean;
}) {
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(onClose, 6000);
    return () => clearTimeout(t);
  }, [toast, onClose]);

  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex justify-center px-4 md:bottom-6">
      <AnimatePresence>
        {toast && (
          <motion.div key={toast.id + toast.text}
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className={clsx("pointer-events-auto flex items-center gap-3 rounded-lg px-4 py-2.5 text-sm shadow-float",
              toast.error ? "bg-danger text-white" : "bg-fg text-bg")}>
            <span>{toast.text}</span>
            {!toast.error && canUndo(toast.id) && (
              <button type="button" onClick={() => onUndo(toast.id)} className="rounded font-medium underline underline-offset-2 hover:no-underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                Undo
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
