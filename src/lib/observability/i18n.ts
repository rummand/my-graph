/**
 * Copy for the Admin "Errors" and "Performance" pages (server-only, English and Danish). Kept out of the client
 * dictionaries like the rest of the admin console; read through obsT(), which also falls through to the admin
 * namespace and every regular one.
 */
import type { MessageTree, TFn } from "@/lib/i18n/core";
import { getAdminT } from "@/lib/plans/i18n";
import { getLocale, makeT } from "@/lib/i18n";
import { DICTIONARIES } from "@/lib/i18n/messages";
import enAdmin from "@/lib/i18n/messages/en/admin";
import daAdmin from "@/lib/i18n/messages/da/admin";

const en: MessageTree = {
  nav: { errors: "Errors", performance: "Performance" },
  errors: {
    lead: "Server errors, answers that failed and requests slower than {seconds} seconds, grouped by cause. Only metadata is kept: the route, the kind of error, a cleaned-up message and where in the code it happened. Never what anyone wrote, sent or uploaded.",
    filters: { label: "Show", open: "Open", resolved: "Resolved", all: "All" },
    kinds: { label: "Kind", all: "All kinds", error: "Errors", status: "Failed answers", slow: "Slow requests" },
    kindName: { error: "Error", status: "Failed answer", slow: "Slow request" },
    empty: "Nothing here. Errors and slow requests show up within a minute of happening.",
    emptyResolved: "Nothing has been marked resolved yet.",
    counts: "{open} open, {last24h} seen in the last 24 hours.",
    cols: { what: "What happened", where: "Where", count: "Times", users: "People", last: "Last seen" },
    times: { one: "{count} time", other: "{count} times" },
    people: { one: "{count} person", other: "{count} people" },
    firstSeen: "First seen {when}",
    lastSeen: "Last seen {when}",
    slowTook: "Took {ms} the last time, {max} at the slowest.",
    status: "Answered {status}.",
    frames: "Where in the code",
    noFrames: "No stack trace was recorded.",
    source: { render: "While showing a page", route: "In an API call", action: "In a form action", middleware: "Before the request reached the app", request: "While answering" },
    resolve: "Mark resolved",
    reopen: "Open again",
    resolvedOn: "Resolved {when}. It opens again by itself if it happens again.",
    privacy: "Messages are cleaned before they are stored: quoted text, names in quotes, e-mail addresses, links, ids, numbers and anything that looks like a password or key are replaced. People are counted by a one-way hash.",
  },
  perf: {
    lead: "How long the server takes to answer, per page and API route, measured on every request and written down once a minute. Route names only: no addresses, people or content.",
    windows: { label: "Period", h1: "Last hour", h24: "Last 24 hours", d7: "Last 7 days" },
    tiles: { requests: "Requests", p50: "Typical (p50)", p95: "Slowest 5% (p95)", errors: "Failed answers", slow: "Slower than {seconds} s" },
    target: "Target: main pages answer in under {ms} ms (p50).",
    cols: { route: "Route", kind: "Kind", count: "Requests", p50: "p50", p95: "p95", max: "Slowest", errors: "Failed" },
    method: { PAGE: "Page load", GET: "GET", RSC: "In-app navigation", POST: "POST", PUT: "PUT", PATCH: "PATCH", DELETE: "DELETE", HEAD: "HEAD", OPTIONS: "OPTIONS", OTHER: "Other" },
    empty: "No timings yet. They appear a minute after the first requests.",
    off: "Timings are off on this server: another OpenTelemetry setup is active, or OBS_DISABLED is set.",
    pending: "The latest minute is still being collected on this server and isn't counted yet.",
    since: "Collected since {when}. Kept for {days} days.",
    overTarget: "Over target",
    ms: "{ms} ms",
    s: "{s} s",
  },
};

const da: MessageTree = {
  nav: { errors: "Fejl", performance: "Ydelse" },
  errors: {
    lead: "Fejl på serveren, svar der gik galt, og forespørgsler der tog mere end {seconds} sekunder, samlet efter årsag. Vi gemmer kun metadata: ruten, typen af fejl, en renset besked og hvor i koden det skete. Aldrig hvad nogen har skrevet, sendt eller lagt op.",
    filters: { label: "Vis", open: "Åbne", resolved: "Løste", all: "Alle" },
    kinds: { label: "Type", all: "Alle typer", error: "Fejl", status: "Svar der gik galt", slow: "Langsomme forespørgsler" },
    kindName: { error: "Fejl", status: "Svar gik galt", slow: "Langsom forespørgsel" },
    empty: "Intet her. Fejl og langsomme forespørgsler dukker op inden for et minut.",
    emptyResolved: "Intet er markeret som løst endnu.",
    counts: "{open} åbne, {last24h} set inden for det sidste døgn.",
    cols: { what: "Hvad skete der", where: "Hvor", count: "Gange", users: "Personer", last: "Sidst set" },
    times: { one: "{count} gang", other: "{count} gange" },
    people: { one: "{count} person", other: "{count} personer" },
    firstSeen: "Først set {when}",
    lastSeen: "Sidst set {when}",
    slowTook: "Tog {ms} sidste gang, {max} da det var langsomst.",
    status: "Svarede {status}.",
    frames: "Hvor i koden",
    noFrames: "Der blev ikke gemt et stakspor.",
    source: { render: "Mens en side blev vist", route: "I et API-kald", action: "I en formularhandling", middleware: "Før forespørgslen nåede appen", request: "Mens der blev svaret" },
    resolve: "Markér som løst",
    reopen: "Åbn igen",
    resolvedOn: "Løst {when}. Den åbner af sig selv, hvis det sker igen.",
    privacy: "Beskeder renses, før de gemmes: tekst i anførselstegn, e-mailadresser, links, id'er, tal og alt der ligner en adgangskode eller nøgle bliver erstattet. Personer tælles med en envejs-hash.",
  },
  perf: {
    lead: "Hvor lang tid serveren er om at svare, for hver side og API-rute, målt ved hver forespørgsel og skrevet ned en gang i minuttet. Kun rutenavne: ingen adresser, personer eller indhold.",
    windows: { label: "Periode", h1: "Seneste time", h24: "Seneste døgn", d7: "Seneste 7 dage" },
    tiles: { requests: "Forespørgsler", p50: "Typisk (p50)", p95: "Langsomste 5 % (p95)", errors: "Svar der gik galt", slow: "Langsommere end {seconds} s" },
    target: "Mål: hovedsiderne svarer på under {ms} ms (p50).",
    cols: { route: "Rute", kind: "Type", count: "Forespørgsler", p50: "p50", p95: "p95", max: "Langsomst", errors: "Gik galt" },
    method: { PAGE: "Sidevisning", GET: "GET", RSC: "Navigation i appen", POST: "POST", PUT: "PUT", PATCH: "PATCH", DELETE: "DELETE", HEAD: "HEAD", OPTIONS: "OPTIONS", OTHER: "Andet" },
    empty: "Ingen målinger endnu. De dukker op et minut efter de første forespørgsler.",
    off: "Målinger er slået fra på denne server: en anden OpenTelemetry-opsætning er aktiv, eller OBS_DISABLED er sat.",
    pending: "Det seneste minut bliver stadig indsamlet på serveren og tælles ikke med endnu.",
    since: "Indsamlet siden {when}. Gemmes i {days} dage.",
    overTarget: "Over målet",
    ms: "{ms} ms",
    s: "{s} s",
  },
};

export const OBS_MESSAGES = { en, da } as const;

/** Translator for the observability pages: "obs.*" keys here, everything else as in the admin console. */
export async function getObsT(): Promise<TFn> {
  const locale = await getLocale();
  const t = makeT(locale, { ...DICTIONARIES[locale], admin: locale === "da" ? daAdmin : enAdmin, obs: OBS_MESSAGES[locale] },
    { ...DICTIONARIES.en, admin: enAdmin, obs: OBS_MESSAGES.en });
  return t;
}

/** The admin console's translator, unchanged (re-exported so pages import one place). */
export { getAdminT };
