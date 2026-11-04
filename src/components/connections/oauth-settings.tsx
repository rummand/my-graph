"use client";
/**
 * Settings of a Google, Microsoft or Dropbox connection: who signed in (and "Sign in again"), what it reads (Gmail
 * labels, Google calendars, Drive files picked in Google's picker, Outlook mail folders, OneDrive and Dropbox folders),
 * who may see what it brings in, and how often it checks. Choices are listed with the connection's own sign-in.
 */
import { useCallback, useEffect, useState } from "react";
import { ChevronRight, File, Folder, X } from "lucide-react";
import { Button, Field, Input, Select } from "@/components/ui";
import { useT } from "@/lib/i18n/client";
import type { ConnectionDTO } from "@/lib/connectors";
import { api, type Person } from "./bits";
import { openDrivePicker } from "./google-picker";
import { startSignIn, useProviders } from "./oauth-connect";

type Option = { id: string; name: string; path?: string; hasChildren?: boolean; hint?: string };
type Ref = { id: string; name: string; path?: string };
type Picked = { id: string; name: string; mimeType: string };
const FOLDER_MIME = "application/vnd.google-apps.folder";

const EVERY: { value: number; key: string }[] = [
  { value: 15, key: "m15" }, { value: 30, key: "m30" }, { value: 60, key: "h1" }, { value: 180, key: "h3" }, { value: 720, key: "h12" }, { value: 1440, key: "d1" },
];

function useOptions(id: string, what: string, parent: string | null, enabled = true) {
  const [options, setOptions] = useState<Option[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setOptions(null); setError(null);
    const q = new URLSearchParams({ what, ...(parent ? { parent } : {}) });
    api<{ options: Option[] }>(`/api/connections/oauth/${id}/options?${q}`)
      .then((r) => { if (live) setOptions(r.options); }, (e) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [id, what, parent, enabled]);
  return { options, error };
}

/** A list of checkboxes (labels, calendars, mail folders). */
function Checklist({ id, what, value, onChange, keyOf = (o) => o.id }: { id: string; what: string; value: string[]; onChange: (v: string[]) => void; keyOf?: (o: Option) => string }) {
  const t = useT();
  const { options, error } = useOptions(id, what, null);
  if (error) return <p className="text-sm text-danger">{t("providers.settings.loadFailed", { reason: error })}</p>;
  if (!options) return <p className="text-sm text-muted">{t("providers.settings.loading")}</p>;
  const known = new Set(options.map(keyOf));
  const extra = value.filter((v) => !known.has(v));
  return (
    <ul className="grid gap-1.5 sm:grid-cols-2">
      {[...options.map((o) => ({ key: keyOf(o), name: o.name })), ...extra.map((v) => ({ key: v, name: v }))].map((o) => (
        <li key={o.key}>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={value.includes(o.key)} onChange={(e) => onChange(e.target.checked ? [...value, o.key] : value.filter((x) => x !== o.key))} />
            {o.name}
          </label>
        </li>
      ))}
    </ul>
  );
}

/** Browse folders one level at a time and choose some (OneDrive, Dropbox, Outlook mail folders). */
function FolderPicker({ id, what, value, onChange, keyOf }: { id: string; what: string; value: Ref[]; onChange: (v: Ref[]) => void; keyOf: (r: Ref) => string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [trail, setTrail] = useState<Option[]>([]);
  const here = trail.at(-1) ?? null;
  const parent = here ? (what === "dropboxFolders" ? here.path ?? null : here.id) : null;
  const { options, error } = useOptions(id, what, parent, open);
  const chosen = new Set(value.map(keyOf));
  const toRef = (o: Option): Ref => ({ id: o.id, name: o.name, ...(o.path ? { path: o.path } : {}) });
  const has = (o: Option) => chosen.has(keyOf(toRef(o)));
  return (
    <div className="space-y-2">
      {value.length === 0 ? <p className="text-sm text-muted">{t("providers.settings.folderNone")}</p> : (
        <ul className="flex flex-wrap gap-1.5">
          {value.map((r) => (
            <li key={keyOf(r)} className="flex items-center gap-1 rounded-full bg-surface-2 py-1 pl-3 pr-1 text-sm">
              <Folder className="size-3.5 text-muted" aria-hidden />{r.path ?? r.name}
              <button type="button" className="rounded-full p-0.5 text-muted hover:bg-surface hover:text-fg" aria-label={`${t("providers.settings.remove")} ${r.name}`}
                onClick={() => onChange(value.filter((x) => keyOf(x) !== keyOf(r)))}><X className="size-3.5" aria-hidden /></button>
            </li>
          ))}
        </ul>
      )}
      {!open ? <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(true)}>{t("providers.settings.browse")}</Button> : (
        <div className="rounded-lg bg-surface-2 p-3">
          <nav className="mb-2 flex flex-wrap items-center gap-1 text-sm">
            <button type="button" className="text-accent hover:underline" onClick={() => setTrail([])}>{t("providers.settings.root")}</button>
            {trail.map((o, i) => (
              <span key={o.id} className="flex items-center gap-1">
                <ChevronRight className="size-3.5 text-muted" aria-hidden />
                <button type="button" className="text-accent hover:underline" onClick={() => setTrail(trail.slice(0, i + 1))}>{o.name}</button>
              </span>
            ))}
          </nav>
          {error ? <p className="text-sm text-danger">{t("providers.settings.loadFailed", { reason: error })}</p>
            : !options ? <p className="text-sm text-muted">{t("providers.settings.loading")}</p>
            : options.length === 0 ? <p className="text-sm text-muted">{t("providers.settings.noFolders")}</p> : (
              <ul className="divide-y divide-line">
                {options.map((o) => (
                  <li key={o.id} className="flex items-center justify-between gap-2 py-1.5">
                    <span className="flex min-w-0 items-center gap-2 text-sm"><Folder className="size-4 shrink-0 text-muted" aria-hidden /><span className="truncate">{o.name}</span></span>
                    <span className="flex shrink-0 gap-1">
                      {o.hasChildren && <Button type="button" size="sm" variant="ghost" onClick={() => setTrail([...trail, o])}>{t("providers.settings.open")}</Button>}
                      <Button type="button" size="sm" variant={has(o) ? "ghost" : "secondary"} disabled={has(o)}
                        onClick={() => onChange([...value, toRef(o)])}>{has(o) ? t("providers.settings.chosen") : t("providers.settings.choose")}</Button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          {here && (
            <div className="mt-2 flex gap-2">
              <Button type="button" size="sm" variant="secondary" disabled={has(here)} onClick={() => onChange([...value, toRef(here)])}>
                {has(here) ? t("providers.settings.chosen") : `${t("providers.settings.choose")}: ${here.name}`}
              </Button>
            </div>
          )}
          <Button type="button" size="sm" variant="ghost" className="mt-2" onClick={() => setOpen(false)}>{t("providers.settings.browseDone")}</Button>
        </div>
      )}
    </div>
  );
}

function DrivePicks({ c, value, onChange }: { c: ConnectionDTO; value: Picked[]; onChange: (v: Picked[]) => void }) {
  const t = useT();
  const { info } = useProviders();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pick = async () => {
    setBusy(true); setError(null);
    try {
      const got = await openDrivePicker(c.id);
      const known = new Set(value.map((p) => p.id));
      if (got.length) onChange([...value, ...got.filter((g) => !known.has(g.id))]);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("providers.settings.pickerFailed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      {value.length === 0 ? <p className="max-w-[65ch] text-sm text-muted">{t("providers.settings.pickedNone")}</p> : (
        <ul className="divide-y divide-line rounded-lg bg-surface-2">
          {value.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
              <span className="flex min-w-0 items-center gap-2">
                {p.mimeType === FOLDER_MIME ? <Folder className="size-4 shrink-0 text-muted" aria-label={t("providers.settings.folder")} /> : <File className="size-4 shrink-0 text-muted" aria-label={t("providers.settings.file")} />}
                <span className="truncate">{p.name}</span>
              </span>
              <Button type="button" size="sm" variant="ghost" onClick={() => onChange(value.filter((x) => x.id !== p.id))}>{t("providers.settings.remove")}</Button>
            </li>
          ))}
        </ul>
      )}
      {info && !info.picker ? <p className="max-w-[65ch] text-sm text-warn">{t("providers.settings.pickerNotSetUp")}</p>
        : <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={pick}>{value.length ? t("providers.settings.pickMore") : t("providers.settings.pick")}</Button>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  );
}

export function OAuthSettings({ c, people, family, onDone }: { c: ConnectionDTO; people: Person[]; family: boolean; onDone: (c: ConnectionDTO) => void }) {
  const t = useT();
  const cfg = c.config as Record<string, unknown>;
  const arr = <T,>(k: string, d: T[]): T[] => (Array.isArray(cfg[k]) ? (cfg[k] as T[]) : d);
  const [labels, setLabels] = useState<string[]>(() => arr("labels", ["INBOX"]));
  const [calendars, setCalendars] = useState<string[]>(() => arr("calendars", ["primary"]));
  const [picked, setPicked] = useState<Picked[]>(() => arr("picked", []));
  const [mail, setMail] = useState(cfg.mail !== false);
  const [calendar, setCalendar] = useState(cfg.calendar !== false);
  const [mailFolders, setMailFolders] = useState<Ref[]>(() => arr("mailFolders", [{ id: "inbox", name: "Inbox" }]));
  const [driveFolders, setDriveFolders] = useState<Ref[]>(() => arr("driveFolders", []));
  const [folders, setFolders] = useState<Ref[]>(() => arr("folders", []));
  const [since, setSince] = useState(typeof cfg.since === "string" ? cfg.since : "");
  const [person, setPerson] = useState(typeof cfg.personNodeId === "string" ? cfg.personNodeId : "");
  const [visibility, setVisibility] = useState(typeof cfg.visibility === "string" ? cfg.visibility : "private");
  const [every, setEvery] = useState(c.everyMinutes);
  const [label, setLabel] = useState(c.label);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const touch = useCallback(<T,>(set: (v: T) => void) => (v: T) => { set(v); setDirty(true); setSaved(false); }, []);
  const signedIn = c.secretsSaved.includes("oauth") && !(c.status === "needs_you" && ["signIn", "signInAgain", "scopeMissing"].includes(c.detailCode ?? ""));
  const visKey = family ? "visibility" : "visibilityOther";

  async function save() {
    setBusy(true); setError(null);
    const config: Record<string, unknown> = { visibility };
    if (c.connector === "gmail") Object.assign(config, { labels, ...(since ? { since } : {}) });
    if (c.connector === "google_calendar") Object.assign(config, { calendars: calendars.length ? calendars : ["primary"], personNodeId: person || null });
    if (c.connector === "google_drive") Object.assign(config, { picked });
    if (c.connector === "microsoft") Object.assign(config, { mail, calendar, mailFolders, driveFolders, personNodeId: person || null, ...(since ? { since } : {}) });
    if (c.connector === "dropbox") Object.assign(config, { folders });
    try {
      const r = await api<{ connection: ConnectionDTO }>(`/api/connections/${c.id}`, { method: "PATCH", json: { config, everyMinutes: every, label: label.trim() || undefined } });
      setSaved(true); setDirty(false);
      onDone(r.connection);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("connections.errors.generic"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm">
          {typeof cfg.account === "string" ? t("providers.signedInAs", { account: cfg.account }) : null}
        </p>
        <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={async () => {
          setBusy(true);
          try { await startSignIn({ connectionId: c.id }); } catch (e) { setError(e instanceof Error ? e.message : t("connections.errors.generic")); setBusy(false); }
        }}>{t("providers.signInAgain")}</Button>
      </div>

      {!signedIn ? <p className="text-sm text-muted">{t("providers.settings.signInToChange")}</p> : (
        <div className="space-y-5">
          {c.connector === "gmail" && (
            <Field label={t("providers.settings.labels")} hint={t("providers.settings.labelsHint")}>
              <Checklist id={c.id} what="labels" value={labels} onChange={touch(setLabels)} />
            </Field>
          )}
          {c.connector === "google_calendar" && (
            <Field label={t("providers.settings.calendars")}>
              <Checklist id={c.id} what="calendars" value={calendars} onChange={touch(setCalendars)} />
            </Field>
          )}
          {c.connector === "google_drive" && (
            <Field label={t("providers.settings.pickedTitle")}>
              <DrivePicks c={c} value={picked} onChange={touch(setPicked)} />
            </Field>
          )}
          {c.connector === "microsoft" && (
            <>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={mail} onChange={(e) => touch(setMail)(e.target.checked)} />{t("providers.settings.mailOn")}</label>
              {mail && (
                <Field label={t("providers.settings.mailFolders")}>
                  <FolderPicker id={c.id} what="mailFolders" value={mailFolders} onChange={touch(setMailFolders)} keyOf={(r) => r.id} />
                </Field>
              )}
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={calendar} onChange={(e) => touch(setCalendar)(e.target.checked)} />{t("providers.settings.calendarOn")}</label>
              <Field label={t("providers.settings.driveFolders")}>
                <FolderPicker id={c.id} what="driveFolders" value={driveFolders} onChange={touch(setDriveFolders)} keyOf={(r) => r.id} />
              </Field>
            </>
          )}
          {c.connector === "dropbox" && (
            <Field label={t("providers.settings.dropboxFolders")}>
              <FolderPicker id={c.id} what="dropboxFolders" value={folders} onChange={touch(setFolders)} keyOf={(r) => r.path ?? r.id} />
            </Field>
          )}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {(c.connector === "gmail" || (c.connector === "microsoft" && mail)) && (
          <Field label={t("connections.fields.since.label")} hint={t("connections.fields.since.hint")}>
            <Input type="date" value={since} onChange={(e) => touch(setSince)(e.target.value)} disabled={busy} />
          </Field>
        )}
        {(c.connector === "google_calendar" || (c.connector === "microsoft" && calendar)) && (
          <Field label={t("connections.fields.personNodeId.label")} hint={t("connections.fields.personNodeId.hint")}>
            <Select value={person} onChange={(e) => touch(setPerson)(e.target.value)} disabled={busy}>
              <option value="">{t("connections.fields.personNodeId.none")}</option>
              {people.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
            </Select>
          </Field>
        )}
        <Field label={t("connections.fields.visibility.label")}>
          <Select value={visibility} onChange={(e) => touch(setVisibility)(e.target.value)} disabled={busy}>
            {(["private", "parents", "household"] as const).map((v) => <option key={v} value={v}>{t(`connections.${visKey}.${v}`)}</option>)}
          </Select>
        </Field>
        <Field label={t("connections.fields.everyMinutes.label")}>
          <Select value={String(every)} onChange={(e) => touch(setEvery)(Number(e.target.value))} disabled={busy}>
            {EVERY.map((o) => <option key={o.value} value={o.value}>{t(`connections.every.${o.key}`)}</option>)}
          </Select>
        </Field>
        <Field label={t("connections.fields.label.label")} hint={t("connections.fields.label.hint")}>
          <Input value={label} onChange={(e) => touch(setLabel)(e.target.value)} maxLength={120} disabled={busy} />
        </Field>
      </div>
      {error && <p role="alert" className="rounded-md bg-danger-tint px-3 py-2 text-sm text-danger">{error}</p>}
      <div className="flex items-center gap-2">
        <Button type="button" onClick={save} disabled={busy || !dirty}>{busy ? t("connections.actions.saving") : t("connections.actions.save")}</Button>
        {saved && <span role="status" className="text-sm text-muted">{t("connections.actions.saved")}</span>}
      </div>
    </div>
  );
}
