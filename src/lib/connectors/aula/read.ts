/**
 * Reading Aula (network only, no DB): what changed since the cursors, ready to be stored. The connector stores what
 * these return and moves each cursor in the same transaction. Every call goes through AulaApi, which can only read.
 */
import { AulaError, type AulaApi } from "./client";
import {
  afterThread, calendarWindows, finishThreads, MAX_MESSAGE_PAGES, MAX_THREAD_PAGES, newMessages, planThreads, scanPage,
  THREADS_PER_RUN, type PostsCursor, type ThreadsCursor,
} from "./cursor";
import {
  albumsFrom, eventOf, mediaIdsFrom, messageOf, postOf, threadOf,
  type AulaAccount, type AulaAlbum, type AulaEvent, type AulaMessage, type AulaPost, type AulaThread,
} from "./mapping";

export type ThreadRead =
  | { thread: AulaThread; sensitive: false; messages: AulaMessage[] }
  | { thread: AulaThread; sensitive: true; messages: [] };

export type ThreadsRead = {
  /** In the order to store them (oldest activity first); each comes with the cursor to save after it. */
  items: { read: ThreadRead; cursor: ThreadsCursor }[];
  /** The cursor at the end of the run (latestMessageAt moved only when everything changed was read). */
  final: ThreadsCursor;
  more: boolean;
  pages: number;
};

/** Changed threads and their new messages. A sensitive thread is never opened: it comes back as a placeholder. */
export async function readThreads(api: AulaApi, cur: ThreadsCursor, opts: { since: Date; now: Date; maxThreads?: number; maxPages?: number; signal?: AbortSignal }): Promise<ThreadsRead> {
  const changed: AulaThread[] = [];
  const seen: AulaThread[] = [];
  let stop = false;
  let page = 0;
  for (; page < (opts.maxPages ?? MAX_THREAD_PAGES) && !stop; page++) {
    if (opts.signal?.aborted) break;
    const data = await api.threadsPage(page);
    const threads = (data?.threads ?? []).map(threadOf).filter((t): t is AulaThread => !!t);
    seen.push(...threads);
    const r = scanPage(threads, cur, opts.since);
    changed.push(...r.changed);
    stop = r.stop || !data?.moreMessagesExist || threads.length === 0;
  }
  const plan = planThreads(changed, opts.maxThreads ?? THREADS_PER_RUN);
  const items: ThreadsRead["items"] = [];
  let cursor = cur;
  for (const t of plan.take) {
    if (opts.signal?.aborted) break;
    let read: ThreadRead;
    if (t.sensitive) {
      read = { thread: t, sensitive: true, messages: [] };
    } else {
      try {
        read = { thread: t, sensitive: false, messages: await readThreadMessages(api, t, cur.threads?.[t.id], opts.since) };
      } catch (e) {
        // Aula wants a fresh MitID approval for this one: it is sensitive after all.
        if (e instanceof AulaError && e.kind === "stepUp") read = { thread: { ...t, sensitive: true }, sensitive: true, messages: [] };
        else throw e;
      }
    }
    cursor = afterThread(cursor, t, read.messages);
    items.push({ read, cursor });
  }
  const complete = stop && !plan.more && items.length === plan.take.length;
  return { items, final: finishThreads(cursor, seen, complete, opts.now), more: plan.more || !stop, pages: page };
}

/** A thread's messages newer than what we stored, oldest first (pages are newest first). */
export async function readThreadMessages(api: AulaApi, t: AulaThread, knownAt: string | undefined, since: Date): Promise<AulaMessage[]> {
  const out: AulaMessage[] = [];
  for (let page = 0; page < MAX_MESSAGE_PAGES; page++) {
    const data = await api.messagesPage(t.id, page);
    const raw = data?.messages ?? [];
    const msgs = raw.map(messageOf).filter((m): m is AulaMessage => !!m);
    const { fresh, reachedKnown } = newMessages(msgs, knownAt);
    const inRange = fresh.filter((m) => !m.at || m.at.getTime() >= since.getTime());
    out.push(...inRange);
    const tooOld = msgs.some((m) => m.at && m.at.getTime() < since.getTime());
    if (reachedKnown || tooOld || !data?.moreMessagesExist || raw.length === 0) break;
  }
  const unique = [...new Map(out.map((m) => [m.id, m])).values()];
  return unique.sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0));
}

/** New posts since the cursor (newest first from Aula), at most 3 pages of 10. */
export async function readPosts(api: AulaApi, cur: PostsCursor, scope: number[], since: Date): Promise<{ posts: AulaPost[]; next: PostsCursor }> {
  const floor = cur.newestAt ? Date.parse(cur.newestAt) : since.getTime();
  const posts: AulaPost[] = [];
  for (let page = 0; page < 3; page++) {
    const data = await api.posts(page * 10, 10, scope);
    const list = (data?.posts ?? []).map(postOf).filter((p): p is AulaPost => !!p);
    let old = false;
    for (const p of list) {
      if (p.at && p.at.getTime() <= floor) { old = true; continue; }
      posts.push(p);
    }
    if (old || !data?.moreMessagesExist || list.length < 10) break;
  }
  const newest = Math.max(cur.newestAt ? Date.parse(cur.newestAt) : 0, ...posts.map((p) => p.at?.getTime() ?? 0));
  return { posts: posts.reverse(), next: { newestAt: newest > 0 ? new Date(newest).toISOString() : cur.newestAt ?? null } };
}

/** Calendar events for the children in 49-day windows (lessons left out), deduplicated by id. */
export async function readCalendar(api: AulaApi, scope: number[], now: Date): Promise<AulaEvent[]> {
  if (!scope.length) return [];
  const byId = new Map<string, AulaEvent>();
  for (const w of calendarWindows(now)) {
    const list = await api.calendar(scope, w.start, w.end);
    for (const raw of Array.isArray(list) ? list : []) {
      const e = eventOf(raw);
      if (e) byId.set(e.id, e);
    }
  }
  return [...byId.values()].sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** Today's presence overview per child (raw entries keyed by the child's institution-profile id). */
export async function readPresence(api: AulaApi, account: AulaAccount): Promise<{ childId: number; name: string; entry: unknown }[]> {
  const ids = account.children.map((c) => c.institutionProfileId ?? c.id);
  if (!ids.length) return [];
  const list = await api.dailyOverview(ids);
  const out: { childId: number; name: string; entry: unknown }[] = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const ipId = Number((raw as { institutionProfile?: { id?: unknown } })?.institutionProfile?.id);
    const child = account.children.find((c) => (c.institutionProfileId ?? c.id) === ipId) ?? (account.children.length === 1 ? account.children[0] : undefined);
    if (child) out.push({ childId: child.id, name: child.name, entry: raw });
  }
  return out;
}

/** New albums (links only): the newest 20, and the media ids of the ones not seen before. */
export async function readGallery(api: AulaApi, scope: number[], known: ReadonlySet<string>): Promise<{ album: AulaAlbum; mediaIds: string[] }[]> {
  if (!scope.length) return [];
  const albums = albumsFrom(await api.albums(scope, 20));
  const out: { album: AulaAlbum; mediaIds: string[] }[] = [];
  for (const a of albums) {
    if (known.has(a.id)) continue;
    const mediaIds = mediaIdsFrom(await api.media(a.id, scope, 200).catch(() => []));
    out.push({ album: a, mediaIds });
  }
  return out.reverse();
}
