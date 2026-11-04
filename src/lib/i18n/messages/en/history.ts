import type { MessageTree } from "../../core";

/** "history" namespace (en): what changed, and who said what. t("history.<key>"). */
const messages: MessageTree = {
  title: "What changed",
  empty: "No changes to {name} have been recorded yet.",
  showProposal: "See the proposal",
  more: { one: "and {count} earlier change", other: "and {count} earlier changes" },
  actor: { person: "Someone", assistant: "The assistant", connector: "A connection", import: "An import", system: "My Graph" },
  kind: {
    created: "{who} added it",
    updated: "{who} changed {field}",
    updatedNoField: "{who} changed it",
    retired: "{who} retired it",
    restored: "{who} brought it back",
    merged: "{who} merged something into it",
    added: "{who} added {field}",
    removed: "{who} removed {field}",
    other: "{who}: {kind}",
  },
  field: {
    label: "the name", summary: "the summary", aliases: "the other names", visibility: "who can see it", sensitive: "sensitivity",
    kind: "the kind", startAt: "the date", endAt: "the end date", status: "the status", confidence: "how sure we are", relation: "the relation",
  },
  fromTo: "from {from} to {to}",
  toOnly: "to {to}",
  empty_value: "nothing",
  yes: "yes",
  no: "no",

  whoSaid: {
    title: "Who said so",
    lead: "Everyone and everything that told the graph about {name}.",
    records: { one: "{count} record", other: "{count} records" },
    last: "last {date}",
    assistant: "The assistant",
    rules: "Built-in rules",
    formerMember: "A former member",
  },
};

export default messages;
