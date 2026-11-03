import { clsx } from "clsx";
import { CircleAlert, Check } from "lucide-react";

/** A problem the person needs to fix, said in words. Shared by sign-in, setup and settings. */
export function ErrorNote({ message, className }: { message: string | null; className?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className={clsx("flex items-start gap-2 rounded-md bg-danger-tint px-3 py-2 text-sm text-danger", className)}>
      <CircleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
      <span>{message}</span>
    </p>
  );
}

/** Confirmation that something happened. Quiet: a check and a sentence. */
export function Notice({ message, className }: { message: string | null; className?: string }) {
  if (!message) return null;
  return (
    <p role="status" className={clsx("flex items-start gap-2 text-sm text-fg", className)}>
      <Check size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden />
      <span>{message}</span>
    </p>
  );
}
