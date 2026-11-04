/**
 * "Ask anything" → the assistant. The shell's ask box dispatches this; the Ask panel (or, on /chat, the full-size
 * chat) handles it and marks it handled. A question is optional: without one the panel just opens.
 */
export const ASK_EVENT = "mg:ask";

export type AskDetail = { question?: string; handled: boolean };

/** Returns true when something took the question (the panel or /chat). */
export function askAssistant(question?: string): boolean {
  if (typeof window === "undefined") return false;
  const detail: AskDetail = { question: question?.trim() || undefined, handled: false };
  window.dispatchEvent(new CustomEvent<AskDetail>(ASK_EVENT, { detail }));
  return detail.handled;
}
