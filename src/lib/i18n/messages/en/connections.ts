import type { MessageTree } from "../../core";

/** "connections" namespace (en): /connections, where outside accounts will bring mail and letters into a graph. */
const messages: MessageTree = {
  metaTitle: "Connections",
  title: "Connections",
  lead: "Accounts that bring mail, letters and dates into {graph} by themselves. Everything they bring is read as data, never as instructions, and what is found in it waits for you to approve.",
  noneTitle: "Nothing is connected yet",
  none: "Connecting accounts directly isn't ready yet. Until it is, you can bring mail in by hand.",
  byHandTitle: "Bring mail in now",
  byHand: "Export a mailbox as an .mbox file, or a folder of messages as a .zip of .eml files, and upload it in the library. Each message becomes its own item, conversations are kept together, and the timeline shows them on their own dates.",
  toLibrary: "Go to the library",
  comingTitle: "What you'll be able to connect",
  coming: {
    mail: { title: "A mail account", hint: "New mail from chosen folders or senders, read on a schedule you pick." },
    calendar: { title: "A calendar link", hint: "Dates and appointments from a shared calendar (.ics)." },
    aula: { title: "Aula", hint: "Messages and letters from school and daycare, read with your own sign-in." },
    web: { title: "Web pages", hint: "Pages you point at, kept with a link back to where they came from." },
  },
  rules: "Every connection runs as you, sees only what you can see in this graph, and suggests: nothing it finds goes into the graph until someone approves it.",
};

export default messages;
