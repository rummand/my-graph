import type { MessageTree } from "../../core";

/** "security" namespace (en): handing access back on disconnect, and shared limits. t("security.<key>"). */
const messages: MessageTree = {
  revoke: {
    revoked: "My Graph's access was handed back to {provider}.",
    microsoft: "Microsoft has no way for an app to hand back one sign-in, so My Graph deleted its tokens; they stop working within an hour. To remove My Graph from your Microsoft account too, open {personalUrl} (personal account) or {workUrl} (work or school account).",
    noEndpoint: "{provider} has no way to hand access back, so My Graph deleted its sign-in. To end it at the server too, remove My Graph in that service's own settings.",
    failed: "{provider} couldn't be told just now, so My Graph deleted its sign-in anyway. You can also remove My Graph in your {provider} account settings.",
    failedWithUrl: "{provider} couldn't be told just now, so My Graph deleted its sign-in anyway. You can also remove My Graph at {url}.",
    none: "",
  },
  limits: {
    tooMany: { one: "That's a lot in a short time. Wait {count} second and try again.", other: "That's a lot in a short time. Wait {count} seconds and try again." },
    paste: { one: "That's a lot of pasting in a short time. Wait {count} minute and try again.", other: "That's a lot of pasting in a short time. Wait {count} minutes and try again." },
    approvals: { one: "Too many approvals asked for in a short time. Try again in {count} second.", other: "Too many approvals asked for in a short time. Try again in {count} seconds." },
  },
};

export default messages;
