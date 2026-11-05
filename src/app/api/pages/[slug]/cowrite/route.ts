import { NextResponse } from "next/server";
import { format } from "date-fns";
import { getAssistantSettings } from "@/lib/automations";
import { isMuxDown, MuxAuthError, MuxError, stream } from "@/lib/mux";
import { getPage, WikiError } from "@/lib/wiki";
import { gatherCowriteSources } from "@/lib/wiki/cowrite/context";
import { buildCowriteMessages, type CowriteEvent } from "@/lib/wiki/cowrite/prompt";
import { parseBody, route, slugParam } from "@/lib/wiki/http";
import { cowriteBody } from "../../schemas";

type P = { slug: string };

export const dynamic = "force-dynamic";

const MUX_DOWN = "The assistant can't be reached right now, so it can't write. Your page is unchanged. Try again in a few minutes.";

/**
 * POST /api/wiki/[slug]/cowrite { instruction, mode, pageMarkdown, selectionMarkdown? }
 * Streams the assistant's draft for this page as NDJSON: first the numbered sources it read (scoped to the asker),
 * then text deltas, then done. Nothing is saved here; the editor shows the draft as a pending change.
 */
export const POST = route<P>(async (req, v, params) => {
  const { slug } = slugParam.parse(params);
  const body = await parseBody(req, cowriteBody);
  const page = await getPage(v, slug);
  if (!page) throw new WikiError(404, "This page doesn't exist, or it hasn't been shared with you.");
  if (!page.can.edit) throw new WikiError(403, "You can read this page but not change it, so the assistant can't write in it for you.");
  const settings = await getAssistantSettings(v).catch(() => null);
  if (settings && settings.capabilities.wiki_write === false) {
    throw new WikiError(403, "Writing in the wiki is turned off for the assistant. Turn it on in the assistant's settings.");
  }

  const sources = await gatherCowriteSources(v, page, body.instruction);
  const messages = buildCowriteMessages({
    mode: body.mode, instruction: body.instruction, askedBy: v.name, today: format(new Date(), "EEEE d MMMM yyyy"),
    pageTitle: page.title, pageMarkdown: body.pageMarkdown, selectionMarkdown: body.selectionMarkdown, sources,
  });
  const sensitive = sources.some((s) => s.sensitive);

  const ac = new AbortController();
  req.signal.addEventListener("abort", () => ac.abort(), { once: true });
  const gen = stream({
    route: body.mode === "page" ? "smart" : "auto", messages, maxTokens: body.mode === "page" ? 4000 : 1800, temperature: 0.4,
    meta: { userId: v.id, agent: "wiki-cowrite", graphId: v.graphId, sensitive, traceId: crypto.randomUUID() },
    signal: ac.signal,
  });

  // Wait for the first piece so "mux is down" is a proper error response, not a broken stream.
  let first: IteratorResult<string, { model: string | null }>;
  try {
    first = await gen.next();
  } catch (e) {
    if (isMuxDown(e) || e instanceof MuxAuthError) return NextResponse.json({ error: MUX_DOWN, code: "mux_unavailable" }, { status: 503 });
    if (e instanceof MuxError) return NextResponse.json({ error: `The assistant couldn't write this: ${e.message}` }, { status: 502 });
    throw e;
  }

  const enc = new TextEncoder();
  const line = (ev: CowriteEvent) => enc.encode(JSON.stringify(ev) + "\n");
  const out = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(line({ type: "sources", sources: sources.map(({ text: _text, ...s }) => s) }));
      try {
        let r = first;
        while (!r.done) {
          if (r.value) controller.enqueue(line({ type: "delta", text: r.value }));
          r = await gen.next();
        }
        controller.enqueue(line({ type: "done", model: r.value?.model ?? null }));
      } catch (e) {
        if (!ac.signal.aborted) {
          const msg = isMuxDown(e) ? "The assistant stopped answering partway. What it wrote so far is kept as a draft." : "The assistant hit a problem partway. What it wrote so far is kept as a draft.";
          console.warn("[wiki cowrite] stream failed", e);
          try { controller.enqueue(line({ type: "error", error: msg })); } catch { /* closed */ }
        }
      } finally {
        try { controller.close(); } catch { /* already closed */ }
      }
    },
    cancel() {
      ac.abort();
    },
  });
  return new Response(out, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
});
