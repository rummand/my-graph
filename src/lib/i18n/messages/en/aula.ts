import type { MessageTree } from "../../core";

/** "aula" namespace (en): /connections/aula, connecting Aula messages with the Connect Aula helper. */
const messages: MessageTree = {
  metaTitle: "Connect Aula",
  title: "Connect Aula",
  lead: "Messages, posts, the calendar, pick-ups and sick days from school and daycare, read with your own MitID sign-in. Read only: My Graph never sends, answers or marks anything as read in Aula.",
  unofficial: "Unofficial: may stop working",
  unofficialWhy: "Aula has no way for parents to read their messages from another app. This uses the same route as the Aula app and the community integrations, for your own family only. When Aula changes something, it may stop until My Graph is updated.",
  familyOnly: "Aula can only be connected to a family graph. Switch to your family graph to connect it.",
  back: "All connections",

  status: {
    title: "Your Aula connection",
    connectedAs: "Connected as {name}.",
    connected: "Connected.",
    children: "Children on this login: {names}.",
    open: "See what it brought in",
    waiting: "Waiting for you to sign in with the helper.",
    needsYou: "Needs you: reconnect Aula. Make a new pairing code below and run the helper again.",
    error: "The last check didn't go through. It will try again by itself.",
    ok: "Up to date. It checks Aula every 15 minutes.",
    justConnected: "Aula is connected. The first check has started; new messages arrive in the library and proposals wait for you.",
  },

  steps: {
    title: "Sign in, step by step",
    lead: "Do this on a computer at home (Windows, Mac or Linux), on your normal home internet. Aula's sign-in refuses servers and most VPNs, which is why My Graph can't do it for you.",
    one: {
      title: "Get a pairing code",
      body: "The code tells My Graph that the sign-in coming from your computer is yours. It works once, for 15 minutes.",
      action: "Get a pairing code",
      again: "Make a new code",
      code: "Your pairing code",
      expires: "Valid until {time}.",
      expired: "This code has run out. Make a new one.",
      copy: "Copy",
      copied: "Copied",
    },
    two: {
      title: "Download and run the helper",
      body: "A small script with My Graph's address already in it. It needs Node.js 18 or newer (from nodejs.org). Open a terminal in the folder you downloaded it to and run:",
      download: "Download the helper",
      read: "It is one short file you can read before you run it. It saves nothing on your computer.",
    },
    three: {
      title: "Approve with MitID",
      body: "The helper opens Aula's own sign-in page in your browser. Sign in and approve in the MitID app as you always do. When the browser stops (the page may look empty or show an error, that's expected), copy the whole address from the address bar and paste it into the helper.",
      phone: "Use the computer's browser, not your phone with the Aula app installed: the app would take the sign-in for itself.",
    },
    four: {
      title: "Done",
      body: "The helper sends My Graph only the sign-in tokens, with your code. This page notices by itself.",
      watching: "Watching for your sign-in…",
    },
  },

  mcp: {
    title: "Already use aula-mcp?",
    body: "If you sign in to Aula with aula-mcp, export its tokens and hand them over instead of signing in again:",
  },

  how: {
    title: "What happens to your sign-in",
    mitid: "MitID stays with you: you approve on MitID's own pages and in your own MitID app. Neither the helper nor My Graph ever sees your MitID.",
    tokens: "My Graph receives only Aula's sign-in tokens. They are stored encrypted, never shown again, never written to logs and never sent to the assistant.",
    renew: "My Graph keeps the sign-in alive by itself. When Aula ends it (after some weeks, or when you sign out everywhere), the connection says “Needs you: reconnect Aula”, and you run the helper again. It never starts a MitID sign-in on its own.",
    reads: "It reads, every 15 minutes: new messages and posts, the calendar for the next 13 weeks, today's pick-ups and sick days, and new photo albums as links.",
    sensitive: "Sensitive messages (the ones Aula asks for an extra MitID approval to open) are never opened. They show as “Sensitive, open in Aula”.",
    never: "It never sends messages, reports sickness, changes pick-ups, marks messages as read or downloads photos.",
    proposals: "People, dates and deadlines it finds wait for you to approve, each with a link to the message it came from.",
  },

  visibility: {
    label: "Who can see what it brings in",
    hint: "Messages about your children. You can change this later on the connection.",
  },

  errors: {
    generic: "That didn't go through. Try again.",
  },
};

export default messages;
