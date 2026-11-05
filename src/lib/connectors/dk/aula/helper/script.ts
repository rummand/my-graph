/**
 * The Connect Aula helper: one small Node script (no packages) the parent downloads from My Graph and runs on their
 * own computer at home. It keeps MitID personal: the MitID approval happens in the parent's own browser on Aula's and
 * MitID's own pages, from their own home connection; the helper only sees the one-time sign-in code Aula hands back,
 * swaps it for tokens at login.aula.dk (from home, so STIL's bot check and the browser's cross-site rules don't get in
 * the way), and posts only those tokens to My Graph with the pairing code. It writes nothing to disk and never prints
 * a token.
 *
 * Alternative: someone who already uses aula-mcp (github.com/Casperjuel/aula-mcp) can hand over its exported tokens
 * (`aula tokens export <dir>`) with `--aula-mcp <dir>`; the helper decrypts them locally and posts the same way.
 *
 * The script is kept here as text (served by /api/connections/aula/helper with My Graph's address filled in), so it
 * works in a standalone build. It is plain JavaScript without template literals so it can live in this string.
 */
export const HELPER_FILENAME = "connect-aula.mjs";

const SOURCE = String.raw`#!/usr/bin/env node
// Connect Aula to My Graph. Run on your own computer at home:  node connect-aula.mjs
//
// What it does, and only this:
//   1. Opens Aula's own sign-in page in your browser. You approve with the MitID app as usual.
//      Your MitID never passes through this script or My Graph.
//   2. You paste the address your browser lands on. The script swaps the one-time code in it for Aula tokens.
//   3. It sends those tokens to My Graph (encrypted in transit), with the pairing code My Graph showed you.
// It saves nothing on this computer and never prints the tokens.
//
// Aula's sign-in values (the Aula app's client id, scope and return address) are the ones aula-mcp uses:
// https://github.com/Casperjuel/aula-mcp (MIT License, Copyright (c) 2026 Casper Juel).
// Unofficial: Aula has no API for parents. It may stop working when Aula changes things. For your own family only.

import { createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";

const MY_GRAPH = "__MY_GRAPH_URL__";
const LANG = "__LANG__";
const AULA = {
  clientId: "_99949a54b8b65423862aac1bf629599ed64231607a",
  scope: "aula-sensitive",
  redirectUri: "https://app-private.aula.dk",
  authorizePath: "/simplesaml/module.php/oidc/authorize.php",
  tokenPath: "/simplesaml/module.php/oidc/token.php",
};

const T = {
  en: {
    intro: "Connect Aula to My Graph",
    unofficial: "Unofficial: Aula has no API for parents, so this may stop working. Personal use for your own family.",
    askCode: "Pairing code from My Graph (like ABCDE-FGHJK): ",
    open: "Opening Aula's sign-in in your browser. If nothing opens, copy this address into your browser:",
    approve: "Sign in with MitID and approve in the MitID app. Do it on this computer, not on the phone with the Aula app.",
    askUrl: "When the browser stops (the page may look empty or show an error), copy the whole address from the address bar and paste it here:\n> ",
    badUrl: "That address has no sign-in code in it. Copy the whole address from the address bar, starting with https://app-private.aula.dk",
    badState: "That address belongs to another sign-in. Run the script again.",
    swapping: "Swapping the sign-in code for Aula tokens…",
    swapFailed: "Aula didn't accept the sign-in code (it may have expired after a minute or two). Run the script again and paste the address quickly.",
    sending: "Sending the tokens to My Graph…",
    done: "Done. My Graph is connected to Aula",
    as: "as",
    children: "Children",
    next: "You can close this window. My Graph checks Aula every 15 minutes, read only.",
    failed: "My Graph said: ",
    mcpRead: "Reading the tokens exported by aula-mcp…",
    mcpFailed: "Couldn't read the aula-mcp export (tokens.json and .key in that folder).",
    http: "My Graph's address should start with https://. Stopping so the tokens don't travel unencrypted.",
  },
  da: {
    intro: "Forbind Aula med My Graph",
    unofficial: "Uofficielt: Aula har intet API for forældre, så det kan holde op med at virke. Kun til din egen familie.",
    askCode: "Parringskode fra My Graph (fx ABCDE-FGHJK): ",
    open: "Åbner Aulas login i din browser. Hvis intet åbner, så kopiér denne adresse ind i browseren:",
    approve: "Log ind med MitID og godkend i MitID-appen. Gør det på denne computer, ikke på telefonen med Aula-appen.",
    askUrl: "Når browseren stopper (siden kan se tom ud eller vise en fejl), så kopiér hele adressen fra adresselinjen og sæt den ind her:\n> ",
    badUrl: "Den adresse har ingen login-kode. Kopiér hele adressen fra adresselinjen, den starter med https://app-private.aula.dk",
    badState: "Den adresse hører til et andet login. Kør scriptet igen.",
    swapping: "Bytter login-koden til Aula-nøgler…",
    swapFailed: "Aula godtog ikke login-koden (den udløber efter et minut eller to). Kør scriptet igen og sæt adressen hurtigt ind.",
    sending: "Sender nøglerne til My Graph…",
    done: "Færdig. My Graph er forbundet med Aula",
    as: "som",
    children: "Børn",
    next: "Du kan lukke vinduet. My Graph kigger i Aula hvert kvarter, kun læsning.",
    failed: "My Graph svarede: ",
    mcpRead: "Læser nøglerne eksporteret fra aula-mcp…",
    mcpFailed: "Kunne ikke læse eksporten fra aula-mcp (tokens.json og .key i den mappe).",
    http: "My Graphs adresse skal starte med https://. Stopper, så nøglerne ikke sendes ukrypteret.",
  },
};
const t = T[LANG] || T.en;

function arg(name) {
  const i = process.argv.indexOf("--" + name);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const flag = (name) => process.argv.includes("--" + name);
const b64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const rl = readline.createInterface({ input: process.stdin, terminal: false });
const lines = [];
const waiting = [];
rl.on("line", (l) => (waiting.length ? waiting.shift()(l) : lines.push(l)));
function ask(q) {
  process.stdout.write(q);
  return new Promise((r) => (lines.length ? r(lines.shift()) : waiting.push(r)));
}

function openBrowser(url) {
  if (flag("no-open")) return;
  const cmd = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try { spawn(cmd[0], cmd[1], { stdio: "ignore", detached: true }).unref(); } catch { /* the address is printed too */ }
}

function local(u) {
  return /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(u);
}

async function signInWithBrowser(authBase) {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(16));
  const q = new URLSearchParams({
    response_type: "code", client_id: AULA.clientId, scope: AULA.scope, redirect_uri: AULA.redirectUri,
    state, code_challenge: challenge, code_challenge_method: "S256",
  });
  const url = authBase + AULA.authorizePath + "?" + q.toString();
  console.log("\n" + t.open + "\n\n  " + url + "\n");
  console.log(t.approve + "\n");
  openBrowser(url);
  const pasted = (await ask(t.askUrl)).trim();
  let back;
  try { back = new URL(pasted); } catch { throw new Error(t.badUrl); }
  const code = back.searchParams.get("code");
  if (!code) throw new Error(t.badUrl);
  if (back.searchParams.get("state") !== state) throw new Error(t.badState);
  console.log(t.swapping);
  const res = await fetch(authBase + AULA.tokenPath, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: AULA.clientId, redirect_uri: AULA.redirectUri, code_verifier: verifier }).toString(),
  });
  if (res.status !== 200) throw new Error(t.swapFailed);
  const j = await res.json();
  if (!j.access_token || !j.refresh_token) throw new Error(t.swapFailed);
  return { accessToken: j.access_token, refreshToken: j.refresh_token, expiresIn: Number(j.expires_in) || 3600 };
}

function fromAulaMcp(dir) {
  console.log(t.mcpRead);
  try {
    const env = JSON.parse(readFileSync(join(dir, "tokens.json"), "utf8"));
    const keyText = readFileSync(join(dir, ".key"), "utf8").trim();
    const key = /^[0-9a-fA-F]{64}$/.test(keyText) ? Buffer.from(keyText, "hex") : createHash("sha256").update(keyText).digest();
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(env.iv, "base64"), { authTagLength: 16 });
    d.setAuthTag(Buffer.from(env.tag, "base64"));
    const rec = JSON.parse(Buffer.concat([d.update(Buffer.from(env.ct, "base64")), d.final()]).toString("utf8"));
    const tk = rec.tokens || {};
    if (!tk.access_token || !tk.refresh_token) throw new Error("no tokens");
    return { accessToken: tk.access_token, refreshToken: tk.refresh_token, expiresAt: tk.expires_at ? tk.expires_at * 1000 : undefined };
  } catch {
    throw new Error(t.mcpFailed);
  }
}

async function main() {
  const myGraph = (arg("my-graph") || MY_GRAPH).replace(/\/$/, "");
  const authBase = (arg("auth-base") || "https://login.aula.dk").replace(/\/$/, "");
  console.log("\n" + t.intro + "\n" + t.unofficial + "\n");
  if (!myGraph.startsWith("https://") && !local(myGraph)) throw new Error(t.http);
  const pairingCode = (arg("code") || (await ask(t.askCode))).trim();
  const mcpDir = arg("aula-mcp");
  const tokens = mcpDir ? fromAulaMcp(mcpDir) : await signInWithBrowser(authBase);
  console.log(t.sending);
  const body = Object.assign({ pairingCode }, tokens, authBase !== "https://login.aula.dk" ? { aulaBase: authBase } : {});
  const res = await fetch(myGraph + "/api/connections/aula/tokens", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(t.failed + (out.error || res.status));
  const kids = out.account && out.account.children ? out.account.children.map((c) => c.name).join(", ") : "";
  console.log("\n" + t.done + (out.account && out.account.name ? " " + t.as + " " + out.account.name : "") + ".");
  if (kids) console.log(t.children + ": " + kids);
  console.log(t.next + "\n");
}

main().then(() => { rl.close(); process.exit(0); }, (e) => { console.error("\n" + (e && e.message ? e.message : e) + "\n"); rl.close(); process.exit(1); });
`;

/** The helper with My Graph's address and the person's language filled in. */
export function helperSource(myGraphUrl: string, lang: "en" | "da"): string {
  const safeUrl = myGraphUrl.replace(/["\\\n\r]/g, "");
  return SOURCE.replace("__MY_GRAPH_URL__", safeUrl).replace("__LANG__", lang);
}
