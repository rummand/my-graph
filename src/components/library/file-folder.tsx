"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, FolderInput } from "lucide-react";
import { useLx } from "./use-lx";
import { folderApi, type FolderView } from "./folder-client";
import { MoveToMenu } from "./folder-menu";

/**
 * A file page's way back: the library and the folder the file is in (as the viewer sees it), with "Move to…" for
 * the person who may move it. Moving takes every version of the document along.
 */
export function FileFolder({ family, sourceId, path, folders, canMove }: {
  family: boolean; sourceId: string; path: { id: string; name: string }[] | null; folders: FolderView[]; canMove: boolean;
}) {
  const L = useLx(family);
  const { t } = L;
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const current = path?.at(-1)?.id ?? null;
  const move = async (folderId: string | null) => {
    setError(null); setDone(null);
    try {
      await folderApi(L, "/api/library/move", { sourceIds: [sourceId], folderId });
      setDone(folderId ? t("library.folders.movedOne", { name: findName(folders, folderId) }) : t("library.folders.movedOutOne"));
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("library.folders.error.generic"));
    }
  };
  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <nav aria-label={t("library.folders.breadcrumb")} className="min-w-0">
        <ol className="flex flex-wrap items-center gap-1 text-sm text-muted">
          <li>
            <Link href="/library" className="inline-flex items-center gap-1 hover:text-fg"><ArrowLeft aria-hidden className="size-4" />{t("library.detail.back")}</Link>
          </li>
          {path?.map((f) => (
            <li key={f.id} className="flex items-center gap-1">
              <span aria-hidden>›</span>
              <Link href={`/library?folder=${f.id}`} className="hover:text-fg hover:underline">{f.name}</Link>
            </li>
          ))}
        </ol>
      </nav>
      <div className="flex items-center gap-3">
        {(done || error) && <p role="status" className={error ? "text-sm text-danger" : "text-sm text-muted"}>{error ?? done}</p>}
        {canMove && (
          <MoveToMenu L={L} folders={folders} current={current} onMove={(id) => void move(id)} label={t("library.folders.moveThis")}
            trigger={<><FolderInput aria-hidden className="size-4" />{t("library.folders.moveTo")}</>}
            triggerClassName="h-8 gap-2 px-2.5 text-sm text-muted hover:bg-surface-2 hover:text-fg" />
        )}
      </div>
    </div>
  );
}

function findName(fs: FolderView[], id: string): string {
  for (const f of fs) {
    if (f.id === id) return f.name;
    const n = findName(f.children, id);
    if (n) return n;
  }
  return "";
}
