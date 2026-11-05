import type { MessageTree } from "../../core";

/** "onboarding" namespace (en): the first-run panel on Today. t("onboarding.<key>"). Family wording only in a family graph. */
const messages: MessageTree = {
  titleFamily: "How the assistant works in your family graph",
  title: "How the assistant works in {graph}",
  tryTitle: "Try asking",
  step: "Step {step} of {total}",
  introFamily: "It reads the family's calendar, letters, people and pages here, and only what you are allowed to see. It suggests; you decide.",
  intro: "Only what is in {graph} is used. Nothing from your other graphs comes in, and nothing from here goes out. It suggests; you decide.",
  canDo: "What it can do",
  canAnswer: "Answer questions, with a link to where each answer came from",
  canSuggestFamily: "Suggest reminders, facts and family rules, which wait here until you approve them",
  canSuggest: "Suggest reminders, facts and changes to your graph, which wait here until you approve them",
  canCheckIn: "Check in on a schedule and tell you what changed, without changing anything itself",
  settingsTitle: "Your settings to start with",
  memory: {
    label: "Memory:",
    value: "looked after by the Brain Keeper",
    hintFamily: "Preferences you mention, like “no plans on Sunday evenings”, are kept without stopping to ask. The Brain Keeper checks them, merges repeats, and anything taken only from a document waits for you.",
    hint: "Preferences you mention, like “updates on Mondays”, are kept without stopping to ask. The Brain Keeper checks them, merges repeats, and anything taken only from a document waits for you.",
    link: "See and edit them under Memory",
  },
  facts: {
    label: "Changes your graph without asking:",
    value: "never",
    hint: "Every new fact, person or connection is proposed first and waits for you to approve it. This can't be turned off.",
  },
  checkIn: {
    label: "Check-ins:",
    on: "every hour, 07:00 to 20:00",
    off: "off",
    hintOnFamily: "It looks for new letters, deadlines and birthdays, and only suggests.",
    hintOn: "It looks for new files, mail and deadlines, and only suggests.",
    hintOff: "Turn on to have it look every hour, 07:00 to 20:00, every day. It only suggests.",
    switch: "Daily check-ins",
  },
  cap: {
    before: "At most",
    after: { one: "suggestion a day", other: "suggestions a day" },
    hint: "So it never nags. Anything you deny, it won't suggest again.",
    label: "Suggestions a day at most",
  },
  questionsFamily: "Questions from what is already in your family graph:",
  questions: "Questions from what is already in {graph}:",
  tip: {
    title: "Be specific",
    body: "Name the person, the day and what you want back. You get a sharper answer and fewer follow-up questions.",
    instead: "Instead of",
    try: "Try",
  },
  next: "Next: try asking",
  skip: "Skip, I'll look around",
  done: "Done",
  later: "You can change all of this later under Automations.",
  error: {
    save: "That didn't save. Try again.",
    offline: "We couldn't reach My Graph. Check your connection.",
  },
};

export default messages;
