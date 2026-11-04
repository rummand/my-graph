import type { MessageTree } from "../../core";

/**
 * "memory" namespace (en): the Memory page, the memory panel on person and node pages, and the Brain Keeper's report.
 * Keys ending in `.family` / `.other` are picked by the graph's kind: family wording only in a family graph.
 */
const messages: MessageTree = {
  metaTitle: "Memory",
  title: "What the assistant remembers",
  lead: {
    family: "Family rules, preferences and notes the assistant keeps in mind when it answers you and suggests times or reminders. Nothing else is remembered between chats, and you can change or remove any of it.",
    other: "Rules, preferences and notes the assistant keeps in mind in {graph} when it answers you and suggests times or reminders. Nothing else is remembered between chats, and you can change or remove any of it.",
  },
  add: "Add something to remember",
  addedToast: "Saved. The assistant will use it from now on.",
  empty: {
    title: "Nothing remembered yet",
    action: { family: "Add a family rule", other: "Add a rule" },
    body: {
      family: "When you tell the assistant something worth keeping, like “Sunday dinner is family time” or “Grandma can always book the kids on Wednesdays”, it shows up here with where it came from. Rules found in uploaded letters wait here for you to confirm.",
      other: "When you tell the assistant something worth keeping, like “Keep status updates to five lines” or “Lars approves budget changes”, it shows up here with where it came from. Rules found in uploaded documents wait here for you to confirm.",
    },
  },
  search: "Search what's remembered",
  aboutGroup: "Show memories about",
  everyone: "Everyone",
  noMatch: "Nothing remembered matches that.",
  showAll: "Show everything",
  pending: {
    title: "Waiting for you to confirm",
    lead: {
      family: "Found in uploaded or outside documents. The assistant doesn't use these until a parent confirms them, and it never follows instructions written in a document.",
      other: "Found in uploaded or outside documents. The assistant doesn't use these until someone who can edit this graph confirms them, and it never follows instructions written in a document.",
    },
    cardTitle: "Remember this?",
    cardWhy: "It won't be used until you confirm it.",
    dismissed: "Dismissed.",
    confirmed: "Confirmed. The assistant will use it from now on.",
    appliesTo: "Applies to {names}",
    docSays: "The document says: “{quote}”",
  },
  kind: { rule: "Rule", preference: "Preference", note: "Note" },
  sections: {
    rule: { family: "Family rules", other: "Rules" },
    preference: "Preferences",
    note: "Notes",
  },
  sectionEmpty: {
    rule: {
      family: "No family rules yet. A rule like “Sunday dinner is family time” stops the assistant suggesting plans at the wrong moment.",
      other: "No rules yet. A rule like “No meetings on Friday afternoons” stops the assistant suggesting plans at the wrong moment.",
    },
    preference: "No preferences yet. Tell the assistant how you like things done, like “Keep answers short on weekdays”.",
    note: {
      family: "No notes yet. Notes are small things worth keeping in mind, like an allergy or a favourite place.",
      other: "No notes yet. Notes are small things worth keeping in mind, like who to ask about what or a favourite place.",
    },
  },
  how: {
    title: "How memory works",
    keeper: "The Brain Keeper looks after memory. When you mention a preference or a rule in chat, it decides on its next run whether it is worth keeping, updates what is already here instead of adding copies, and retires what is no longer true. Say “remember that …” and it is kept at once.",
    yours: "It never changes what you write here yourself. Anything found only in an uploaded letter, a web page or mail waits for you to confirm it. Until then it is never used.",
    source: "Each memory says where it came from. Pause one to stop the assistant using it without losing it.",
    visibility: {
      family: "Private memories are seen only by you; “Parents only” ones by the parents in this graph.",
      other: "Private memories are seen only by you; “Owner and editors” ones by the people who can edit this graph.",
    },
    mentions: "Type @ to link a person, place or project. The memory then shows up on that page too.",
  },
  visibility: {
    household: "Everyone in this graph",
    parents: { family: "Parents only", other: "Owner and editors" },
    private: "Only me",
    privateShort: "Only you",
    who: "Who can see this",
  },
  item: {
    notUsedPending: "Not used until you confirm it",
    notUsedYet: "Not used yet",
    used: "Used {time}",
    edit: "Edit",
    pause: "Pause: don't use this for now",
    resume: "Use this again",
    forget: "Forget this",
    paused: "Paused",
    save: "Save",
    saving: "Saving…",
    cancel: "Cancel",
    textLabel: "What the assistant should remember",
    writeSomething: "Write what the assistant should remember.",
  },
  composer: {
    appliesTo: "Applies to",
    alsoAppliesTo: "Also applies to",
    save: { rule: "Save rule", preference: "Save preference", note: "Save note" },
    placeholder: {
      rule: { family: "For example: Bedtime for the kids is 19:30 on school nights.", other: "For example: No meetings before 9:00." },
      preference: { family: "For example: Keep answers short on weekdays.", other: "For example: Keep answers short and to the point." },
      note: { family: "For example: Emma is allergic to hazelnuts.", other: "For example: Lars is the one to ask about the budget." },
    },
    templates: {
      family: {
        t1: { label: "Protected time", text: "Sunday dinner 17:00–19:00 is family time. Don't suggest plans then." },
        t2: { label: "Who can book the kids", text: "Grandma can always book the kids on Wednesday afternoons." },
        t3: { label: "Always…", text: "Always remind us about Aula letters the same evening." },
        t4: { label: "Never…", text: "Never suggest plans before 9:00 on weekends." },
      },
      other: {
        t1: { label: "Protected time", text: "Friday afternoons are for focused work. Don't suggest meetings then." },
        t2: { label: "Who decides", text: "Budget changes need approval from the project lead." },
        t3: { label: "Always…", text: "Always remind me about deadlines the evening before." },
        t4: { label: "Never…", text: "Never suggest plans before 9:00." },
      },
    },
    mentionHint: "Type @ to link a person, place or project.",
  },
  panel: {
    title: "What the assistant remembers",
    add: "Add",
    loading: "Loading…",
    loadError: "Couldn't load what's remembered. Reload the page to try again.",
    them: "them",
    empty: {
      family: "Nothing remembered about {name} yet. Rules and preferences about {name}, like bedtimes or who can pick them up, show up here.",
      other: "Nothing remembered about {name} yet. Rules and preferences about {name}, like how to reach them or what they decide on, show up here.",
    },
    pendingBefore: "Some of these wait for you to confirm them on the",
    pendingLink: "Memory page",
  },
  undo: "Undo",
  forgotten: "Forgotten.",
  removeFailed: "That couldn't be removed.",
  failed: "That didn't go through. Try again.",
  keeper: {
    heading: "What the Brain Keeper did",
    running: "Reading what happened since its last run…",
    lastRan: "Last ran {time}. It looks again every 15 minutes when there is something new.",
    intro: "It looks every 15 minutes at your chats and new library items, and keeps what will matter later.",
    waiting: { one: "{count} from chat waiting for its next run.", other: "{count} from chat waiting for its next run." },
    runNow: "Run now",
    runningButton: "Running…",
    starting: "Starting…",
    empty: "Nothing yet. When you mention a preference or a rule in chat, the Brain Keeper decides whether to keep it, updates what is already here instead of adding copies, and retires what is no longer true. Anything it finds only in documents waits for you.",
    verb: { wrote: "Wrote", updated: "Updated", merged: "Merged", forgot: "Retired", declined: "Didn't keep" },
    whenAsked: ", when you asked",
    onModel: ", on {model}",
    withoutModel: ", without the model",
    waitingForYou: " (waiting for you)",
    fromMemories: "From {count} memories: {list}",
    from: "From",
    loadError: "Couldn't load the Brain Keeper's report.",
    startError: "The Brain Keeper couldn't start.",
  },
};

export default messages;
