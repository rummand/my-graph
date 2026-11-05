/**
 * MinUddannelse and Meebook (unofficial, read only, family graph). Server-only.
 *
 * Weekly plans (ugeplaner) and homework (opgaver) for each child, read through Aula's own widgets with the parent's
 * existing Aula sign-in (session.ts): no second MitID sign-in, no password of its own.
 *
 * Why a connection of its own and not another stream on Aula messages: it has its own card (people look for
 * "MinUddannelse", not for a setting inside Aula), its own slower schedule (plans change a few times a week; every
 * 3 hours by default, never under an hour), and it can be paused or removed without touching messages. It needs an
 * Aula messages connection in the same graph and borrows its sign-in for the length of a run.
 *
 * Every run: borrow Aula → which children (their UNI-login ids) and which widgets this login has → for this week and
 * next: MinUddannelse /ugebrev and /opgaveliste, Meebook /relatedweekplan/all, each with its own widget token → one
 * batch per child per week → importPayload (schoolwork importer): a searchable source per child per week, read on by
 * the model, with proposed reminders for new assignments (receipts quote the assignment's line). Weeks that didn't
 * change are not handed over again; an assignment gets one reminder proposal per version.
 */
import { z } from "zod";
import { importPayload } from "@/lib/importers/server";
import { guardedTransport, type Transport } from "@/lib/mcp-client/transport";
import { ConnectorError, needsYou, willRetry } from "../../errors";
import { defineManifest } from "../../manifest";
import { cursorOf } from "../../state";
import type { Connector, RunContext } from "../../types";
import { asConnectorError } from "../aula/connector";
import { AulaError } from "../aula/client";
import { borrowAula } from "./session";
import {
  hasWidget, meebookUrl, muUrl, planBatches, providerProblem, readMeebook, readOpgaver, readUgebrev, WeekBook, weeksToRead, widgetLogin, WIDGETS,
  type SchoolCursor, type WidgetLogin,
} from "./widgets";

export const schoolConfig = z.object({
  visibility: z.enum(["private", "parents", "household"]).default("parents"),
  /** Both are read when the Aula login shows their widget; these switch one off (not in the form). */
  minuddannelse: z.boolean().default(true),
  meebook: z.boolean().default(true),
  feedHost: z.string().max(253).optional(),
});
export type SchoolConfig = z.infer<typeof schoolConfig>;

export const schoolManifest = defineManifest({
  id: "minuddannelse", version: "1", status: "unofficial", icon: "school", graphKinds: ["family"], region: "dk",
  // No sign-in of its own: it uses the Aula messages connection's sign-in.
  auth: { type: "none" },
  config: schoolConfig,
  secrets: z.object({}),
  fields: [
    { key: "visibility", kind: "visibility" },
  ],
  streams: [
    { name: "weekplans", key: "child+week", cursor: "content fingerprint per child per week", resetOn: [] },
    { name: "assignments", key: "assignment id", cursor: "reminded versions", resetOn: [] },
  ],
  schedule: { everyMinutes: 180 },
  rateLimit: { perMinute: 20, backoff: "exponential" },
  maps: { weekplans: "document", assignments: "task" },
});

/** Polite: never more often than every hour, whatever the form says. */
export const MIN_SCHOOL_MINUTES = 60;

const UA_HEADERS = { accept: "application/json", origin: "https://www.aula.dk", referer: "https://www.aula.dk/" };

async function getJson(ctx: RunContext, transport: Transport, url: string, headers: Record<string, string>, what: string): Promise<unknown> {
  await ctx.throttle();
  let res;
  try {
    res = await transport({ url, method: "GET", headers: { ...UA_HEADERS, ...headers }, signal: ctx.signal, timeoutMs: 30_000, maxBytes: 8 * 1024 * 1024 });
  } catch {
    throw willRetry(`${what} couldn't be reached.`, "network");
  }
  if (res.status === 429) throw willRetry(`${what} asked us to slow down.`, "rateLimited");
  if (res.status >= 500) throw willRetry(`${what} had a problem (HTTP ${res.status}).`, "serverError");
  if (res.status !== 200) throw willRetry(`${what} answered HTTP ${res.status}. This connection is unofficial and may have stopped working.`, "schoolworkChanged");
  let data: unknown;
  try { data = JSON.parse(res.body.toString("utf8")); } catch { throw willRetry(`${what} didn't answer with data.`, "schoolworkChanged"); }
  const problem = providerProblem(data);
  if (problem) throw willRetry(`${what}: ${problem.slice(0, 160)}`, "schoolworkChanged");
  return data;
}

export async function syncSchool(ctx: RunContext<SchoolConfig>, transport: Transport = guardedTransport()): Promise<void> {
  if (ctx.viewer.graphKind !== "family") throw needsYou("MinUddannelse and Meebook are only read into a family graph.", "badConfig");
  const last = ctx.state().streams?.weekplans?.updatedAt;
  if (last && ctx.now.getTime() - Date.parse(last) < (MIN_SCHOOL_MINUTES - 5) * 60_000) {
    ctx.log("Read less than an hour ago; MinUddannelse and Meebook are asked at most once an hour.");
    return;
  }
  const aula = await borrowAula(ctx as unknown as RunContext, transport);
  try {
    const [byLogin, context] = await Promise.all([aula.api.profilesByLogin(), aula.api.profileContext()]);
    const login: WidgetLogin = widgetLogin(byLogin, context);
    if (!login.children.length) { ctx.log("Aula lists no children with a UNI-login on this sign-in."); return; }
    ctx.log(`Children: ${login.children.map((c) => c.name.split(/\s+/)[0]).join(", ")}.`);
    const weeks = weeksToRead(ctx.now);
    const book = new WeekBook(login.children);
    const tokens = new Map<string, string>();
    const token = async (ids: readonly string[]) => {
      const id = login.widgets ? ids.find((x) => login.widgets!.has(x)) ?? ids[0] : ids[0];
      if (!tokens.has(id)) tokens.set(id, await aula.widgetToken(id));
      return tokens.get(id)!;
    };
    const attempt = async (what: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (e) {
        if (e instanceof ConnectorError && e.kind === "needs_you") throw e;
        if (e instanceof AulaError && (e.kind === "auth" || e.kind === "deactivated")) throw e;
        if ((e as { name?: string }).name === "AbortError") throw e;
        ctx.log(`${what}: skipped this time (${e instanceof Error ? e.message.slice(0, 200) : String(e)}).`);
        ctx.count(what === "Meebook" || what.startsWith("MinUddannelse weekly") ? "weekplans" : "assignments", "skipped");
      }
    };
    let tried = 0;
    if (ctx.config.minuddannelse !== false && login.guardianId) {
      if (hasWidget(login, WIDGETS.muPlan)) {
        tried++;
        await attempt("MinUddannelse weekly plans", async () => {
          const auth = await token(WIDGETS.muPlan);
          for (const w of weeks) ctx.count("weekplans", "fetched", readUgebrev(book, w, await getJson(ctx, transport, muUrl("ugebrev", login, w), { authorization: auth }, "MinUddannelse")));
        });
      }
      if (hasWidget(login, WIDGETS.muTasks)) {
        tried++;
        await attempt("MinUddannelse assignments", async () => {
          const auth = await token(WIDGETS.muTasks);
          for (const w of weeks) ctx.count("assignments", "fetched", readOpgaver(book, w, await getJson(ctx, transport, muUrl("opgaveliste", login, w), { authorization: auth }, "MinUddannelse")));
        });
      }
    }
    if (ctx.config.meebook !== false && hasWidget(login, WIDGETS.meebook)) {
      tried++;
      await attempt("Meebook", async () => {
        const auth = await token(WIDGETS.meebook);
        for (const w of weeks) {
          const data = await getJson(ctx, transport, meebookUrl(login, w), { authorization: auth, sessionuuid: login.guardianId ?? "", "x-version": "1.0" }, "Meebook");
          ctx.count("weekplans", "fetched", readMeebook(book, w, data));
        }
      });
    }
    if (!tried) { ctx.log("This Aula login shows neither the MinUddannelse nor the Meebook widget."); return; }

    const cur = cursorOf<SchoolCursor>(ctx.state(), "weekplans") ?? {};
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Copenhagen" }).format(ctx.now);
    const { batches, next } = planBatches(book.all(), cur, today);
    let unchanged = book.all().length - batches.length;
    for (const { externalId, batch } of batches) {
      const r = await importPayload(ctx.viewer, "schoolwork", {
        bytes: new TextEncoder().encode(JSON.stringify(batch)), title: `${batch.child}, ${batch.week}`,
        connectionId: ctx.connection.id, externalId, visibility: ctx.config.visibility ?? "parents",
      });
      if (r.duplicate) unchanged++;
      else ctx.count("weekplans", "added");
      const reminders = batch.assignments.filter((a) => a.remind).length;
      if (reminders && !r.duplicate) ctx.count("assignments", "proposed", reminders);
    }
    if (unchanged > 0) ctx.count("weekplans", "unchanged", unchanged);
    await ctx.commit("weekplans", next, async () => {});
  } finally {
    await aula.release();
  }
}

export const schoolConnector: Connector<SchoolConfig> = {
  manifest: schoolManifest,
  describe() { return { feedHost: "aula.dk" }; },
  async sync(ctx) {
    try {
      await syncSchool(ctx);
    } catch (e) {
      throw asConnectorError(e);
    }
  },
};
