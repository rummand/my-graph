import type { MessageTree } from "../../core";

/** "mention" namespace (da): @omtaler, kort ved hover og forslagslisten. Keys are used as t("mention.<key>"). */
const messages: MessageTree = {
  lookingUp: "Slår {label} op…",
  notVisible: "{label} er ikke i denne graf, eller du kan ikke se den.",
  you: "{label} (dig)",
  youSuffix: " (dig)",
  learning: ", en slags grafen stadig er ved at lære",
  latestBy: "{what} af {who}",
  menu: "Ting i denne graf",
  create: "Opret ny “{label}”",
  addedOnSend: "tilføjes, når du sender",
  looking: "Leder efter “{q}”…",
};

export default messages;
