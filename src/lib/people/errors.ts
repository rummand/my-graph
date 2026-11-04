/**
 * People API errors in the reader's language. The server code throws plain English (also what the iOS app and logs
 * see in English); the route wrapper swaps in the reader's language here. Unknown messages pass through unchanged.
 */
import type { TFn } from "@/lib/i18n/core";

const CODES: Record<string, string> = {
  "Send a JSON body": "sendJson",
  "Some fields need fixing": "fieldsNeedFixing",
  "Some details need fixing": "detailsNeedFixing",
  "Invalid query": "invalidQuery",
  "Only parents can change this": "onlyParents",
  "This graph uses its owner's household model. Only they can change it.": "ownersModel",
  "Something went wrong on our side. Try again in a moment.": "server",
  "That id isn't valid": "badId",
  "Unknown kind of person": "unknownKind",
  "Pick a kind from the list": "pickKind",
  "The other person isn't in your graph": "otherNotInGraph",
  "That person isn't in your graph": "personNotInGraph",
  "Unknown relation": "unknownRelation",
  "Person not found": "notFound",
  "You can't edit this person": "cantEdit",
  "Only the person who added them can change who sees them": "onlyAdderVisibility",
  "Only the person who added them can change whether they are sensitive": "onlyAdderSensitive",
  "You can't change that detail": "cantChangeDetail",
  "Pick someone or add a new person": "pickSomeone",
  "A person can't be related to themselves": "notThemselves",
  "Pick how they are, from 1 to 5": "pickScore",
  "Check-ins can't be in the future": "noFuture",
  "Write a few words": "writeWords",
};

const ACTIONS: Record<string, string> = { "add people": "addPeople", "add relationships": "addRelationships", "log check-ins": "logCheckIns" };

export function localizeError(t: TFn, message: string): string {
  const code = CODES[message];
  if (code) return t(`people.errors.${code}`, undefined, message);
  const guest = /^Guests can't (.+)$/.exec(message);
  if (guest && ACTIONS[guest[1]]) return t("people.errors.guestsCant", { what: t(`people.errors.action.${ACTIONS[guest[1]]}`) }, message);
  const viewer = /^You can look at this graph but can't (.+) in it$/.exec(message);
  if (viewer && ACTIONS[viewer[1]]) return t("people.errors.viewerCant", { what: t(`people.errors.action.${ACTIONS[viewer[1]]}`) }, message);
  return message;
}

/** The same for a body's field issues (`{ fields: [{ key, message }] }`). */
export function localizeDetails(t: TFn, details: unknown): unknown {
  const d = details as { fields?: { key: string; message: string }[] } | undefined;
  if (!d?.fields) return details;
  return { ...d, fields: d.fields.map((f) => ({ ...f, message: localizeError(t, f.message) })) };
}
