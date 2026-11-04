import type { MessageTree } from "../../core";

/** "mention" namespace (en): @mention chips, hover cards and the typeahead. Keys are used as t("mention.<key>"). */
const messages: MessageTree = {
  lookingUp: "Looking up {label}…",
  notVisible: "{label} isn't in this graph, or you can't see it.",
  you: "{label} (you)",
  youSuffix: " (you)",
  learning: ", a kind this graph is still learning",
  latestBy: "{what} by {who}",
  menu: "Things in this graph",
  create: "Create new “{label}”",
  addedOnSend: "added on Send",
  looking: "Looking for “{q}”…",
};

export default messages;
