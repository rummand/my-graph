/**
 * Calling Slack's Web API with the person's user token (pure: takes the authorised `Api`). Slack answers HTTP 200 with
 * { ok: false, error } for most problems, so those are sorted here into the connector errors:
 *   invalid_auth, token_revoked, token_expired, account_inactive, not_authed → needs you (sign in again)
 *   missing_scope → needs you (sign in again and allow access)       ratelimited → try again later
 *   channel_not_found, not_in_channel, … → handed back (the caller skips that channel and says so)
 * The token never appears in a message.
 */
import { needsYou, willRetry } from "../errors";
import { bodyOf, unexpected, type Api } from "../oauth/client";

export type SlackOk<T> = { ok: true; data: T } | { ok: false; error: string };

const SIGN_IN_AGAIN = new Set(["invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive", "no_permission", "two_factor_setup_required"]);
const SKIPPABLE = new Set(["channel_not_found", "not_in_channel", "is_archived", "thread_not_found", "user_not_found"]);

export async function slackCall<T>(api: Api, base: string, method: string, params: Record<string, string | number | boolean | undefined>): Promise<SlackOk<T>> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
  const r = await api({ url: `${base}/${method}${q.size ? `?${q}` : ""}` });
  if (r.status !== 200) throw unexpected(r, "Slack", method);
  const b = bodyOf<{ ok?: boolean; error?: string } & T>(r, "Slack");
  if (b.ok) return { ok: true, data: b };
  const e = typeof b.error === "string" ? b.error : "unknown_error";
  if (SIGN_IN_AGAIN.has(e)) throw needsYou("Slack no longer accepts the sign-in. Sign in again to keep it connected.", "signInAgain");
  if (e === "missing_scope") throw needsYou("Slack says My Graph wasn't allowed to read this. Sign in again and allow access on Slack's page.", "scopeMissing");
  if (e === "ratelimited") throw willRetry("Slack asked us to slow down.", "rateLimited");
  if (e === "fatal_error" || e === "internal_error" || e === "service_unavailable" || e === "request_timeout") throw willRetry("Slack had a problem. It will try again.", "serverError");
  if (SKIPPABLE.has(e)) return { ok: false, error: e };
  throw needsYou(`Slack refused: ${e.replace(/[^a-z_]/g, "").slice(0, 60)}.`, "httpOther");
}

/** Every page of a cursor-paginated list method, up to `maxPages`. */
export async function slackPages<T, I>(api: Api, base: string, method: string, params: Record<string, string | number | boolean | undefined>, pick: (b: T) => I[] | undefined, maxPages = 25): Promise<{ items: I[]; complete: boolean; error: string | null }> {
  const items: I[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const r = await slackCall<T & { response_metadata?: { next_cursor?: string } }>(api, base, method, { ...params, cursor });
    if (!r.ok) return { items, complete: false, error: r.error };
    items.push(...(pick(r.data) ?? []));
    cursor = r.data.response_metadata?.next_cursor || undefined;
    if (!cursor) return { items, complete: true, error: null };
  }
  return { items, complete: false, error: null };
}
