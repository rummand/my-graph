"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { clsx } from "clsx";
import { ArrowDown, ArrowUp, ImageIcon, Plus, Quote, Sparkles, Table, Trash2, Type, Users, X, Heading, ListChecks, CalendarRange } from "lucide-react";
import { Button, IconButton, Input, Textarea } from "@/components/ui";
import { fetchMentionables } from "@/components/mention";
import {
  BLOCK_TYPES, CITE_RE, citationNumbers, emptyBlock, newId, uncitedClaims,
  type ArtifactContent, type Block, type BlockType, type Citation, type Section,
} from "@/lib/artifacts/content";
import { useT } from "@/lib/i18n/client";

const BLOCK_ICON: Record<BlockType, typeof Type> = {
  heading: Heading, text: Type, facts: ListChecks, timeline: CalendarRange, people: Users, table: Table, quote: Quote, image: ImageIcon,
};

type Nums = Map<string, number>;

/** `[^c3]` → `[2]` for editing (numbers as the reader sees them). */
function toDisplay(text: string, nums: Nums): string {
  return text.replace(CITE_RE, (m, id: string) => (nums.get(id) ? `[${nums.get(id)}]` : m));
}
/** `[2]` → `[^c3]` using the numbering from before the edit. */
function fromDisplay(text: string, byNum: Map<number, string>): string {
  return text.replace(/\[(\d{1,3})\]/g, (m, n: string) => (byNum.get(Number(n)) ? `[^${byNum.get(Number(n))}]` : m));
}

type Ctx = {
  nums: Nums;
  byNum: Map<number, string>;
  citations: Citation[];
  uncited: Set<string>;
  addCitation: (c: Omit<Citation, "id">) => string;
};

/** The source numbers on an item, each removable, plus "Add source". */
function Cites({ ids, ctx, onChange }: { ids: string[]; ctx: Ctx; onChange: (ids: string[]) => void }) {
  const t = useT();
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {ids.map((id) => {
        const n = ctx.nums.get(id);
        const c = ctx.citations.find((x) => x.id === id);
        return (
          <span key={id} title={c?.label} className="inline-flex items-center gap-0.5 rounded-[4px] bg-accent-tint py-px pl-1.5 pr-0.5 text-xs font-medium tabular-nums text-accent">
            {n ?? "·"}<span className="max-w-[14ch] truncate font-normal">{c?.label}</span>
            <button type="button" aria-label={t("artifacts.cites.remove", { n: n ?? "" })} className="rounded p-0.5 hover:bg-accent hover:text-accent-fg" onClick={() => onChange(ids.filter((x) => x !== id))}><X className="size-3" /></button>
          </span>
        );
      })}
      <CitePicker ctx={ctx} exclude={ids} onPick={(id) => onChange([...ids, id])} />
    </span>
  );
}

/** Pick one of the document's sources, or cite something else in the graph. */
function CitePicker({ ctx, exclude = [], onPick }: { ctx: Ctx; exclude?: string[]; onPick: (id: string) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<{ nodeId: string; label: string; type: string }[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  useEffect(() => {
    if (!open || q.trim().length < 2) { setFound([]); return; }
    const h = setTimeout(() => {
      void fetchMentionables(q.trim(), 6).then((items) => setFound(items.map((m) => ({ nodeId: m.nodeId, label: m.label, type: m.type }))));
    }, 180);
    return () => clearTimeout(h);
  }, [q, open]);
  const list = ctx.citations.filter((c) => !exclude.includes(c.id));
  return (
    <div ref={ref} className="relative inline-block">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="inline-flex items-center gap-0.5 rounded-[4px] px-1 py-px text-xs text-muted hover:bg-surface-2 hover:text-fg">
        <Plus className="size-3" aria-hidden />{t("artifacts.cites.add")}
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-72 rounded-lg bg-surface p-1.5 shadow-float">
          <div className="max-h-56 overflow-auto">
            {list.length === 0 && <p className="px-2 py-1.5 text-sm text-muted">{t("artifacts.cites.none")}</p>}
            {list.map((c) => (
              <button key={c.id} type="button" className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-2"
                onClick={() => { onPick(c.id); setOpen(false); }}>
                <span className="mt-px rounded-[4px] bg-accent-tint px-1 text-xs font-medium tabular-nums text-accent">{ctx.nums.get(c.id) ?? "+"}</span>
                <span className="min-w-0"><span className="block truncate">{c.label}</span>{c.quote && <span className="block truncate text-xs text-muted">{c.quote}</span>}</span>
              </button>
            ))}
          </div>
          <div className="mt-1 border-t border-line pt-1.5">
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("artifacts.cites.pick")} className="h-8 text-sm" autoFocus />
            {found.map((f) => (
              <button key={f.nodeId} type="button" className="mt-0.5 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-2"
                onClick={() => { onPick(ctx.addCitation({ kind: "node", nodeId: f.nodeId, label: f.label, quote: null, locator: null })); setOpen(false); setQ(""); }}>
                <Plus className="size-3.5 text-muted" aria-hidden /><span className="truncate">{f.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ItemShell({ flagged, children, onRemove }: { flagged: boolean; children: React.ReactNode; onRemove: () => void }) {
  const t = useT();
  return (
    <div className={clsx("group/item relative grid gap-1.5 rounded-md p-2", flagged ? "bg-warn-tint/70" : "bg-surface-2/50")}>
      {children}
      <button type="button" aria-label={t("artifacts.editor.removeItem")} onClick={onRemove}
        className="absolute right-1 top-1 rounded p-1 text-muted opacity-60 hover:bg-surface hover:text-danger group-hover/item:opacity-100"><X className="size-3.5" /></button>
      {flagged && <span className="text-xs text-warn">{t("artifacts.cites.needsSource")}</span>}
    </div>
  );
}

const sm = "h-8 text-sm";

function ImagePicker({ onPick }: { onPick: (id: string, title: string) => void }) {
  const t = useT();
  const [items, setItems] = useState<{ id: string; title: string }[] | null>(null);
  useEffect(() => {
    void fetch("/api/library?type=image&limit=40").then((r) => (r.ok ? r.json() : { items: [] })).then((b) => setItems((b.items ?? []).map((i: { id: string; title: string }) => ({ id: i.id, title: i.title })))).catch(() => setItems([]));
  }, []);
  if (!items) return <p className="text-sm text-muted">…</p>;
  if (!items.length) return <p className="text-sm text-muted">{t("artifacts.blocks.noImages")}</p>;
  return (
    <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-5">
      {items.map((i) => (
        <button key={i.id} type="button" title={i.title} onClick={() => onPick(i.id, i.title)} className="aspect-square overflow-hidden rounded-md bg-surface-2 ring-accent hover:ring-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/api/files/${i.id}`} alt={i.title} className="size-full object-cover" loading="lazy" />
        </button>
      ))}
    </div>
  );
}

const ZERO = "00000000-0000-0000-0000-000000000000";

function BlockEditor({ b, ctx, sectionId, onChange }: { b: Block; ctx: Ctx; sectionId: string; onChange: (b: Block) => void }) {
  const t = useT();
  const flag = (item?: number) => ctx.uncited.has(`${sectionId}/${b.id}/${item ?? ""}`);
  switch (b.type) {
    case "heading":
      return <Input value={b.text} onChange={(e) => onChange({ ...b, text: e.target.value })} placeholder={t("artifacts.blocks.heading")} className="font-semibold" />;
    case "text":
      return (
        <div className={clsx("grid gap-1 rounded-md", flag() && "ring-2 ring-warn/50 ring-offset-2 ring-offset-bg")}>
          <Textarea value={toDisplay(b.text, ctx.nums)} rows={Math.min(14, Math.max(3, Math.ceil(b.text.length / 70)))}
            onChange={(e) => onChange({ ...b, text: fromDisplay(e.target.value, ctx.byNum) })} placeholder={t("artifacts.blocks.textPlaceholder")} />
          <div className="flex items-center gap-2">
            <CitePicker ctx={ctx} onPick={(id) => onChange({ ...b, text: `${b.text.trimEnd()} [^${id}]` })} />
            {flag() && <span className="text-xs text-warn">{t("artifacts.cites.needsSource")}</span>}
          </div>
        </div>
      );
    case "facts":
      return (
        <div className="grid gap-1.5">
          {b.items.map((it, i) => (
            <ItemShell key={i} flagged={flag(i)} onRemove={() => onChange({ ...b, items: b.items.filter((_, k) => k !== i) })}>
              <div className="grid gap-1.5 pr-6 sm:grid-cols-[10rem_1fr]">
                <Input className={sm} value={it.label} placeholder={t("artifacts.blocks.label")} onChange={(e) => onChange({ ...b, items: b.items.map((x, k) => (k === i ? { ...x, label: e.target.value } : x)) })} />
                <Input className={sm} value={it.value} placeholder={t("artifacts.blocks.value")} onChange={(e) => onChange({ ...b, items: b.items.map((x, k) => (k === i ? { ...x, value: e.target.value } : x)) })} />
              </div>
              <Cites ids={it.cites} ctx={ctx} onChange={(ids) => onChange({ ...b, items: b.items.map((x, k) => (k === i ? { ...x, cites: ids } : x)) })} />
            </ItemShell>
          ))}
          <AddLine onClick={() => onChange({ ...b, items: [...b.items, { label: "", value: "", cites: [] }] })} />
        </div>
      );
    case "timeline":
      return (
        <div className="grid gap-1.5">
          {b.items.map((it, i) => (
            <ItemShell key={i} flagged={flag(i)} onRemove={() => onChange({ ...b, items: b.items.filter((_, k) => k !== i) })}>
              <div className="grid gap-1.5 pr-6 sm:grid-cols-[11rem_1fr]">
                <Input className={clsx(sm, "tabular-nums")} value={it.when} placeholder={t("artifacts.blocks.when")} onChange={(e) => onChange({ ...b, items: b.items.map((x, k) => (k === i ? { ...x, when: e.target.value } : x)) })} />
                <Input className={sm} value={it.label} placeholder={t("artifacts.blocks.what")} onChange={(e) => onChange({ ...b, items: b.items.map((x, k) => (k === i ? { ...x, label: e.target.value } : x)) })} />
              </div>
              <Input className={sm} value={it.detail} placeholder={t("artifacts.blocks.detail")} onChange={(e) => onChange({ ...b, items: b.items.map((x, k) => (k === i ? { ...x, detail: e.target.value } : x)) })} />
              <Cites ids={it.cites} ctx={ctx} onChange={(ids) => onChange({ ...b, items: b.items.map((x, k) => (k === i ? { ...x, cites: ids } : x)) })} />
            </ItemShell>
          ))}
          <AddLine onClick={() => onChange({ ...b, items: [...b.items, { when: "", label: "", detail: "", cites: [] }] })} />
        </div>
      );
    case "people":
      return (
        <div className="grid gap-1.5">
          {b.items.map((it, i) => (
            <ItemShell key={i} flagged={flag(i)} onRemove={() => onChange({ ...b, items: b.items.filter((_, k) => k !== i) })}>
              <div className="grid gap-1.5 pr-6 sm:grid-cols-[12rem_1fr]">
                <Input className={sm} value={it.name} placeholder={t("artifacts.blocks.name")} onChange={(e) => onChange({ ...b, items: b.items.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)) })} />
                <Input className={sm} value={it.role} placeholder={t("artifacts.blocks.role")} onChange={(e) => onChange({ ...b, items: b.items.map((x, k) => (k === i ? { ...x, role: e.target.value } : x)) })} />
              </div>
              <Cites ids={it.cites} ctx={ctx} onChange={(ids) => onChange({ ...b, items: b.items.map((x, k) => (k === i ? { ...x, cites: ids } : x)) })} />
            </ItemShell>
          ))}
          <AddLine onClick={() => onChange({ ...b, items: [...b.items, { nodeId: null, name: "", role: "", cites: [] }] })} />
        </div>
      );
    case "table": {
      const cols = Math.max(1, b.columns.length);
      return (
        <div className="grid gap-1.5 overflow-x-auto">
          <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${cols}, minmax(6rem, 1fr))` }}>
            {b.columns.map((c, ci) => (
              <Input key={ci} className={clsx(sm, "font-medium")} value={c} placeholder={`${t("artifacts.blocks.column")} ${ci + 1}`}
                onChange={(e) => onChange({ ...b, columns: b.columns.map((x, k) => (k === ci ? e.target.value : x)) })} />
            ))}
          </div>
          {b.rows.map((r, ri) => (
            <ItemShell key={ri} flagged={flag(ri)} onRemove={() => onChange({ ...b, rows: b.rows.filter((_, k) => k !== ri) })}>
              <div className="grid gap-1.5 pr-6" style={{ gridTemplateColumns: `repeat(${cols}, minmax(6rem, 1fr))` }}>
                {Array.from({ length: cols }, (_, ci) => (
                  <Input key={ci} className={sm} value={r.cells[ci] ?? ""} onChange={(e) => {
                    const cells = Array.from({ length: cols }, (_, k) => (k === ci ? e.target.value : r.cells[k] ?? ""));
                    onChange({ ...b, rows: b.rows.map((x, k) => (k === ri ? { ...x, cells } : x)) });
                  }} />
                ))}
              </div>
              <Cites ids={r.cites} ctx={ctx} onChange={(ids) => onChange({ ...b, rows: b.rows.map((x, k) => (k === ri ? { ...x, cites: ids } : x)) })} />
            </ItemShell>
          ))}
          <div className="flex gap-2">
            <AddLine label={t("artifacts.editor.addRow")} onClick={() => onChange({ ...b, rows: [...b.rows, { cells: Array(cols).fill(""), cites: [] }] })} />
            {cols < 8 && <AddLine label={t("artifacts.editor.addColumn")} onClick={() => onChange({ ...b, columns: [...b.columns, ""], rows: b.rows.map((r) => ({ ...r, cells: [...r.cells, ""] })) })} />}
          </div>
        </div>
      );
    }
    case "quote":
      return (
        <div className={clsx("grid gap-1.5 rounded-md p-2", flag() ? "bg-warn-tint/70" : "bg-surface-2/50")}>
          <Textarea rows={2} value={b.text} placeholder={t("artifacts.blocks.quoteText")} onChange={(e) => onChange({ ...b, text: e.target.value })} />
          <Input className={sm} value={b.attribution} placeholder={t("artifacts.blocks.attribution")} onChange={(e) => onChange({ ...b, attribution: e.target.value })} />
          <Cites ids={b.cites} ctx={ctx} onChange={(ids) => onChange({ ...b, cites: ids })} />
        </div>
      );
    case "image":
      return <ImageBlock b={b} onChange={onChange} />;
  }
}

function ImageBlock({ b, onChange }: { b: Extract<Block, { type: "image" }>; onChange: (b: Block) => void }) {
  const t = useT();
  const [picking, setPicking] = useState(b.sourceId === ZERO);
  return (
    <div className="grid gap-1.5">
      {picking ? (
        <div className="rounded-md bg-surface-2/50 p-2">
          <p className="mb-2 text-sm text-muted">{t("artifacts.blocks.pickImage")}</p>
          <ImagePicker onPick={(id, title) => { onChange({ ...b, sourceId: id, alt: b.alt || title }); setPicking(false); }} />
        </div>
      ) : (
        <div className="flex items-start gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/api/files/${b.sourceId}`} alt={b.alt} className="h-20 w-28 rounded-md bg-surface-2 object-cover" />
          <Button type="button" size="sm" variant="secondary" onClick={() => setPicking(true)}>{t("artifacts.blocks.changeImage")}</Button>
        </div>
      )}
      <Input className={sm} value={b.caption} placeholder={t("artifacts.blocks.caption")} onChange={(e) => onChange({ ...b, caption: e.target.value })} />
      <Input className={sm} value={b.alt} placeholder={t("artifacts.blocks.alt")} onChange={(e) => onChange({ ...b, alt: e.target.value })} />
    </div>
  );
}

function AddLine({ onClick, label }: { onClick: () => void; label?: string }) {
  const t = useT();
  return (
    <button type="button" onClick={onClick} className="inline-flex w-fit items-center gap-1 rounded-md px-2 py-1 text-sm text-muted hover:bg-surface-2 hover:text-fg">
      <Plus className="size-3.5" aria-hidden />{label ?? t("artifacts.editor.addItem")}
    </button>
  );
}

/** The whole document as editable sections of blocks. */
export function ContentEditor({ content, onChange, onRegenerate, disabled }: {
  content: ArtifactContent;
  onChange: (c: ArtifactContent) => void;
  onRegenerate?: (section: Section) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const nums = useMemo(() => citationNumbers(content), [content]);
  const base = useMemo(() => ({
    nums,
    byNum: new Map([...nums.entries()].map(([id, n]) => [n, id])),
    citations: content.citations,
    uncited: new Set(uncitedClaims(content).map((u) => `${u.sectionId}/${u.blockId}/${u.item ?? ""}`)),
  }), [nums, content]);
  // addCitation and the item update both call onChange; apply the citation first, then the block, on the latest content.
  const latest = useRef(content);
  latest.current = content;
  const setSections = (fn: (s: Section[]) => Section[]) => onChange({ ...latest.current, sections: fn(latest.current.sections) });
  const ctxLive: Ctx = {
    ...base,
    addCitation: (c) => {
      const cur = latest.current;
      const existing = cur.citations.find((x) => x.kind === c.kind && x.nodeId === c.nodeId && !x.sourceId && !x.edgeId);
      if (existing) return existing.id;
      const id = newId("u");
      latest.current = { ...cur, citations: [...cur.citations, { ...c, id }] };
      return id;
    },
  };
  const updateSection = (sid: string, fn: (s: Section) => Section) => setSections((ss) => ss.map((s) => (s.id === sid ? fn(s) : s)));
  const move = (i: number, d: number) => setSections((ss) => {
    const j = i + d;
    if (j < 0 || j >= ss.length) return ss;
    const copy = [...ss];
    [copy[i], copy[j]] = [copy[j], copy[i]];
    return copy;
  });

  return (
    <fieldset disabled={disabled} className="grid gap-8">
      {content.sections.map((s, i) => (
        <section key={s.id} className="grid gap-3" aria-label={s.title || t("artifacts.editor.sectionTitle")}>
          <div className="flex items-center gap-1">
            <Input value={s.title} onChange={(e) => updateSection(s.id, (x) => ({ ...x, title: e.target.value }))}
              placeholder={t("artifacts.editor.sectionTitle")} className="h-10 text-lg font-semibold" />
            {onRegenerate && <IconButton label={t("artifacts.editor.regenerate")} onClick={() => onRegenerate(s)} type="button"><Sparkles className="size-4" /></IconButton>}
            <IconButton label={t("artifacts.editor.moveUp")} type="button" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="size-4" /></IconButton>
            <IconButton label={t("artifacts.editor.moveDown")} type="button" disabled={i === content.sections.length - 1} onClick={() => move(i, 1)}><ArrowDown className="size-4" /></IconButton>
            <IconButton label={t("artifacts.editor.removeSection")} type="button" onClick={() => setSections((ss) => ss.filter((x) => x.id !== s.id))}><Trash2 className="size-4" /></IconButton>
          </div>
          {s.blocks.map((b) => {
            const Icon = BLOCK_ICON[b.type];
            return (
              <div key={b.id} className="group/block grid gap-1.5">
                <div className="flex items-center justify-between text-xs text-muted">
                  <span className="inline-flex items-center gap-1"><Icon className="size-3.5" aria-hidden />{t(`artifacts.blocks.${b.type}`)}</span>
                  <button type="button" aria-label={t("artifacts.editor.removeBlock")} className="rounded p-1 opacity-60 hover:bg-surface-2 hover:text-danger group-hover/block:opacity-100"
                    onClick={() => updateSection(s.id, (x) => ({ ...x, blocks: x.blocks.filter((y) => y.id !== b.id) }))}><Trash2 className="size-3.5" /></button>
                </div>
                <BlockEditor b={b} ctx={ctxLive} sectionId={s.id} onChange={(nb) => {
                  const cur = latest.current;
                  onChange({ ...cur, sections: cur.sections.map((x) => (x.id === s.id ? { ...x, blocks: x.blocks.map((y) => (y.id === b.id ? nb : y)) } : x)) });
                }} />
              </div>
            );
          })}
          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-1 text-xs text-muted">{t("artifacts.editor.addBlock")}</span>
            {BLOCK_TYPES.map((bt) => {
              const Icon = BLOCK_ICON[bt];
              return (
                <button key={bt} type="button" onClick={() => updateSection(s.id, (x) => ({ ...x, blocks: [...x.blocks, emptyBlock(bt)] }))}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted hover:bg-surface-2 hover:text-fg">
                  <Icon className="size-3.5" aria-hidden />{t(`artifacts.blocks.${bt}`)}
                </button>
              );
            })}
          </div>
        </section>
      ))}
      <div>
        <Button type="button" variant="secondary" onClick={() => setSections((ss) => [...ss, { id: newId("s"), title: "", blocks: [emptyBlock("text")] }])}>
          <Plus className="size-4" aria-hidden />{t("artifacts.editor.addSection")}
        </Button>
      </div>
    </fieldset>
  );
}
