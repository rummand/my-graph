import type { MessageTree } from "../../core";

/** "push" namespace (en): iPhone notifications sent by the server (src/lib/push). Never carry sensitive text. */
const messages: MessageTree = {
  reminder: {
    title: "Reminder",
    due: "Due now",
    /** Sensitive reminders (health, a practice graph) show no title. */
    private: "You have a reminder. Open My Graph to see it.",
  },
  waiting: {
    title: "Waiting for you",
    body: { one: "1 suggestion or change is waiting for you to look at.", other: "{count} suggestions and changes are waiting for you to look at." },
    inGraph: { one: "1 suggestion or change is waiting in {graph}.", other: "{count} suggestions and changes are waiting in {graph}." },
  },
  connection: {
    title: "A connection needs you",
    body: "{label} has stopped bringing things in. Open My Graph to reconnect it.",
  },
  clinical: {
    title: "Practice",
    body: "You have a new note to review.",
  },
  test: {
    title: "My Graph",
    body: "Notifications work on this iPhone.",
  },
};

export default messages;
