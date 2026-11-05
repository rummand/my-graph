"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { clsx } from "clsx";
import { Check, Folder, Inbox, Trash2 } from "lucide-react";
import { Button, Input } from "@/components/ui";
import type { Lx, Visibility } from "./i18n";
import { VisibilitySelect } from "./visibility-select";
import { flattenViews, folderApi, subtreeIds, type FolderView, type TemplateView } from "./folder-client";

/** A centred dialog over a quiet scrim. Escape and a click outside close it; focus starts inside. */
export function Dialog({ open, onClose, title, children, wide = false }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const back = document.activeElement as HTMLElement | null;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    requestAnimationFrame(() => box.current?.querySelector<HTMLElement>("[autofocus], input, button:not([disabled])")?.focus());
    return () => { window.removeEventListener("keydown", key); back?.focus?.(); };
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div key="scrim" className="fixed inset-0 z-40 bg-fg/20" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }} onClick={onClose} />
          <motion.div key="dialog" ref={box} role="dialog" aria-modal="true" aria-labelledby={`${id}-h`}
            className={clsx("fixed inset-x-4 top-[10vh] z-50 mx-auto max-h-[80vh] overflow-y-auto rounded-lg bg-bg p-5 shadow-float sm:p-6", wide ? "max-w-2xl" : "max-w-md")}
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}>
            <h2 id={`${id}-h`} className="text-lg font-semibold tracking-[-0.01em]">{title}</h2>
            {children}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

const ErrorLine = ({ error }: { error: string | null }) => (error ? <p role="alert" className="mt-3 text-sm text-danger">{error}</p> : null);

/** Delete a folder: says plainly that files move up and nothing is deleted. */
export function DeleteFolderDialog({ L, folder, parentName, onClose, onDone }: {
  L: Lx; folder: FolderView | null; parentName: string | null; onClose: () => void; onDone: (message: string) => void;
}) {
  const { t } = L;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setError(null); setBusy(false); }, [folder]);
  const target = parentName ? t("library.folders.deleteDialog.toParent", { name: parentName }) : t("library.folders.deleteDialog.toTop");
  const inside = folder ? folder.count + folder.children.length : 0;
  const confirm = async () => {
    if (!folder) return;
    setBusy(true); setError(null);
    try {
      await folderApi(L, `/api/library/folders/${folder.id}`, undefined, "DELETE");
      onDone(t("library.folders.deleteDialog.done", { name: folder.name }));
    } catch (e) {
      setError(e instanceof Error ? e.message : t("library.folders.error.generic"));
      setBusy(false);
    }
  };
  return (
    <Dialog open={!!folder} onClose={onClose} title={folder ? t("library.folders.deleteDialog.title", { name: folder.name }) : ""}>
      <p className="mt-2 text-sm text-muted">
        {inside > 0 ? t("library.folders.deleteDialog.body", { target }) : t("library.folders.deleteDialog.bodyEmpty")}
      </p>
      <ErrorLine error={error} />
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>{t("library.folders.deleteDialog.keep")}</Button>
        <Button type="button" variant="danger" onClick={() => void confirm()} disabled={busy}>
          <Trash2 aria-hidden className="size-4" />{busy ? t("library.folders.deleteDialog.deleting") : t("library.folders.deleteDialog.confirm")}
        </Button>
      </div>
    </Dialog>
  );
}

/** Who can see a folder. */
export function FolderSharingDialog({ L, folder, onClose, onDone }: { L: Lx; folder: FolderView | null; onClose: () => void; onDone: () => void }) {
  const { t } = L;
  const [value, setValue] = useState<Visibility>("private");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (folder) { setValue(folder.visibility); setError(null); setBusy(false); } }, [folder]);
  const save = async () => {
    if (!folder) return;
    setBusy(true); setError(null);
    try {
      await folderApi(L, `/api/library/folders/${folder.id}`, { visibility: value }, "PATCH");
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("library.folders.error.generic"));
      setBusy(false);
    }
  };
  return (
    <Dialog open={!!folder} onClose={onClose} title={folder ? t("library.folders.sharingDialog.title", { name: folder.name }) : ""}>
      <div className="mt-4">
        <VisibilitySelect family={L.family} value={value} onChange={setValue} label={t("library.folders.sharingDialog.label")} />
      </div>
      <p className="mt-3 text-sm text-muted">{t("library.folders.sharingDialog.hint")}</p>
      <ErrorLine error={error} />
      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>{t("library.folders.cancel")}</Button>
        <Button type="button" onClick={() => void save()} disabled={busy}>{t("library.folders.save")}</Button>
      </div>
    </Dialog>
  );
}

function TreePreview({ tree }: { tree: TemplateView["tree"] }) {
  return (
    <ul className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
      {tree.map((n) => (
        <li key={n.name} className="min-w-0">
          <span className="inline-flex items-center gap-1.5"><Folder aria-hidden className="size-3.5 shrink-0 text-muted" />{n.name}</span>
          {!!n.children?.length && <span className="block truncate pl-5 text-xs text-muted">{n.children.map((c) => c.name).join(", ")}</span>}
        </li>
      ))}
    </ul>
  );
}

/** "Start from a template": built-in sets (this kind of graph first) and saved ones; only missing folders are added. */
export function TemplatesDialog({ L, open, defaultVisibility, onClose, onDone }: {
  L: Lx; open: boolean; defaultVisibility: Visibility; onClose: () => void; onDone: (message: string) => void;
}) {
  const { t } = L;
  const [templates, setTemplates] = useState<TemplateView[] | null>(null);
  const [chosen, setChosen] = useState<string>("");
  const [visibility, setVisibility] = useState<Visibility>(defaultVisibility);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = useId();

  useEffect(() => {
    if (!open) return;
    setError(null); setBusy(false); setVisibility(defaultVisibility);
    let live = true;
    folderApi<{ templates: TemplateView[] }>(L, "/api/library/folders/templates")
      .then((r) => { if (!live) return; setTemplates(r.templates); setChosen((c) => c || (r.templates.find((x) => x.builtIn && x.forThisGraph) ?? r.templates[0])?.id || ""); })
      .catch((e) => live && setError(e instanceof Error ? e.message : t("library.folders.error.generic")));
    return () => { live = false; };
  }, [open, L, t, defaultVisibility]);

  const apply = async () => {
    setBusy(true); setError(null);
    try {
      const r = await folderApi<{ created: number }>(L, "/api/library/folders/templates", { action: "apply", templateId: chosen, visibility });
      onDone(r.created ? t("library.folders.templates.created", { count: r.created }) : t("library.folders.templates.none"));
    } catch (e) {
      setError(e instanceof Error ? e.message : t("library.folders.error.generic"));
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    try {
      await folderApi(L, "/api/library/folders/templates", { action: "delete", templateId: id });
      setTemplates((ts) => ts?.filter((x) => x.id !== id) ?? null);
      if (chosen === id) setChosen("");
    } catch (e) {
      setError(e instanceof Error ? e.message : t("library.folders.error.generic"));
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={t("library.folders.templates.title")} wide>
      <p className="mt-1.5 text-sm text-muted">{t("library.folders.templates.lead")}</p>
      <div role="radiogroup" aria-label={t("library.folders.templates.title")} className="mt-4 space-y-2">
        {templates === null && !error && <p className="text-sm text-muted">{t("library.folders.loading")}</p>}
        {templates?.map((tp) => {
          const on = chosen === tp.id;
          return (
            <div key={tp.id} className={clsx("rounded-lg p-3 transition-colors", on ? "bg-surface ring-1 ring-fg" : "bg-surface/60 hover:bg-surface")}>
              <div className="flex items-start justify-between gap-3">
                <label className="flex min-w-0 cursor-pointer items-center gap-2.5">
                  <input type="radio" name={name} value={tp.id} checked={on} onChange={() => setChosen(tp.id)} className="size-4 accent-[var(--fg)]" />
                  <span className="font-medium">{tp.name}</span>
                  <span className="text-xs text-muted">
                    {tp.builtIn ? (tp.forThisGraph ? t("library.folders.templates.forThisGraph") : "") : tp.scope === "graph" ? t("library.folders.templates.savedGraph") : t("library.folders.templates.saved")}
                  </span>
                </label>
                {!tp.builtIn && tp.mine && (
                  <button type="button" onClick={() => void remove(tp.id)} className="shrink-0 text-xs text-muted hover:text-danger hover:underline">
                    {t("library.folders.templates.delete")}
                  </button>
                )}
              </div>
              {on && <TreePreview tree={tp.tree} />}
            </div>
          );
        })}
      </div>
      <div className="mt-5">
        <VisibilitySelect family={L.family} value={visibility} onChange={setVisibility} label={t("library.folders.templates.visibility")} />
      </div>
      <ErrorLine error={error} />
      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>{t("library.folders.cancel")}</Button>
        <Button type="button" onClick={() => void apply()} disabled={busy || !chosen}>{busy ? t("library.folders.templates.applying") : t("library.folders.templates.apply")}</Button>
      </div>
    </Dialog>
  );
}

/** "Save this structure as a template": the folders the person sees, for this graph or every graph of their household. */
export function SaveTemplateDialog({ L, open, onClose, onDone }: { L: Lx; open: boolean; onClose: () => void; onDone: (message: string) => void }) {
  const { t } = L;
  const id = useId();
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"graph" | "household">("graph");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setName(""); setScope("graph"); setError(null); setBusy(false); } }, [open]);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setError(t("library.folders.saveTemplate.nameNeeded")); return; }
    setBusy(true); setError(null);
    try {
      await folderApi(L, "/api/library/folders/templates", { action: "save", name: name.trim(), scope });
      onDone(t("library.folders.saveTemplate.saved"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("library.folders.error.generic"));
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title={t("library.folders.saveTemplate.title")}>
      <form onSubmit={(e) => void save(e)}>
        <p className="mt-1.5 text-sm text-muted">{t("library.folders.saveTemplate.lead")}</p>
        <label htmlFor={`${id}-name`} className="mt-4 block text-sm font-medium">{t("library.folders.saveTemplate.name")}</label>
        <Input id={`${id}-name`} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} className="mt-1 w-full" />
        <fieldset className="mt-4">
          <legend className="text-sm font-medium">{t("library.folders.saveTemplate.scope")}</legend>
          {(["graph", "household"] as const).map((s) => (
            <label key={s} className="mt-2 flex cursor-pointer items-center gap-2.5 text-sm">
              <input type="radio" name={`${id}-scope`} checked={scope === s} onChange={() => setScope(s)} className="size-4 accent-[var(--fg)]" />
              {t(s === "graph" ? "library.folders.saveTemplate.scopeGraph" : "library.folders.saveTemplate.scopeHousehold")}
            </label>
          ))}
        </fieldset>
        <ErrorLine error={error} />
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>{t("library.folders.cancel")}</Button>
          <Button type="submit" disabled={busy}>{t("library.folders.saveTemplate.save")}</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Name a new folder (inside `parent`, or at the top level) or rename one. */
export function NameDialog({ L, state, onClose, onDone }: {
  L: Lx;
  state: { kind: "create"; parent: FolderView | null } | { kind: "rename"; folder: FolderView } | null;
  onClose: () => void; onDone: (folderId: string | null) => void;
}) {
  const { t } = L;
  const id = useId();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!state) return;
    setName(state.kind === "rename" ? state.folder.name : ""); setError(null); setBusy(false);
  }, [state]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!state) return;
    if (!name.trim()) { setError(t("library.folders.error.nameNeeded")); return; }
    setBusy(true); setError(null);
    try {
      if (state.kind === "create") {
        const r = await folderApi<{ folder: FolderView }>(L, "/api/library/folders", { name: name.trim(), parentId: state.parent?.id ?? null });
        onDone(r.folder.id);
      } else {
        await folderApi(L, `/api/library/folders/${state.folder.id}`, { name: name.trim() }, "PATCH");
        onDone(state.folder.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("library.folders.error.generic"));
      setBusy(false);
    }
  };
  const title = !state ? "" : state.kind === "rename" ? t("library.folders.renameTitle", { name: state.folder.name })
    : state.parent ? t("library.folders.newInside", { name: state.parent.name }) : t("library.folders.newFolder");
  return (
    <Dialog open={!!state} onClose={onClose} title={title}>
      <form onSubmit={(e) => void submit(e)}>
        <label htmlFor={`${id}-name`} className="mt-4 block text-sm font-medium">{t("library.folders.nameLabel")}</label>
        <Input id={`${id}-name`} autoFocus value={name} maxLength={80} onChange={(e) => { setName(e.target.value); setError(null); }}
          onFocus={(e) => e.currentTarget.select()} className="mt-1 w-full" aria-invalid={!!error} />
        {state?.kind === "create" && state.parent && <p className="mt-2 text-sm text-muted">{t("library.folders.sharedLikeParent")}</p>}
        <ErrorLine error={error} />
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>{t("library.folders.cancel")}</Button>
          <Button type="submit" disabled={busy}>{state?.kind === "rename" ? t("library.folders.rename") : t("library.folders.create")}</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Move a folder: into any folder it may go into (not itself or what is inside it), or to the top level. */
export function MoveFolderDialog({ L, folder, folders, maxDepth, onClose, onDone }: {
  L: Lx; folder: FolderView | null; folders: FolderView[]; maxDepth: number; onClose: () => void; onDone: () => void;
}) {
  const { t } = L;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setError(null); setBusy(false); }, [folder]);
  if (!folder) return <Dialog open={false} onClose={onClose} title=""><span /></Dialog>;
  const skip = subtreeIds(folder);
  const height = Math.max(...flattenViews([folder]).map((f) => f.depth)) - folder.depth + 1;
  const choices = flattenViews(folders).filter((f) => !skip.has(f.id));
  const move = async (parentId: string | null) => {
    setBusy(true); setError(null);
    try {
      await folderApi(L, `/api/library/folders/${folder.id}`, { parentId }, "PATCH");
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("library.folders.error.generic"));
      setBusy(false);
    }
  };
  const row = (key: string, label: string, icon: ReactNode, here: boolean, depth: number, target: string | null, tooDeep = false) => (
    <li key={key}>
      <button type="button" disabled={busy || here || tooDeep} onClick={() => void move(target)} style={{ paddingLeft: `${0.75 + depth * 1}rem` }}
        className="flex h-9 w-full items-center gap-2.5 rounded-md pr-3 text-left text-sm transition-colors hover:bg-surface-2 disabled:opacity-50 disabled:hover:bg-transparent">
        <span aria-hidden className="text-muted">{icon}</span><span className="min-w-0 flex-1 truncate">{label}</span>
        {here && <Check aria-hidden className="size-4 text-muted" />}
      </button>
    </li>
  );
  return (
    <Dialog open onClose={onClose} title={t("library.folders.moveFolderLabel", { name: folder.name })}>
      <ul className="mt-4 max-h-[50vh] overflow-y-auto">
        {row("top", t("library.folders.topLevel"), <Inbox className="size-4" />, folder.parentId === null, 0, null)}
        {choices.map((f) => row(f.id, f.name, <Folder className="size-4" />, folder.parentId === f.id, f.depth, f.id, f.depth + height > maxDepth))}
      </ul>
      <ErrorLine error={error} />
      <div className="mt-4 flex justify-end"><Button type="button" variant="ghost" onClick={onClose}>{t("library.folders.cancel")}</Button></div>
    </Dialog>
  );
}
