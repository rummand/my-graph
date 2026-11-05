"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Input, Select } from "@/components/ui";
import { useFormatDate, useT } from "@/lib/i18n/client";
import { api, errorFields, errorMessage } from "@/lib/auth/client/api";
import { describedBy, Field } from "@/lib/auth/client/field";
import { ErrorNote, Notice } from "@/app/login/notes";
import { PanelFooter } from "./section";

type Person = { id: string; name: string };
export type DeleteProps = {
  email: string;
  scheduledFor: string | null;
  cancelled: "signed_in" | "blocked" | null;
  blockers: (
    | { code: "platform_admin" } | { code: "child" } | { code: "household_owner"; others: number }
    | { code: "shared_graph_owner"; graphs: { id: string; name: string }[] }
  )[];
  heirs: Person[];
  graphHeirs: { graphId: string; graphName: string; members: Person[] }[];
};

/** Hand something over to one of a list of people. */
function HandOver({ kind, graphId, people, label }: { kind: "household" | "graph"; graphId?: string; people: Person[]; label: string }) {
  const t = useT();
  const router = useRouter();
  const [to, setTo] = useState(people[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const id = `handover-${graphId ?? "household"}`;
  async function go() {
    setBusy(true); setError(null);
    try {
      await api("/api/account/transfer", { json: kind === "household" ? { kind, to } : { kind, graphId, to } });
      setDone(true);
      router.refresh();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <div className="mt-3">
      <p className="text-sm">{label}</p>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <div className="min-w-[12rem]">
          <label htmlFor={id} className="mb-1 block text-sm font-medium">{t("settings.data.handTo")}</label>
          <Select id={id} value={to} onChange={(e) => setTo(e.target.value)}>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </div>
        <Button type="button" variant="secondary" disabled={busy || !to} onClick={() => void go()}>
          {busy ? t("settings.data.handingOver") : t("settings.data.handOver")}
        </Button>
      </div>
      <ErrorNote message={error} className="mt-2" />
      <Notice message={done ? t("settings.data.handedOver") : null} className="mt-2" />
    </div>
  );
}

/** Settings > Your data > Delete your account. */
export function DeleteAccount(p: DeleteProps) {
  const t = useT();
  const fmt = useFormatDate();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setFieldError(undefined);
    try {
      await api("/api/account/deletion", { json: { confirm: typed } });
      // Every session has ended; signing in again is how to change one's mind.
      window.location.assign("/login");
    } catch (err) {
      setFieldError(errorFields(err).confirm);
      setError(errorFields(err).confirm ? null : errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div>
      {p.cancelled === "signed_in" && <Notice message={t("settings.data.cancelledSignedIn")} className="mb-4" />}
      {p.cancelled === "blocked" && <p className="mb-4 text-sm text-warn">{t("settings.data.cancelledBlocked")}</p>}
      {p.scheduledFor && (
        <p className="mb-4 text-sm">
          {t("settings.data.scheduled", { date: fmt(p.scheduledFor, "dateLong") })} <span className="text-muted">{t("settings.data.scheduledHint")}</span>
        </p>
      )}

      {p.blockers.length > 0 ? (
        <div>
          <p className="font-medium">{t("settings.data.blockedTitle")}</p>
          {p.blockers.map((b) => {
            if (b.code === "platform_admin") return <p key={b.code} className="mt-2 text-sm text-muted">{t("settings.data.blockPlatformAdmin")}</p>;
            if (b.code === "child") return <p key={b.code} className="mt-2 text-sm text-muted">{t("settings.data.blockChild")}</p>;
            if (b.code === "household_owner") {
              return p.heirs.length
                ? <HandOver key={b.code} kind="household" people={p.heirs} label={t("settings.data.blockHouseholdOwner", { count: b.others })} />
                : <p key={b.code} className="mt-2 text-sm text-muted">{t("settings.data.blockHouseholdOwnerNoHeir")}</p>;
            }
            return b.graphs.map((g) => {
              const heirs = p.graphHeirs.find((h) => h.graphId === g.id)?.members ?? [];
              return heirs.length
                ? <HandOver key={g.id} kind="graph" graphId={g.id} people={heirs} label={t("settings.data.blockSharedGraph", { name: g.name })} />
                : <p key={g.id} className="mt-2 text-sm text-muted">{t("settings.data.blockSharedGraphNoHeir", { name: g.name })}</p>;
            });
          })}
        </div>
      ) : (
        <div>
          <p className="font-medium">{t("settings.data.deleteWhat")}</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
            <li>{t("settings.data.deleteWhatPrivate")}</li>
            <li>{t("settings.data.deleteWhatGraphs")}</li>
            <li>{t("settings.data.deleteWhatShared")}</li>
            <li>{t("settings.data.deleteWhatAccount")}</li>
            <li>{t("settings.data.deleteWhatGrace")}</li>
          </ul>
          <p className="mt-3 text-sm text-muted">{t("settings.data.deleteExportFirst")}</p>
          {!open ? (
            <PanelFooter>
              <Button type="button" variant="danger" onClick={() => setOpen(true)}>{t("settings.data.deleteStart")}</Button>
            </PanelFooter>
          ) : (
            <form onSubmit={submit} noValidate className="mt-5">
              <Field id="delete-confirm" label={t("settings.data.confirmLabel")} hint={t("settings.data.confirmHint", { email: p.email })} error={fieldError}>
                <Input id="delete-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false}
                  aria-invalid={!!fieldError || undefined} aria-describedby={describedBy("delete-confirm", fieldError, true)} className="max-w-sm" />
              </Field>
              <ErrorNote message={error} className="mt-3" />
              <PanelFooter>
                <Button type="button" variant="ghost" onClick={() => { setOpen(false); setTyped(""); setError(null); setFieldError(undefined); }}>{t("settings.data.confirmCancel")}</Button>
                <Button type="submit" variant="danger" disabled={busy || !typed.trim()}>{busy ? t("settings.data.deleting") : t("settings.data.confirmButton")}</Button>
              </PanelFooter>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
