import type { MessageTree } from "../../core";

/** "changes" namespace (en): proposals (change sets) waiting for a person to decide. t("changes.<key>"). */
const messages: MessageTree = {
  title: "Proposals",
  lead: "What agents want to change in {graph}. Nothing reaches the graph until someone here decides.",
  leadFamily: "What agents want to change in your family graph. Nothing reaches the graph until someone here decides.",
  filter: { draft: "Waiting", delivered: "Added", abandoned: "Turned down", all: "All" },
  empty: "Nothing here right now.",
  emptyDraft: "Nothing is waiting for you. When the assistant, an import or a connection finds something new, it is proposed here first.",
  notReady: "Proposals can't be shown yet. This part of My Graph is still being built, so things that would be proposed are waiting.",
  count: { one: "{count} change", other: "{count} changes" },
  by: "by {name}",
  status: { draft: "Waiting for you", delivered: "Added to the graph", abandoned: "Turned down" },
  origin: {
    person: "You", assistant: "The assistant", chat: "A conversation", connector: "A connection", web: "Web research", ingest: "The library",
    automation: "An automation", heartbeat: "A check-in", keeper: "The Brain Keeper", restore: "A restore",
  },
  verdict: { outstanding: "Not added yet", landed: "Already in the graph", conflicted: "Conflicts with the graph now" },
  receipt: {
    source: "From {title}",
    sourceUntitled: "From a document",
    conversation: "From a conversation",
    web: "From the web",
    sure: "{pct}% sure",
  },
  op: {
    addNode: "Add", updateNode: "Change", retireNode: "Retire", mergeNodes: "Merge", addEdge: "Connect", updateEdge: "Change a connection",
    removeEdge: "Remove a connection", addKind: "New kind", addRelationType: "New relation", addAttribute: "New detail",
    addReminder: "Reminder", editWiki: "Edit wiki page",
  },
  excluded: "Left out",
  back: "Proposals",
  notFound: "We couldn't find that proposal",
  notFoundBody: "It may have been turned down, or it belongs to another graph.",
  decideHint: "Review each change and its evidence. Deciding happens here once proposals are fully built.",
  created: "Proposed {date}",
  deliveredAt: "Added {date}",
};

export default messages;
