import type { MessageTree } from "../../core";

/** "commitments" namespace (en): the ledger of what the household owes, is owed and was promised. */
const messages: MessageTree = {
  nav: "Commitments",
  meta: { title: "Commitments · My Graph" },
  title: "Commitments",
  lead: "What {graph} owes, is owed and was promised, from letters, mail, school and chats. Each one shows where it came from.",
  leadFamily: "What the family owes, is owed and was promised, from letters, mail, school and chats. Each one shows where it came from.",

  header: {
    nothing: "Nothing due in the coming week.",
    thisWeek: { one: "{count} this week", other: "{count} this week" },
    atRisk: { one: "{count} at risk", other: "{count} at risk" },
    overdue: { one: "{count} overdue", other: "{count} overdue" },
    open: { one: "{count} open in all", other: "{count} open in all" },
  },

  tabs: { label: "Show", all: "All open", owe: "We owe", owed: "Owed to us", promise: "Promises", done: "Done" },
  people: { label: "Whose", everyone: "Everyone", only: "Only {name}'s", nobody: "Nobody yet" },

  section: { overdue: "Overdue", at_risk: "At risk", this_week: "Coming week", later: "Later", undated: "No date yet", done: "Done" },
  sectionHint: {
    overdue: "The day has passed. Mark them done, or say what happened.",
    at_risk: "Due soon and nobody has started yet.",
    undated: "We know about these, but not when they are due.",
  },

  kind: {
    reply: "Reply", payment: "Payment", renewal: "Renewal", notice: "Notice deadline", appointment: "Appointment",
    form: "Form", deliver: "Hand in", return: "Give back", other: "To do",
  },
  direction: { owe: "We owe", owed: "Owed to us", promise: "Promise" },
  status: { open: "Open", done: "Done", cancelled: "Dropped", missed: "Missed" },

  due: {
    today: "Today", tomorrow: "Tomorrow", yesterday: "Yesterday",
    inDays: { one: "in {count} day", other: "in {count} days" },
    daysAgo: { one: "{count} day ago", other: "{count} days ago" },
    none: "No date yet", around: "around {date}", lastDay: "last day {date}",
    done: "Done {date}", dropped: "Dropped {date}",
  },
  recurrence: { daily: "Every day", weekly: "Every week", monthly: "Every month", yearly: "Every year", other: "Repeats" },

  row: {
    responsible: "Responsible: {names}", nobody: "Nobody is responsible yet", with: "with {name}", owedBy: "from {name}",
    from: "From {title}", ifMissed: "If it's missed", snoozed: "Snoozed until {date}", started: "Started {date}",
    reminder: "Reminder {date}", details: "Details", hideDetails: "Hide details", open: "Open the commitment",
    clashes: "Clashes with {name}", note: "Note: {note}", doneBy: "Done by {name}",
  },

  actions: {
    done: "Done", doneWithNote: "Done, with a note", doneTitle: "Mark “{label}” as done", reopen: "Reopen", started: "I've started",
    snooze: "Snooze", snoozeTitle: "Remind me again", snoozeTomorrow: "Tomorrow morning", snoozeIn3: "In 3 days", snoozeNextWeek: "Next Monday",
    snoozeHint: "Moves the reminder. The due date stays.",
    reassign: "Reassign", reassignTitle: "Who does it?",
    edit: "Edit", editTitle: "Change the commitment",
    drop: "Not ours", dropTitle: "Why take it off the list?",
    more: "More actions for “{label}”",
    save: "Save", cancel: "Cancel", note: "Note (optional)", notePlaceholder: "Paid from the joint account",
    labelLabel: "What has to happen", dueLabel: "Due", amountLabel: "Amount (kr)", consequenceLabel: "If it's missed", leadLabel: "Warn days before",
    noDate: "No date",
  },
  drop: { not_mine: "Not ours to do", not_a_commitment: "Not a commitment", duplicate: "Already on the list", cancelled: "Cancelled, it won't happen" },

  result: {
    done: "Marked done.", reopen: "Reopened.", snooze: "Snoozed. The reminder moved.", progress: "Noted that you've started.",
    reassign: "Reassigned.", edit: "Saved.", cancel: "Taken off the list.",
    proposed: "Saved as a proposal: someone who may change it has to deliver it.",
    next: "It repeats: the next time is waiting for you under Waiting for you.",
    failed: "That didn't work. Try again.",
    undo: "Undo",
  },

  waiting: {
    title: "Waiting for you",
    hint: "Found in letters, mail and chats. Nothing is on the list until you deliver it.",
    more: { one: "{count} more waiting", other: "{count} more waiting" },
  },

  empty: {
    title: "Nothing to keep track of yet",
    body: "Commitments appear here when a letter, a bill, a school message or a chat says something has to happen by a date: reply, pay, renew, give notice, sign, bring. Each one is proposed to you first, with the passage it came from.",
    action: "Add a letter to the library",
    filtered: "Nothing here with these filters.",
    done: "Nothing marked done in the last while.",
    clear: "Show everything",
  },

  today: {
    line: "{thisWeek}, {atRisk}",
    lineOverdue: "{overdue}, {thisWeek}, {atRisk}",
    calm: "No commitments due this week.",
    open: "Commitments",
    label: "Commitments due soon",
  },

  person: { title: "Commitments", empty: "Nothing open for {name}.", all: "All commitments" },

  detail: {
    title: "Commitment", back: "All commitments", responsible: "Responsible", with: "With", about: "About",
    from: "Where it comes from", noSource: "Added by hand, no document behind it.", due: "Due", amount: "Amount",
    consequence: "If it's missed", reminder: "Reminder", repeats: "Repeats", kind: "Kind", direction: "Which way",
    leadDays: { one: "Warns {count} day before", other: "Warns {count} days before" }, quote: "“{quote}”",
  },

  assistant: {
    list: "List the commitments on this page",
    done: "Mark a commitment done",
    snooze: "Snooze a commitment",
    reassign: "Reassign a commitment",
    filter: "Filter the commitments",
    confirmDone: "Mark “{label}” as done?",
    confirmSnooze: "Snooze “{label}” until {date}?",
    confirmReassign: "Make {name} responsible for “{label}”?",
    unknown: "There is no commitment with that id on this page.",
    unknownPerson: "There is nobody with that id in this graph.",
  },

  search: { section: "Commitments", due: "Due {date}" },
};

export default messages;
