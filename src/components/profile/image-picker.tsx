"use client";
/** "Image from the library": the viewer's photos (GET /api/library?type=photo), pick one to place in the profile. */
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { X } from "lucide-react";
import { IconButton, Input } from "@/components/ui";
import { useT } from "@/lib/i18n/client";

type Photo = { id: string; title: string; mime: string | null; status: string };

export function ImagePicker({ onPick, onClose }: { onPick: (p: { sourceId: string; alt: string }) => void; onClose: () => void }) {
  const t = useT();
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Photo[] | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    const id = window.setTimeout(async () => {
      const params = new URLSearchParams({ type: "photo", limit: "24", ...(q.trim() ? { q: q.trim() } : {}) });
      const res = await fetch(`/api/library?${params}`).catch(() => null);
      const data = res?.ok ? await res.json().catch(() => null) : null;
      if (live) setItems(((data?.items ?? []) as Photo[]).filter((p) => p.mime && /^image\/(jpeg|png|webp)$/.test(p.mime)));
    }, 200);
    return () => { live = false; window.clearTimeout(id); };
  }, [q]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    box.current?.querySelector("input")?.focus();
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-fg/30 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <motion.div ref={box} role="dialog" aria-modal="true" aria-labelledby="image-picker-h" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }} className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-lg bg-surface shadow-float">
        <div className="flex items-center justify-between gap-3 p-4 pb-2">
          <h2 id="image-picker-h" className="text-lg font-semibold">{t("profile.image.title")}</h2>
          <IconButton label={t("profile.image.close")} onClick={onClose}><X className="size-4" /></IconButton>
        </div>
        <div className="px-4"><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("profile.image.search")} aria-label={t("profile.image.search")} /></div>
        <div className="min-h-40 overflow-y-auto p-4">
          {items === null ? <p className="text-sm text-muted">{t("profile.image.loading")}</p>
            : items.length === 0 ? (
              <p className="text-sm text-muted">{t("profile.image.empty")} <Link href="/library" className="text-accent hover:underline">{t("profile.image.openLibrary")}</Link></p>
            ) : (
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {items.map((p) => (
                  <li key={p.id}>
                    <button type="button" onClick={() => onPick({ sourceId: p.id, alt: p.title })} className="group block w-full text-left">
                      {/* eslint-disable-next-line @next/next/no-img-element -- served by /api/files with an access check */}
                      <img src={`/api/files/${p.id}`} alt="" loading="lazy" className="aspect-square w-full rounded-md bg-surface-2 object-cover group-hover:opacity-90 group-focus-visible:ring-2 group-focus-visible:ring-accent" />
                      <span className="mt-1 block truncate text-xs text-muted">{p.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
        </div>
      </motion.div>
    </div>
  );
}
