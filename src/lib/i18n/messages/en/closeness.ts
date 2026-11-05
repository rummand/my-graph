import type { MessageTree } from "../../core";

/** "closeness" namespace (en): how close the viewer is to people, from interactions (Close / In touch / Drifting / Faded). t("closeness.<key>"). */
const messages: MessageTree = {
  band: { close: "Close", in_touch: "In touch", drifting: "Drifting", faded: "Faded" },
  kind: {
    message: "Message", email: "Email", call: "Call", meeting: "Meeting", event: "Event", photo: "Photo",
    mention: "Mentioned in a document", edit: "Changed the graph",
  },
  kindLower: {
    message: "message", email: "email", call: "call", meeting: "meeting", event: "event", photo: "photo",
    mention: "mentioned in a document", edit: "changed the graph",
  },
  showFaded: { one: "Show faded person ({count})", other: "Show faded people ({count})" },
  hideFaded: "Hide faded people",
  fadedHint: "People you haven't been in touch with for a long time. Nothing is deleted; search always finds them.",
  lastInTouch: "Last in touch",
  lastLine: "{kind} {when}",
  hint: "Last in touch {when}",
  neverHint: "No contact found yet",
  quietFor: { one: "Not in touch for a month", other: "Not in touch for {count} months" },
  timeline: "Recent contact",
  timelineEmpty: "Nothing yet. Messages, emails, calls, meetings, photos and documents that name them show up here once they are in the graph.",
  timelineWhy: "Found in what you can see in this graph; only you see this list.",
  open: "Open",
  pin: "Keep close",
  pinned: "Kept close",
  pinHint: "They won't fade for you, however long it has been.",
  unpinHint: "Let them fade again when you're not in touch.",
  pinFailed: "That didn't work. Try again.",
  nudge: "You haven't been in touch with {name} for a while",
  nudgeDetail: "Last: {kind}, {when}.",
  setting: "Remind me about people I've lost touch with",
  settingHint: "At most one gentle reminder on Today, and only about people you used to be close to. Off unless you turn it on.",
};

export default messages;
