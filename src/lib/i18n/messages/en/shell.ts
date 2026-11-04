import type { MessageTree } from "../../core";

/** The app frame: navigation, the ask box, the signed-in person. t("shell.<key>"). */
const messages: MessageTree = {
  meta: { description: "Your private graph, with a source for every fact." },
  nav: {
    main: "Main",
    today: "Today",
    ask: "Ask",
    people: "People",
    timeline: "Timeline",
    library: "Library",
    wiki: "Wiki",
    connections: "Connections",
    memory: "Memory",
    automations: "Automations",
    graphs: "Graphs",
    settings: "Settings",
    more: "More",
    close: "Close",
  },
  ask: {
    label: "Ask about anything in your graph",
    placeholder: "Ask anything…",
    placeholderShort: "Ask anything",
  },
  homeLabel: "Today",
  signOut: "Sign out",
};

export default messages;
