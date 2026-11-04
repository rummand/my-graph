"use client";
/**
 * "Also in": the same person (or thing) in my other graphs. Loads itself and renders nothing at all unless the viewer
 * has another graph, so people who are only in this graph never see a hint that a link exists.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUpRight, Link2, Search, Share2, Unlink } from "lucide-react";
import { Button, Field, Input, Select } from "@/components/ui";
import { GraphDot } from "@/components/graphs/bits";
import { useT } from "@/lib/i18n/client";
import type { AlsoIn, FieldOption, LinkedCopy } from "@/lib/links";

const EASE = [0.22, 1, 0.36, 1] as const;

type Candidate = { graphId: string; graphName: string; color: number; node: { id: string; label: string; type: string; kind: string | null; summary: string | null }; linkedElsewhere: boolean };

async function call<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

/** Work in another graph, then open a page there. */
async function openIn(graphId: string, href: string) {
  await call("/api/graphs/switch", { graphId });
  window.location.assign(href);
}

export function AlsoInSection({ nodeId, hrefBase = "/node/", className }: { nodeId: string; hrefBase?: string; className?: string }) {
  const t = useT();
  const [data, setData] = useState<AlsoIn | null>(null);
  const [open, setOpen] = useState<"share" | "connect" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setData((await call<{ alsoIn: AlsoIn | null }>(`/api/links?nodeId=${nodeId}`)).alsoIn); } catch { setData(null); }
  }, [nodeId]);
  useEffect(() => { void load(); }, [load]);

  if (!data) return null;
  const canShare = data.canWriteHere && data.shareTargets.length > 0;
  const canConnect = data.canWriteHere && data.connectGraphs.length > 0;
  if (!data.linked.length && !canShare && !canConnect) return null;

  const done = async (msg: string) => { setOpen(null); setError(null); setNotice(msg); await load(); };

  return (
    <section aria-labelledby="also-in-h" className={className}>
      <h2 id="also-in-h" className="mb-3 text-lg font-semibold tracking-[-0.01em]">{t("links.title")}</h2>

      {data.linked.length > 0 && (
        <ul className="mb-3 divide-y divide-line/70 rounded-lg bg-surface">
          {data.linked.map((l) => <LinkedRow key={l.memberId} l={l} nodeId={nodeId} hrefBase={hrefBase} onChanged={done} onError={setError} />)}
        </ul>
      )}
      {data.linked.length > 0 && <p className="-mt-1 mb-3 text-sm text-muted">{t("links.privacy")}</p>}

      {notice && <p role="status" className="mb-3 text-sm text-fg">{notice}</p>}
      {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}

      {(canShare || canConnect) && (
        <div className="flex flex-wrap gap-2">
          {canShare && (
            <Button variant={open === "share" ? "primary" : "secondary"} size="sm" aria-expanded={open === "share"} onClick={() => { setOpen(open === "share" ? null : "share"); setNotice(null); }}>
              <Share2 className="size-4" aria-hidden="true" />{t("links.share")}
            </Button>
          )}
          {canConnect && (
            <Button variant={open === "connect" ? "primary" : "secondary"} size="sm" aria-expanded={open === "connect"} onClick={() => { setOpen(open === "connect" ? null : "connect"); setNotice(null); }}>
              <Link2 className="size-4" aria-hidden="true" />{t("links.connect")}
            </Button>
          )}
        </div>
      )}

      <AnimatePresence initial={false}>
        {open && (
          <motion.div key={open} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22, ease: EASE }} className="overflow-hidden">
            <div className="mt-3 rounded-lg bg-surface p-4">
              {open === "share"
                ? <SharePanel data={data} onDone={done} onCancel={() => setOpen(null)} />
                : <ConnectPanel data={data} onDone={done} onCancel={() => setOpen(null)} />}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

function LinkedRow({ l, nodeId, hrefBase, onChanged, onError }: { l: LinkedCopy; nodeId: string; hrefBase: string; onChanged: (msg: string) => Promise<void>; onError: (e: string | null) => void }) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = l.status === "pending";

  async function unlink() {
    setBusy(true); onError(null);
    try { await call("/api/links/unlink", { nodeId, otherNodeId: l.nodeId }); await onChanged(""); } catch (e) { onError((e as Error).message); } finally { setBusy(false); setConfirming(false); }
  }

  return (
    <li className="px-4 py-3">
      <div className="flex items-start gap-3">
        <GraphDot hue={l.color} size={10} className="mt-1.5" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-medium">{l.graphName}</p>
          <p className="text-sm text-muted">{pending ? t("links.waiting", { graph: l.graphName }) : l.label}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {pending
            ? l.changeSetId && <Button variant="ghost" size="sm" onClick={() => openIn(l.graphId, `/changes/${l.changeSetId}`)}>{t("links.review")}</Button>
            : <Button variant="ghost" size="sm" aria-label={t("links.open", { graph: l.graphName })} title={t("links.open", { graph: l.graphName })}
              onClick={() => openIn(l.graphId, `${hrefBase}${l.nodeId}`)}><ArrowUpRight className="size-4" aria-hidden="true" /></Button>}
          {l.canUnlink && !confirming && (
            <Button variant="ghost" size="sm" onClick={() => setConfirming(true)} title={pending ? t("links.withdraw") : t("links.unlink")}>
              {/* Icon only: the panel sits in a narrow side column, where a label squeezes the graph's name. */}
              <Unlink className="size-4" aria-hidden="true" /><span className="sr-only">{pending ? t("links.withdraw") : t("links.unlink")}</span>
            </Button>
          )}
        </div>
      </div>
      {confirming && (
        <div className="mt-3 rounded-md bg-surface-2/70 p-3 text-sm">
          <p>{pending ? t("links.withdrawConfirm", { graph: l.graphName }) : t("links.unlinkConfirm", { graph: l.graphName })}</p>
          <div className="mt-2 flex gap-2">
            <Button variant="danger" size="sm" disabled={busy} onClick={unlink}>{pending ? t("links.withdraw") : t("links.unlink")}</Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>{t("links.cancel")}</Button>
          </div>
        </div>
      )}
    </li>
  );
}

function FieldPicker({ options, chosen, onChange }: { options: FieldOption[]; chosen: Set<string>; onChange: (s: Set<string>) => void }) {
  const t = useT();
  return (
    <fieldset>
      <legend className="mb-1.5 text-sm font-medium">{t("links.what")}</legend>
      <ul className="space-y-1.5">
        {options.map((o) => (
          <li key={o.key}>
            <label className="flex items-start gap-2.5 text-sm">
              <input type="checkbox" className="mt-0.5 size-4 accent-[var(--accent)]" checked={o.required || chosen.has(o.key)} disabled={o.required}
                onChange={(e) => { const s = new Set(chosen); if (e.target.checked) s.add(o.key); else s.delete(o.key); onChange(s); }} />
              <span className="min-w-0">
                <span className="font-medium">{o.label}</span>
                {o.required && <span className="text-muted"> · {t("links.fields.always")}</span>}
                {o.preview && <span className="block truncate text-muted">{o.preview}</span>}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

function SharePanel({ data, onDone, onCancel }: { data: AlsoIn; onDone: (msg: string) => Promise<void>; onCancel: () => void }) {
  const t = useT();
  const [graphId, setGraphId] = useState(data.shareTargets[0]?.id ?? "");
  const [chosen, setChosen] = useState(() => new Set(data.fields.filter((f) => f.defaultOn).map((f) => f.key)));
  const [visibility, setVisibility] = useState<"household" | "parents" | "private">("household");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = data.shareTargets.find((g) => g.id === graphId);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!target) return;
    setBusy(true); setError(null);
    try {
      const r = await call<{ status: "proposed" | "created"; graphName: string }>("/api/links/share", { nodeId: data.nodeId, graphId, fields: [...chosen], visibility });
      await onDone(r.status === "proposed" ? t("links.shareProposed", { graph: r.graphName }) : t("links.shareAdded", { graph: r.graphName }));
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <h3 className="text-[15px] font-semibold">{t("links.shareTitle", { name: data.nodeLabel })}</h3>
        <p className="mt-1 text-sm text-muted">{t("links.shareLead")}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("links.graph")}>
          <Select value={graphId} onChange={(e) => setGraphId(e.target.value)}>
            {data.shareTargets.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </Select>
        </Field>
        <Field label={t("links.whoSees")}>
          <Select value={visibility} onChange={(e) => setVisibility(e.target.value as typeof visibility)}>
            {(["household", "parents", "private"] as const).map((v) => <option key={v} value={v}>{t(`links.vis.${v}`)}</option>)}
          </Select>
        </Field>
      </div>
      <FieldPicker options={data.fields} chosen={chosen} onChange={setChosen} />
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || !target}>{target ? t("links.shareSubmit", { graph: target.name }) : t("links.noTargets")}</Button>
        <Button type="button" variant="ghost" onClick={onCancel}>{t("links.cancel")}</Button>
      </div>
    </form>
  );
}

function ConnectPanel({ data, onDone, onCancel }: { data: AlsoIn; onDone: (msg: string) => Promise<void>; onCancel: () => void }) {
  const t = useT();
  const [q, setQ] = useState(data.nodeLabel);
  const [graphId, setGraphId] = useState("");
  const [results, setResults] = useState<Candidate[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [chosen, setChosen] = useState(() => new Set(data.fields.filter((f) => f.defaultOn).map((f) => f.key)));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const allowed = useMemo(() => new Set(data.connectGraphs.map((g) => g.id)), [data.connectGraphs]);

  useEffect(() => {
    const n = ++seq.current;
    setLoading(true);
    const h = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ nodeId: data.nodeId, q });
        if (graphId) params.set("graphId", graphId);
        const r = await call<{ candidates: Candidate[] }>(`/api/links/candidates?${params}`);
        if (n === seq.current) setResults(r.candidates.filter((c) => allowed.has(c.graphId)));
      } catch (e) { if (n === seq.current) setError((e as Error).message); } finally { if (n === seq.current) setLoading(false); }
    }, 220);
    return () => clearTimeout(h);
  }, [q, graphId, data.nodeId, allowed]);

  async function connect(c: Candidate) {
    setBusy(c.node.id); setError(null);
    try {
      const r = await call<{ graphName: string }>("/api/links/connect", { nodeId: data.nodeId, otherGraphId: c.graphId, otherNodeId: c.node.id, fields: [...chosen] });
      await onDone(t("links.connected", { graph: r.graphName }));
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-[15px] font-semibold">{t("links.connectTitle", { name: data.nodeLabel })}</h3>
        <p className="mt-1 text-sm text-muted">{t("links.connectLead")}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_180px]">
        <label className="relative block">
          <span className="sr-only">{t("links.search")}</span>
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted" aria-hidden="true" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("links.search")} className="pl-8" role="combobox" aria-expanded={!!results?.length} aria-controls="link-candidates" />
        </label>
        {data.connectGraphs.length > 1 && (
          <Select value={graphId} onChange={(e) => setGraphId(e.target.value)} aria-label={t("links.graph")}>
            <option value="">{t("links.allGraphs")}</option>
            {data.connectGraphs.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </Select>
        )}
      </div>
      <ul id="link-candidates" role="listbox" className="max-h-72 divide-y divide-line/70 overflow-y-auto rounded-md bg-bg/60" aria-busy={loading}>
        {results === null || (loading && !results.length)
          ? <li className="px-3 py-3 text-sm text-muted">{t("links.searching")}</li>
          : results.length === 0
            ? <li className="px-3 py-3 text-sm text-muted">{t("links.noMatches", { q })}</li>
            : results.map((c) => (
              <li key={`${c.graphId}:${c.node.id}`} role="option" aria-selected={false} className="flex items-center gap-3 px-3 py-2.5">
                <GraphDot hue={c.color} size={9} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-medium">{c.node.label}</p>
                  <p className="truncate text-sm text-muted">{c.graphName}{c.linkedElsewhere ? ` · ${t("links.linkedElsewhere")}` : ""}</p>
                </div>
                <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => connect(c)}>{t("links.connectSubmit")}</Button>
              </li>
            ))}
      </ul>
      <FieldPicker options={data.fields} chosen={chosen} onChange={setChosen} />
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <Button type="button" variant="ghost" onClick={onCancel}>{t("links.cancel")}</Button>
    </div>
  );
}
