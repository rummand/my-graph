"use client";
/**
 * What the assistant (the Ask window) may do in the library, as page actions (see
 * src/components/assistant/page-actions.ts). Reading and navigating run at once; every change shows an approval card
 * first and then goes through the library's own API routes as the person (which re-check access).
 */
import { useRouter } from "next/navigation";
import { z } from "zod";
import { callApi, usePageActions, usePageView, type PageAction } from "@/components/assistant/page-actions";
import type { SourceSummary } from "@/lib/ingest/library";
import { findFolder, flattenViews, folderApi, pathLabel, type FolderKey, type FolderTree, type FolderView, type SuggestionGroup } from "./folder-client";
import { visibilityLabel, type Lx, type Visibility } from "./i18n";
import type { LibraryFilters } from "./library-view";

const KINDS = ["mail", "letter", "scan", "photo", "recording", "note"] as const;
const STATES = ["pending", "processing", "ready", "failed"] as const;
const VIS = ["private", "parents", "household"] as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Act = PageAction<any>;

const folderPath = (f: FolderView) => pathLabel(f.path?.length ? f.path : [f.name]);

/** "Folder Money › Tax, search: pdf" — what the list shows, for the Ask window. */
export function libraryViewDetail(L: Lx, filters: LibraryFilters, tree: FolderTree): string | null {
  const parts: string[] = [];
  const f = filters.folder && filters.folder !== "root" ? findFolder(tree.folders, filters.folder) : null;
  if (f) parts.push(L.t("library.assistantActions.view.folder", { path: folderPath(f) }));
  else if (filters.folder === "root") parts.push(L.t("library.folders.unfiled"));
  if (filters.type) parts.push(L.t("library.assistantActions.view.kind", { kind: L.t(`library.filter.${filters.type}`) }));
  if (filters.status) parts.push(L.t("library.assistantActions.view.state", { state: L.t(`library.stateFilter.${filters.status}`) }));
  if (filters.q.trim()) parts.push(L.t("library.assistantActions.view.search", { q: filters.q.trim() }));
  return parts.length ? parts.join(", ") : null;
}

function names(ids: string[], byId: Map<string, { title: string }>, max = 8): string {
  const known = ids.map((id) => byId.get(id)?.title).filter((x): x is string => !!x);
  const list = known.slice(0, max).map((n) => `• ${n}`);
  if (ids.length > list.length) list.push(`+${ids.length - list.length}`);
  return list.join("\n");
}

/** The library list (/library). */
export function useLibraryListActions(o: {
  L: Lx; filters: LibraryFilters; setFilters: (f: LibraryFilters) => void; openFolder: (key: FolderKey) => void;
  items: SourceSummary[]; total: number; tree: FolderTree; groups: SuggestionGroup[]; refresh: () => void;
}) {
  const { L, filters, tree, items, groups } = o;
  const { t } = L;
  const router = useRouter();
  usePageView({ section: t("library.title"), detail: libraryViewDetail(L, filters, tree) });

  const byId = new Map(items.map((s) => [s.id, s]));
  const folderOf = (id: string | null) => (id ? findFolder(tree.folders, id) : null);

  usePageActions([
    {
      id: "library.filter",
      title: t("library.assistantActions.filter"),
      description: "Change what the library list shows, like the person would: a folder (folder id, \"root\" for files in no folder, \"\" for all), a kind of file, a reading state, a search text. Fields left out stay as they are.",
      input: z.object({
        folder: z.string().max(60).optional(),
        kind: z.enum([...KINDS, ""]).optional(),
        state: z.enum([...STATES, ""]).optional(),
        search: z.string().max(200).optional(),
      }),
      danger: "read",
      run: (i: { folder?: string; kind?: (typeof KINDS)[number] | ""; state?: (typeof STATES)[number] | ""; search?: string }) => {
        if (i.folder && i.folder !== "root" && !folderOf(i.folder)) throw new Error("There is no folder with that id here.");
        const next: LibraryFilters = {
          folder: i.folder ?? filters.folder, type: i.kind ?? filters.type, status: i.state ?? filters.status, q: i.search ?? filters.q,
        };
        o.setFilters(next);
        return t("library.assistantActions.done.filtered");
      },
    },
    {
      id: "library.list_files",
      title: t("library.assistantActions.listFiles"),
      description: "The files the library list shows right now (with the current folder/filter): id, title, kind, state, folder path, whether the person may move/edit it. Use the ids for other actions.",
      input: z.object({}),
      danger: "read",
      run: () => ({
        summary: t("library.assistantActions.done.listed", { count: items.length }),
        data: {
          total: o.total,
          shown: items.slice(0, 80).map((s) => ({ id: s.id, title: s.title, kind: s.docKind ?? s.category, state: s.status, canEdit: s.canEdit })),
        },
      }),
    },
    {
      id: "library.find_files",
      title: t("library.assistantActions.findFiles"),
      description: "Search all the files the person can see by name or text (any folder), optionally only in one folder (folder id, or \"root\" for files in no folder). Returns ids and titles to use with the other actions. Prefer this to filtering and listing when looking for a particular file.",
      input: z.object({ search: z.string().trim().max(200).optional(), folder: z.string().max(60).optional() }),
      danger: "read",
      run: async (i: { search?: string; folder?: string }) => {
        const qs = new URLSearchParams({ limit: "60" });
        if (i.search) qs.set("q", i.search);
        if (i.folder) qs.set("folder", i.folder);
        const body = await callApi<{ items: SourceSummary[]; total?: number }>(`/api/library?${qs}`);
        return {
          summary: t("library.assistantActions.done.listed", { count: body.items.length }),
          data: { found: body.items.slice(0, 60).map((s) => ({ id: s.id, title: s.title, kind: s.docKind ?? s.category, folder: folderOf(s.folderId ?? null) ? folderPath(folderOf(s.folderId ?? null)!) : null, canEdit: s.canEdit })) },
        };
      },
    },
    {
      id: "library.list_folders",
      title: t("library.assistantActions.listFolders"),
      description: "Every folder the person can see: id, path like \"Money › Tax\", how many files, whether they may put files in it.",
      input: z.object({}),
      danger: "read",
      run: () => ({
        summary: t("library.assistantActions.done.listedFolders", { count: flattenViews(tree.folders).length }),
        data: { canCreate: tree.canCreate, folders: flattenViews(tree.folders).slice(0, 150).map((f) => ({ id: f.id, path: folderPath(f), files: f.count, canEdit: f.canEdit })) },
      }),
    },
    {
      id: "library.open_file",
      title: t("library.assistantActions.openFile"),
      description: "Open one file's page (by file id).",
      input: z.object({ fileId: z.uuid() }),
      danger: "read",
      run: ({ fileId }: { fileId: string }) => { router.push(`/library/${fileId}`); return t("library.assistantActions.done.opened"); },
    },
    {
      id: "library.move_files",
      title: t("library.assistantActions.moveFiles"),
      description: "Move files (ids from list_files) into a folder (id from list_folders), or out of every folder with folderId null. Every version of a document moves along.",
      input: z.object({ fileIds: z.array(z.uuid()).min(1).max(200), folderId: z.uuid().nullable() }),
      danger: "change",
      confirm: (i: { fileIds: string[]; folderId: string | null }) => {
        const f = folderOf(i.folderId);
        const one = i.fileIds.length === 1 ? byId.get(i.fileIds[0])?.title : null;
        if (!i.folderId) return one ? t("library.assistantActions.q.moveOutOne", { name: one }) : t("library.assistantActions.q.moveOut", { count: i.fileIds.length });
        const path = f ? folderPath(f) : "?";
        return one ? t("library.assistantActions.q.moveOne", { name: one, folder: path }) : t("library.assistantActions.q.move", { count: i.fileIds.length, folder: path });
      },
      preview: (i: { fileIds: string[] }) => (i.fileIds.length > 1 ? names(i.fileIds, byId) : null),
      run: async (i: { fileIds: string[]; folderId: string | null }) => {
        if (i.folderId && !folderOf(i.folderId)) throw new Error("There is no folder with that id here.");
        const r = await folderApi<{ moved: number; skipped: number }>(L, "/api/library/move", { sourceIds: i.fileIds, folderId: i.folderId });
        o.refresh();
        return { summary: t("library.assistantActions.done.moved", { count: r.moved }) + (r.skipped ? ` ${t("library.folders.skipped", { count: r.skipped })}` : ""), data: r };
      },
    },
    {
      id: "library.create_folder",
      title: t("library.assistantActions.createFolder"),
      description: "Create a folder, optionally inside another folder (parentId from list_folders). Who sees it: private, parents (editors), household (everyone); left out = the library's default.",
      input: z.object({ name: z.string().trim().min(1).max(80), parentId: z.uuid().nullish(), visibility: z.enum(VIS).optional() }),
      danger: "change",
      confirm: (i: { name: string; parentId?: string | null }) => {
        const p = folderOf(i.parentId ?? null);
        return p ? t("library.assistantActions.q.createIn", { name: i.name, parent: folderPath(p) }) : t("library.assistantActions.q.create", { name: i.name });
      },
      preview: (i: { visibility?: Visibility }) => (i.visibility ? visibilityLabel(L, i.visibility) : null),
      run: async (i: { name: string; parentId?: string | null; visibility?: Visibility }) => {
        const r = await folderApi<{ folder: { id: string; name: string } }>(L, "/api/library/folders", { name: i.name, parentId: i.parentId ?? null, ...(i.visibility ? { visibility: i.visibility } : {}) });
        o.refresh();
        return { summary: t("library.assistantActions.done.created", { name: r.folder.name }), data: { folderId: r.folder.id } };
      },
    },
    {
      id: "library.accept_folder_suggestions",
      title: t("library.assistantActions.acceptSuggestions"),
      description: `Accept the suggested folders for unfiled files: all of them, or only some files (ids). Suggestions waiting now: ${JSON.stringify(groups.slice(0, 12).map((g) => ({ path: pathLabel(g.path), newFolder: !g.exists, files: g.files.slice(0, 10).map((f) => ({ id: f.id, title: f.title })) })))}`.slice(0, 590),
      input: z.object({ fileIds: z.union([z.array(z.uuid()).min(1).max(500), z.literal("all")]) }),
      danger: "change",
      confirm: (i: { fileIds: string[] | "all" }) => {
        const count = i.fileIds === "all" ? groups.reduce((n, g) => n + g.files.length, 0) : i.fileIds.length;
        return t("library.assistantActions.q.accept", { count });
      },
      preview: (i: { fileIds: string[] | "all" }) => {
        const pick = i.fileIds === "all" ? null : new Set(i.fileIds);
        return groups.map((g) => ({ g, n: g.files.filter((f) => !pick || pick.has(f.id)).length })).filter((x) => x.n)
          .slice(0, 8).map((x) => `• ${pathLabel(x.g.path)} (${x.n})`).join("\n") || null;
      },
      run: async (i: { fileIds: string[] | "all" }) => {
        const r = await folderApi<{ moved?: number }>(L, "/api/library/folders/suggestions", { action: "accept", sourceIds: i.fileIds });
        o.refresh();
        return t("library.assistantActions.done.moved", { count: r.moved ?? 0 });
      },
    },
  ] as Act[], [L, filters, tree, items, groups, o.total]);
}

/** One file's page (/library/[id]). Changes only for what the person may do; the API checks again. */
export function useFileActions(o: {
  L: Lx; id: string; title: string; visibility: Visibility; folders: FolderView[];
  canMove: boolean; isOwner: boolean; busy: boolean;
}) {
  const { L, id, title, folders } = o;
  const { t } = L;
  const router = useRouter();
  const folderOf = (fid: string | null) => (fid ? findFolder(folders, fid) : null);
  const patch = (body: Record<string, unknown>) => folderApi(L, `/api/library/${id}`, body, "PATCH");

  const list: Act[] = [];
  if (o.canMove) {
    list.push({
      id: "file.move",
      title: t("library.assistantActions.fileMove"),
      description: `Move this file (and its versions) into a folder, or out of every folder with folderId null. Folders: ${JSON.stringify(flattenViews(folders).slice(0, 40).map((f) => ({ id: f.id, path: folderPath(f) })))}`.slice(0, 590),
      input: z.object({ folderId: z.uuid().nullable() }),
      danger: "change",
      confirm: (i: { folderId: string | null }) => {
        const f = folderOf(i.folderId);
        return i.folderId ? t("library.assistantActions.q.moveOne", { name: title, folder: f ? folderPath(f) : "?" }) : t("library.assistantActions.q.moveOutOne", { name: title });
      },
      run: async (i: { folderId: string | null }) => {
        if (i.folderId && !folderOf(i.folderId)) throw new Error("There is no folder with that id here.");
        await folderApi(L, "/api/library/move", { sourceIds: [id], folderId: i.folderId });
        router.refresh();
        return t("library.assistantActions.done.moved", { count: 1 });
      },
    });
  }
  if (o.isOwner) {
    list.push(
      {
        id: "file.rename",
        title: t("library.assistantActions.fileRename"),
        description: "Give this file a new name (title).",
        input: z.object({ title: z.string().trim().min(1).max(250) }),
        danger: "change",
        confirm: (i: { title: string }) => t("library.assistantActions.q.rename", { title: i.title }),
        preview: () => t("library.assistantActions.q.now", { title }),
        run: async (i: { title: string }) => { await patch({ title: i.title }); router.refresh(); return t("library.settings.renamed"); },
      },
      {
        id: "file.set_visibility",
        title: t("library.assistantActions.fileVisibility"),
        description: "Change who can see this file: private (only the owner), parents (parents / the graph's editors), household (everyone in the graph).",
        input: z.object({ visibility: z.enum(VIS) }),
        danger: "change",
        confirm: (i: { visibility: Visibility }) => t("library.assistantActions.q.visibility", { who: visibilityLabel(L, i.visibility) }),
        preview: () => t("library.assistantActions.q.visibilityNow", { who: visibilityLabel(L, o.visibility) }),
        run: async (i: { visibility: Visibility }) => { await patch({ visibility: i.visibility }); router.refresh(); return t("library.settings.savedSharing"); },
      },
      {
        id: "file.reread",
        title: t("library.assistantActions.fileReread"),
        description: "Read this file again from scratch (text, people, dates, facts). Use when reading failed or the result looks wrong.",
        input: z.object({}),
        danger: "change",
        confirm: () => t("library.assistantActions.q.reread", { name: title }),
        run: async () => {
          if (o.busy) throw new Error("The file is being read right now.");
          await folderApi(L, `/api/library/${id}/reprocess`, {});
          router.refresh();
          return t("library.settings.reading");
        },
      },
    );
  }
  usePageActions(list, [L, id, title, o.visibility, folders, o.canMove, o.isOwner, o.busy]);
}
