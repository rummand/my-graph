import type { MessageTree } from "../../core";

/** "mcp" namespace (en): MCP servers in Connections: signing in, the tools, approvals. */
const messages: MessageTree = {
  auth: {
    label: "How it signs in",
    oauth: "Sign in on the server's own page",
    oauthHint: "You sign in there and choose what My Graph may read. My Graph never sees your password.",
    key: "Paste an API key",
    keyHint: "Made on the server, for example under API and AI tools in Record.",
    none: "No sign-in (a public server)",
    signIn: "Sign in with {server}",
    signInAgain: "Sign in again",
    signingIn: "Opening the sign-in…",
    signedIn: "Signed in. It's reading what the server offers now.",
    serverUrl: "Server address",
    serverUrlHint: "The MCP address, usually ending in /mcp.",
    apiKey: "API key",
    apiKeySaved: "A key is saved. Leave empty to keep it.",
  },
  tools: {
    title: "What the assistant may use",
    lead: "Tools the server offers, and which ones the assistant may use in this graph. Tools that only read are on to begin with. Tools that change something at the server are off, and even when on, each use waits for your approval.",
    none: "The server hasn't been read yet. Check now to see its tools.",
    reads: "Reads",
    writes: "Changes things, asks you first",
    save: "Save choices",
    saved: "Saved",
    resources: { one: "It also offers {count} resource.", other: "It also offers {count} resources." },
    readAt: "As the server described them {ago}.",
    serverSays: "The server's own description",
  },
  approval: {
    title: "Approve this?",
    body: "{connection} asks to use “{tool}”, which changes something at {server}.",
    args: "With",
    approve: "Approve and run",
    deny: "Don't",
    done: "Done.",
    denied: "Not done.",
    expires: "This approval runs out {when}.",
  },
  data: "What the server answers is shown as data. My Graph never follows instructions in it.",
};

export default messages;
