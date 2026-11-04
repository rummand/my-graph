/**
 * Export (server-only): the "Download HTML" file. It is the same renderer as the screen and print views, made
 * self-contained: images the viewer may read are embedded, links point back to the app. PDF comes from the print
 * route (/artifacts/[id]/print) through the browser; PowerPoint export is a later step.
 */
import type { Viewer } from "@/lib/auth";
import { getPrefs, tFor, formatDate } from "@/lib/i18n";
import { getReadableSource } from "@/lib/ingest/library";
import { readStored } from "@/lib/storage";
import type { DesignSetView } from "@/lib/design-sets";
import { renderStandalone, type RenderLabels } from "./render";
import { getArtifact, type ArtifactView } from "./index";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_IMAGE = 4 * 1024 * 1024;

export function renderLabels(t: (k: string) => string): RenderLabels {
  return {
    sources: t("artifacts.render.sources"), noSources: t("artifacts.render.noSources"), contents: t("artifacts.render.contents"),
    slide: t("artifacts.render.slide"), people: t("artifacts.render.people"), draft: t("artifacts.render.draft"),
  };
}

export function bylineText(t: (k: string, vars?: Record<string, string | number>) => string, a: Pick<ArtifactView, "ownerName" | "publishedAt" | "updatedAt">, graphName: string, fmt: (d: string) => string): string {
  return t("artifacts.render.byline", { name: a.ownerName ?? "", graph: graphName, date: fmt(a.publishedAt ?? a.updatedAt) });
}

function imageIds(a: ArtifactView): string[] {
  return [...new Set(a.content.sections.flatMap((s) => s.blocks.flatMap((b) => (b.type === "image" ? [b.sourceId] : []))))].slice(0, 30);
}

export async function exportHtml(v: Viewer, id: string, origin: string): Promise<{ filename: string; html: string; artifact: ArtifactView; set: DesignSetView }> {
  const { artifact, set } = await getArtifact(v, id);
  const prefs = await getPrefs();
  const t = tFor(prefs.locale);
  const fmt = (d: string) => formatDate(d, "date", { locale: prefs.locale, timeZone: prefs.timeZone });
  const images = new Map<string, string>();
  let budget = 12 * 1024 * 1024;
  for (const sid of imageIds(artifact)) {
    try {
      const src = await getReadableSource(v, sid);
      if (!src?.storageKey || !src.mime || !IMAGE_TYPES.has(src.mime) || (src.size ?? 0) > MAX_IMAGE || (src.size ?? 0) > budget) continue;
      const buf = await readStored(src.storageKey);
      budget -= buf.byteLength;
      images.set(sid, `data:${src.mime};base64,${buf.toString("base64")}`);
    } catch { /* leave it out */ }
  }
  const html = renderStandalone({
    kind: artifact.kind, title: artifact.title, content: artifact.content, tokens: set.tokens, template: set.templates[artifact.kind],
    status: artifact.status, byline: bylineText(t, artifact, v.graphName, fmt), labels: renderLabels(t), lang: prefs.locale,
    description: artifact.content.subtitle || undefined, scope: "x",
    links: {
      node: (nid) => `${origin}/node/${nid}`,
      source: (sid) => `${origin}/library/${sid}`,
      image: (sid) => images.get(sid) ?? `${origin}/api/files/${sid}`,
    },
  });
  const base = artifact.title.replace(/[^\p{L}\p{N} _-]+/gu, "").trim().replace(/\s+/g, "-").slice(0, 80) || "document";
  return { filename: `${base}.html`, html, artifact, set };
}
