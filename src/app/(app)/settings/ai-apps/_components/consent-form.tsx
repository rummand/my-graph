"use client";
import { useState } from "react";
import { clsx } from "clsx";
import { Bot, Laptop } from "lucide-react";
import { Button } from "@/components/ui";
import { ErrorNote } from "@/app/login/notes";
import { useT } from "@/lib/i18n/client";

type GraphOption = { id: string; name: string; kind: string; canPropose: boolean };

/**
 * The consent form. It is a plain form (POST /api/mcp/oauth/authorize, 303 to the app) that, with JavaScript, is sent
 * with fetch and followed with location.assign: the CSP's form-action 'self' would block a form's redirect to the app.
 */
export function ConsentForm({ app, host, local, person, graphs, defaultGraphId, offered, hidden, problem }: {
  app: string; host: string; local: boolean; person: { name: string; email: string };
  graphs: GraphOption[]; defaultGraphId: string; offered: ("read" | "propose")[]; hidden: Record<string, string>; problem: string | null;
}) {
  const t = useT();
  const [graphId, setGraphId] = useState(graphs.some((g) => g.id === defaultGraphId) ? defaultGraphId : graphs[0]?.id ?? "");
  const [access, setAccess] = useState<"read" | "propose">("read");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(problem ? t(`mcpServer.consent.problem.${problem}`) : null);
  const graph = graphs.find((g) => g.id === graphId);
  const canPropose = offered.includes("propose") && !!graph?.canPropose;
  const blocked = problem === "notAllowed" || !graphs.length;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const form = new FormData(e.currentTarget);
    form.set("decision", submitter?.value === "allow" ? "allow" : "deny");
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/mcp/oauth/authorize", { method: "POST", body: form, headers: { accept: "application/json" }, credentials: "same-origin" });
      const data = (await res.json().catch(() => ({}))) as { redirect?: string; problem?: string };
      if (data.redirect) { window.location.assign(data.redirect); return; }
      setError(t(`mcpServer.consent.problem.${data.problem ?? "network"}`));
    } catch {
      setError(t("mcpServer.consent.problem.network"));
    }
    setBusy(false);
  }

  return (
    <div className="max-w-xl py-2">
      <div className="flex items-start gap-3">
        <span aria-hidden className="mt-1 inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-tint text-accent"><Bot size={20} /></span>
        <div className="min-w-0">
          <h1 className="text-[28px]/[1.15] font-semibold tracking-[-0.02em]">{t("mcpServer.consent.title", { app: `“${app}”` })}</h1>
          <p className="mt-1 text-sm text-muted">{t("mcpServer.consent.nameNote")}</p>
        </div>
      </div>

      <div className="mt-6 space-y-1 text-sm">
        <p>{t("mcpServer.consent.returnsTo", { host })}</p>
        {local && <p className="flex items-start gap-2 text-warn"><Laptop size={16} className="mt-0.5 shrink-0" aria-hidden />{t("mcpServer.consent.local")}</p>}
        <p className="text-muted">
          {t("mcpServer.consent.signedInAs", person)}{" "}
          <button form="mg-signout" type="submit" className="text-accent underline-offset-2 hover:underline">{t("mcpServer.consent.notYou")}</button>
        </p>
      </div>
      <form id="mg-signout" action="/api/auth/logout" method="post" className="hidden" />

      <form action="/api/mcp/oauth/authorize" method="post" onSubmit={submit} className="mt-6 space-y-6">
        {Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}

        {graphs.length ? (
          <fieldset>
            <legend className="text-lg font-semibold">{t("mcpServer.consent.graphLabel")}</legend>
            <p className="mt-0.5 text-sm text-muted">{t("mcpServer.consent.graphHint")}</p>
            <div className="mt-3 overflow-hidden rounded-lg bg-surface">
              {graphs.map((g) => (
                <label key={g.id} className={clsx("flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2", g.id === graphId && "bg-accent-tint/60")}>
                  <input type="radio" name="graph" value={g.id} checked={g.id === graphId} onChange={() => setGraphId(g.id)} className="accent-accent" />
                  <span className="font-medium">{g.name}</span>
                </label>
              ))}
            </div>
          </fieldset>
        ) : (
          <p className="text-sm text-muted">{t("mcpServer.consent.noGraphs")}</p>
        )}

        <fieldset>
          <legend className="text-lg font-semibold">{t("mcpServer.access.label")}</legend>
          <div className="mt-3 overflow-hidden rounded-lg bg-surface">
            {(["read", "propose"] as const).filter((s) => offered.includes(s)).map((s) => {
              const off = s === "propose" && !canPropose;
              return (
                <label key={s} className={clsx("flex items-start gap-3 px-4 py-3", off ? "cursor-not-allowed text-muted" : "cursor-pointer hover:bg-surface-2")}>
                  <input type="radio" name="access" value={s} disabled={off} checked={(off ? "read" : access) === s} onChange={() => setAccess(s)} className="mt-1 accent-accent" />
                  <span>
                    <span className="block font-medium">{t(`mcpServer.access.${s}`)}</span>
                    <span className="block text-sm text-muted">{off && graph && !graph.canPropose ? t("mcpServer.access.proposeUnavailable") : t(`mcpServer.access.${s}Hint`)}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <ErrorNote message={error} />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" name="decision" value="allow" disabled={busy || blocked}>{busy ? t("mcpServer.consent.working") : t("mcpServer.consent.allow")}</Button>
          <Button type="submit" name="decision" value="deny" variant="secondary" disabled={busy}>{t("mcpServer.consent.deny")}</Button>
        </div>
      </form>
    </div>
  );
}
