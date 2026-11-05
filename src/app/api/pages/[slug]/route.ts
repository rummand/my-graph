import { deletePage, getBacklinks, getPage, setVisibility, updatePage, PageError } from "@/lib/pages";
import { parseBody, route, slugParam } from "@/lib/pages/http";
import { patchBody } from "../schemas";

type P = { slug: string };

/** GET /api/pages/[slug] — the page, what the viewer may do with it, and its backlinks. */
export const GET = route<P>(async (_req, v, params) => {
  const { slug } = slugParam.parse(params);
  const page = await getPage(v, slug);
  if (!page) throw new PageError(404, "This page doesn't exist, or it hasn't been shared with you.");
  return { page, backlinks: await getBacklinks(v, page) };
});

/**
 * PATCH /api/pages/[slug] — save { version, title?, content?, force? } and/or change { visibility }.
 * 409 with `current` when someone else saved first (resend with force: true to overwrite).
 */
export const PATCH = route<P>(async (req, v, params) => {
  const { slug } = slugParam.parse(params);
  const b = await parseBody(req, patchBody);
  let page = null;
  let changed = false;
  if (b.title !== undefined || b.content !== undefined) {
    const r = await updatePage(v, slug, { version: b.version!, title: b.title, content: b.content, force: b.force });
    page = r.page;
    changed = r.changed;
  }
  if (b.visibility !== undefined) page = await setVisibility(v, slug, b.visibility);
  return { page, changed };
});

/** DELETE /api/pages/[slug] — the owner, or a parent for a whole-family page. */
export const DELETE = route<P>(async (_req, v, params) => {
  const { slug } = slugParam.parse(params);
  await deletePage(v, slug);
  return { ok: true };
});
