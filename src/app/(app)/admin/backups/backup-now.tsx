"use client";
import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { DatabaseBackup } from "lucide-react";
import { Button } from "@/components/ui";
import { backUpNow, type BackupNowState } from "./actions";

/** The "Back up now" button, and a quiet refresh while a backup runs. Labels come translated from the server. */
export function BackupNow({ running, disabled, labels }: {
  running: boolean; disabled: boolean;
  labels: { now: string; running: string; started: string; busy: string };
}) {
  const router = useRouter();
  const [state, action, pending] = useActionState<BackupNowState, FormData>(backUpNow, { status: "idle" });
  useEffect(() => {
    if (!running && state.status !== "started") return;
    const id = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(id);
  }, [running, state.status, router]);
  const message = state.status === "busy" ? labels.busy : state.status === "started" && running ? labels.started : null;
  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <Button type="submit" disabled={disabled || running || pending}>
        <DatabaseBackup size={16} aria-hidden />{running || pending ? labels.running : labels.now}
      </Button>
      {message && <p role="status" className="text-sm text-muted">{message}</p>}
    </form>
  );
}
