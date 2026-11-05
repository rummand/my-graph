"use client";
import { useEffect, useMemo, useState } from "react";
import { clsx } from "clsx";
import { ChevronRight, Folder, FolderOpen, FolderPlus, FolderTree, Inbox, Library, MoreHorizontal, Pencil, Sparkles, Trash2, Users, Wand2, Save, FolderInput } from "lucide-react";
import { Button } from "@/components/ui";
import type { Lx } from "./i18n";
import { DRAG_TYPE, trail, type FolderKey, type FolderTree as Tree, type FolderView } from "./folder-client";
import { Menu, type MenuItem } from "./folder-menu";

/** What the folder views ask the library to do. */
export type FolderActions = {
  open: (key: FolderKey) => void;
  moveFiles: (ids: string[], folderId: string | null) => void;
  moveFolder: (folder: FolderView) => void;
  create: (parent: FolderView | null) => void;
  rename: (folder: FolderView) => void;
  sharing: (folder: FolderView) => void;
  remove: (folder: FolderView) => void;
  templates: () => void;
  saveTemplate: () => void;
  suggest: () => void;
};

/** Files dragged from a card or row (our own drag type, never files from the computer). */
function droppedIds(e: React.DragEvent): string[] | null {
  if (!Array.from(e.dataTransfer.types).includes(DRAG_TYPE)) return null;
  try {
    const ids = JSON.parse(e.dataTransfer.getData(DRAG_TYPE)) as unknown;
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : null;
  } catch {
    return null;
  }
}

/** A place files can be dropped on: highlights while files are over it. */
function useDrop(onDrop: (ids: string[]) => void) {
  const [over, setOver] = useState(false);
  return {
    over,
    props: {
      onDragOver: (e: React.DragEvent) => {
        if (!Array.from(e.dataTransfer.types).includes(DRAG_TYPE)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (!over) setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop: (e: React.DragEvent) => {
        setOver(false);
        const ids = droppedIds(e);
        if (!ids?.length) return;
        e.preventDefault();
        onDrop(ids);
      },
    },
  };
}

function folderMenuItems(L: Lx, f: FolderView, a: FolderActions, maxDepth: number, canCreate: boolean): MenuItem[] {
  const { t } = L;
  const items: MenuItem[] = [];
  if (canCreate && f.depth < maxDepth) items.push({ key: "new", label: t("library.folders.newInsideShort"), icon: <FolderPlus />, onSelect: () => a.create(f) });
  if (f.canEdit) {
    items.push(
      { key: "rename", label: t("library.folders.rename"), icon: <Pencil />, onSelect: () => a.rename(f) },
      { key: "sharing", label: t("library.folders.sharing"), icon: <Users />, onSelect: () => a.sharing(f) },
      { key: "move", label: t("library.folders.moveFolder"), icon: <FolderInput />, onSelect: () => a.moveFolder(f) },
      { key: "delete", label: t("library.folders.delete"), icon: <Trash2 />, danger: true, onSelect: () => a.remove(f) },
    );
  }
  return items;
}

const OPEN_KEY = "library:folders:open";

/** The folder tree on wide screens: All files, Not in a folder, then each folder with its count. */
export function FolderSidebar({ L, tree, current, actions, suggesting }: { L: Lx; tree: Tree; current: FolderKey; actions: FolderActions; suggesting: boolean }) {
  const { t } = L;
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => {
    try { setOpen(new Set(JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]") as string[])); } catch { /* storage unavailable */ }
  }, []);
  // The folder being viewed is always unfolded down to it.
  const path = useMemo(() => (current && current !== "root" ? trail(tree.folders, current).map((f) => f.id) : []), [tree.folders, current]);
  const isOpen = (id: string) => open.has(id) || path.slice(0, -1).includes(id);
  const toggle = (id: string) => setOpen((s) => {
    const n = new Set(s);
    if (isOpen(id)) { n.delete(id); } else n.add(id);
    try { localStorage.setItem(OPEN_KEY, JSON.stringify([...n])); } catch { /* ignore */ }
    return n;
  });

  const empty = tree.folders.length === 0;
  const more: MenuItem[] = [
    ...(tree.canCreate ? [{ key: "new", label: t("library.folders.newFolder"), icon: <FolderPlus />, onSelect: () => actions.create(null) },
      { key: "tpl", label: t("library.folders.menu.templates"), icon: <FolderTree />, onSelect: actions.templates }] : []),
    ...(!empty && tree.canCreate ? [{ key: "save", label: t("library.folders.menu.saveTemplate"), icon: <Save />, onSelect: actions.saveTemplate }] : []),
    ...(tree.canCreate ? [{ key: "suggest", label: t("library.folders.menu.suggest"), icon: <Sparkles />, onSelect: actions.suggest, disabled: suggesting }] : []),
  ];

  return (
    <nav aria-label={t("library.folders.title")} className="text-sm">
      <ul className="space-y-0.5">
        <Place L={L} icon={<Library />} label={t("library.folders.all")} count={tree.total} active={current === ""} onOpen={() => actions.open("")} />
        <Place L={L} icon={<Inbox />} label={t("library.folders.unfiled")} count={tree.unfiled} active={current === "root"} onOpen={() => actions.open("root")}
          onDrop={(ids) => actions.moveFiles(ids, null)} />
      </ul>

      <div className="mb-1 mt-6 flex items-center justify-between gap-2 pl-2">
        <h2 className="text-xs font-medium text-muted">{t("library.folders.title")}</h2>
        {more.length > 0 && <Menu label={t("library.folders.menu.more")} trigger={<MoreHorizontal aria-hidden className="size-4" />} items={more} align="left"
          triggerClassName="size-7 text-muted hover:bg-surface-2 hover:text-fg" />}
      </div>

      {empty ? (
        <div className="rounded-lg bg-surface px-3 py-3.5">
          <p className="font-medium">{t("library.folders.empty.title")}</p>
          <p className="mt-1 text-xs/5 text-muted">{t("library.folders.empty.body")}</p>
          {tree.canCreate && (
            <div className="mt-3 flex flex-col items-start gap-1">
              <Button type="button" size="sm" variant="secondary" onClick={actions.templates} className="w-full justify-start"><FolderTree aria-hidden className="size-4" />{t("library.folders.empty.template")}</Button>
              <Button type="button" size="sm" variant="ghost" onClick={actions.suggest} disabled={suggesting} className="w-full justify-start"><Wand2 aria-hidden className="size-4" />{t("library.folders.empty.suggest")}</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => actions.create(null)} className="w-full justify-start"><FolderPlus aria-hidden className="size-4" />{t("library.folders.newFolder")}</Button>
            </div>
          )}
        </div>
      ) : (
        <>
          <ul className="space-y-0.5" role="tree" aria-label={t("library.folders.title")}>
            {tree.folders.map((f) => <Branch key={f.id} L={L} f={f} tree={tree} current={current} isOpen={isOpen} toggle={toggle} actions={actions} />)}
          </ul>
          {tree.canCreate && (
            <button type="button" onClick={() => actions.create(null)}
              className="mt-2 flex h-8 w-full items-center gap-2 rounded-md px-2 text-muted transition-colors hover:bg-surface-2 hover:text-fg">
              <FolderPlus aria-hidden className="size-4" />{t("library.folders.newFolder")}
            </button>
          )}
        </>
      )}
    </nav>
  );
}

function Place({ L, icon, label, count, active, onOpen, onDrop }: {
  L: Lx; icon: React.ReactNode; label: string; count: number; active: boolean; onOpen: () => void; onDrop?: (ids: string[]) => void;
}) {
  const drop = useDrop(onDrop ?? (() => {}));
  return (
    <li {...(onDrop ? drop.props : {})}>
      <button type="button" onClick={onOpen} aria-current={active ? "page" : undefined}
        title={onDrop && drop.over ? L.t("library.folders.dropHere", { name: label }) : undefined}
        className={clsx("flex h-8 w-full items-center gap-2 rounded-md px-2 text-left transition-colors [&_svg]:size-4 [&_svg]:shrink-0",
          drop.over ? "bg-accent-tint text-accent ring-2 ring-accent" : active ? "bg-surface font-medium text-fg" : "text-fg/85 hover:bg-surface-2")}>
        <span aria-hidden className={active ? "text-fg" : "text-muted"}>{icon}</span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="tabular-nums text-xs text-muted">{count || ""}</span>
      </button>
    </li>
  );
}

function Branch({ L, f, tree, current, isOpen, toggle, actions }: {
  L: Lx; f: FolderView; tree: Tree; current: FolderKey; isOpen: (id: string) => boolean; toggle: (id: string) => void; actions: FolderActions;
}) {
  const { t } = L;
  const active = current === f.id;
  const expanded = isOpen(f.id);
  const drop = useDrop((ids) => actions.moveFiles(ids, f.id));
  const items = folderMenuItems(L, f, actions, tree.maxDepth, tree.canCreate);
  const Icon = active || expanded && f.children.length ? FolderOpen : Folder;
  return (
    <li role="treeitem" aria-expanded={f.children.length ? expanded : undefined} aria-selected={active}>
      <div {...drop.props} className="group/row relative flex items-center" style={{ paddingLeft: `${(f.depth - 1) * 14}px` }}>
        {f.children.length ? (
          <button type="button" onClick={() => toggle(f.id)} aria-label={t(expanded ? "library.folders.collapse" : "library.folders.expand", { name: f.name })}
            className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-fg">
            <ChevronRight aria-hidden className={clsx("size-3.5 transition-transform duration-150", expanded && "rotate-90")} />
          </button>
        ) : <span className="size-6 shrink-0" />}
        <button type="button" onClick={() => actions.open(f.id)} aria-current={active ? "page" : undefined}
          title={drop.over ? t("library.folders.dropHere", { name: f.name }) : f.name}
          className={clsx("flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md pl-1.5 pr-2 text-left transition-colors",
            drop.over ? "bg-accent-tint text-accent ring-2 ring-accent" : active ? "bg-surface font-medium text-fg" : "text-fg/85 hover:bg-surface-2")}>
          <Icon aria-hidden className={clsx("size-4 shrink-0", active ? "text-fg" : "text-muted")} />
          <span className="min-w-0 flex-1 truncate">{f.name}</span>
          <span className={clsx("tabular-nums text-xs text-muted", items.length && "group-focus-within/row:invisible group-hover/row:invisible")}>{f.count || ""}</span>
        </button>
        {items.length > 0 && (
          <Menu label={t("library.folders.actions", { name: f.name })} items={items}
            trigger={<MoreHorizontal aria-hidden className="size-4" />} align="left"
            className="absolute right-0.5 top-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/row:opacity-100"
            triggerClassName="size-7 text-muted hover:bg-surface-2 hover:text-fg" />
        )}
      </div>
      {expanded && f.children.length > 0 && (
        <ul role="group" className="mt-0.5 space-y-0.5">
          {f.children.map((c) => <Branch key={c.id} L={L} f={c} tree={tree} current={current} isOpen={isOpen} toggle={toggle} actions={actions} />)}
        </ul>
      )}
    </li>
  );
}

/** Phones and narrow windows: where you are, the folders inside it, and the folder actions. */
export function FolderBar({ L, tree, current, actions, suggesting }: { L: Lx; tree: Tree; current: FolderKey; actions: FolderActions; suggesting: boolean }) {
  const { t } = L;
  const here = current && current !== "root" ? trail(tree.folders, current) : [];
  const folder = here.at(-1) ?? null;
  const inside = current === "" ? tree.folders : folder?.children ?? [];
  const items: MenuItem[] = [
    ...(tree.canCreate ? [{ key: "new", label: folder ? t("library.folders.newInside", { name: folder.name }) : t("library.folders.newFolder"), icon: <FolderPlus />, onSelect: () => actions.create(folder) }] : []),
    ...(folder ? folderMenuItems(L, folder, actions, tree.maxDepth, false) : []),
    ...(tree.canCreate ? [
      { key: "tpl", label: t("library.folders.menu.templates"), icon: <FolderTree />, onSelect: actions.templates },
      { key: "suggest", label: t("library.folders.menu.suggest"), icon: <Sparkles />, onSelect: actions.suggest, disabled: suggesting },
    ] : []),
  ];
  return (
    <div className="mb-5 lg:hidden">
      <div className="flex items-center gap-2">
        <nav aria-label={t("library.folders.breadcrumb")} className="min-w-0 flex-1">
          <ol className="flex min-w-0 items-center gap-1 overflow-x-auto text-sm">
            <li className="shrink-0">
              <button type="button" onClick={() => actions.open("")} className={clsx("rounded px-1 py-0.5 hover:underline", current === "" ? "font-medium text-fg" : "text-muted")}>
                {t("library.folders.all")}
              </button>
            </li>
            {current === "root" && <Crumb label={t("library.folders.unfiled")} active onOpen={() => {}} />}
            {here.map((f, i) => <Crumb key={f.id} label={f.name} active={i === here.length - 1} onOpen={() => actions.open(f.id)} />)}
          </ol>
        </nav>
        {items.length > 0 && <Menu label={t("library.folders.menu.more")} trigger={<MoreHorizontal aria-hidden className="size-4" />} items={items} />}
      </div>
      {(inside.length > 0 || current === "") && (
        <div className="-mx-4 mt-2 overflow-x-auto px-4">
          <ul className="flex w-max gap-1.5" aria-label={folder ? t("library.folders.inside", { name: folder.name }) : t("library.folders.title")}>
            {current === "" && (
              <li><Chip icon={<Inbox aria-hidden className="size-4" />} label={t("library.folders.unfiled")} count={tree.unfiled} onOpen={() => actions.open("root")} /></li>
            )}
            {inside.map((f) => <li key={f.id}><Chip icon={<Folder aria-hidden className="size-4" />} label={f.name} count={f.count} onOpen={() => actions.open(f.id)} /></li>)}
            {current === "" && inside.length === 0 && tree.canCreate && (
              <li><Chip icon={<FolderTree aria-hidden className="size-4" />} label={t("library.folders.empty.template")} onOpen={actions.templates} /></li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

function Crumb({ label, active, onOpen }: { label: string; active: boolean; onOpen: () => void }) {
  return (
    <li className="flex min-w-0 shrink-0 items-center gap-1">
      <ChevronRight aria-hidden className="size-3.5 text-muted" />
      {active ? <span aria-current="page" className="truncate px-1 font-medium">{label}</span>
        : <button type="button" onClick={onOpen} className="truncate rounded px-1 py-0.5 text-muted hover:underline">{label}</button>}
    </li>
  );
}

function Chip({ icon, label, count, onOpen }: { icon: React.ReactNode; label: string; count?: number; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-full bg-surface px-3.5 text-sm transition-colors hover:bg-surface-2">
      <span className="text-muted">{icon}</span>{label}
      {!!count && <span className="tabular-nums text-xs text-muted">{count}</span>}
    </button>
  );
}
