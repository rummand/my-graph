"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui";
import { switchGraph } from "./client-api";

/** Opens another graph you're in, then reloads the page you're on in that graph. */
export function SwitchButton({ graphId, children, variant = "secondary" }: { graphId: string; children: React.ReactNode; variant?: "primary" | "secondary" | "ghost" }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button size="sm" variant={variant} disabled={busy} onClick={async () => {
        setBusy(true); setError(null);
        try { await switchGraph(graphId); router.refresh(); }
        catch (e) { setError((e as Error).message); setBusy(false); }
      }}>{busy ? "Opening…" : children}</Button>
      {error && <span role="alert" className="text-sm text-danger">{error}</span>}
    </span>
  );
}
