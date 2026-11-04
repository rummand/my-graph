import type { MessageTree } from "../../core";

/** Words used everywhere. t("common.<key>"). */
const messages: MessageTree = {
  save: "Save",
  saving: "Saving…",
  saved: "Saved.",
  cancel: "Cancel",
  close: "Close",
  back: "Back",
  continue: "Continue",
  edit: "Edit",
  remove: "Remove",
  open: "Open",
  more: "More",
  loading: "Loading…",
  signOut: "Sign out",
  signIn: "Sign in",
  couldNotSave: "Couldn't save. Try again.",
  somethingWrong: "Something went wrong. Try again.",
  you: "You",
  today: "Today",
  yesterday: "Yesterday",
  justNow: "just now",
  ago: "{time} ago",
  roles: { owner: "Owner", parent: "Parent", child: "Child", guest: "Guest" },
  approval: {
    approve: "Approve",
    deny: "Deny",
    saving: "Saving…",
    saved: "Saved.",
    open: "Open",
    dismissed: "Dismissed. It won't suggest this again.",
    alwaysAfter: " It will do this without asking next time.",
    failed: "That didn't go through. Try again.",
  },
};

export default messages;
