/**
 * The sandbox a plugin runs in (server-only). Layers, each enforced here, none trusted alone:
 *
 *  1. Node's permission model (Node 22 `--permission`): the plugin may read only its own folder (and the network guard
 *     below); it may not write files, start child processes or worker threads, load native addons or use WASI, and
 *     `process.binding` is closed. Code generation from strings is off.
 *  2. The network: Node 22's permission model has no network switch (`--allow-net` came later), so a guard is loaded
 *     before the plugin (`--require`) and locks `net.Socket#connect`, `net.Server#listen`, `dgram` and `dns` in place
 *     (non-writable, non-configurable). A plugin that doesn't declare `"network"` in plugin.json gets no network at all;
 *     `"network": true` means the public internet (private and loopback addresses refused, also after DNS, unless
 *     My Graph allows private addresses in development); `"network": ["feeds.example.com", "*.example.org"]` means
 *     only those hosts. With MG_PLUGINS_PROXY set (an egress proxy that enforces its own allow-list), plugins with
 *     network get HTTPS_PROXY/HTTP_PROXY pointing at it. For hard isolation run the server in a container whose
 *     egress is limited too; see docs/plugins/README.md.
 *  3. The environment: an allow-list (PATH, HOME, TMPDIR, LANG, TZ, NODE_ENV and MG_PLUGIN_*), never the server's.
 *  4. Another user: when the server runs as root (a container), the plugin runs as MG_PLUGIN_UID/MG_PLUGIN_GID (default
 *     65534, "nobody"), so it can't read the server's files even outside Node's checks.
 *  5. Resources: CPU seconds (`ulimit -t`, the kernel kills it with SIGXCPU), file size (`ulimit -f`), open files,
 *     memory for Node (--max-old-space-size), wall-clock and idle time, bytes and records on stdout, 16 KB of stderr
 *     (the runner enforces those last ones).
 *
 * Executable plugins (any language) get layers 3–5 only, so they run only when the platform admin turns them on
 * explicitly with MG_PLUGINS_ALLOW_EXECUTABLE=1.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export type Env = Record<string, string | undefined>;

/** What plugin.json may say about the network. */
export type NetworkGrant = boolean | string[];

/** Environment variables a plugin may see. Everything else of the server's is dropped. */
export const ENV_ALLOW = ["PATH", "HOME", "TMPDIR", "LANG", "TZ", "NODE_ENV"] as const;

export function executablesAllowed(env: Env = process.env): boolean {
  return env.MG_PLUGINS_ALLOW_EXECUTABLE === "1";
}

/** The uid/gid to run as: only when this server is root (only root may switch), never root itself. */
export function sandboxUser(env: Env = process.env, uid: number | null = typeof process.getuid === "function" ? process.getuid() : null): { uid: number; gid: number } | null {
  if (uid !== 0) return null;
  const n = (s: string | undefined, d: number) => { const x = Number(s); return Number.isInteger(x) && x > 0 ? x : d; };
  return { uid: n(env.MG_PLUGIN_UID, 65534), gid: n(env.MG_PLUGIN_GID, 65534) };
}

/** A host pattern from plugin.json: a host name, or "*." and a domain. */
export const HOST_PATTERN = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Does `host` match one of the patterns? (Pure; mirrored in the guard below.) */
export function hostAllowed(host: string, patterns: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return patterns.some((p) => (p.startsWith("*.") ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p));
}

/** The variables that tell the guard what the plugin may reach. */
export function networkEnv(grant: NetworkGrant | undefined, env: Env = process.env): Record<string, string> {
  if (!grant || (Array.isArray(grant) && !grant.length)) return { MG_PLUGIN_NET: "none" };
  const out: Record<string, string> = Array.isArray(grant) ? { MG_PLUGIN_NET: "hosts", MG_PLUGIN_NET_HOSTS: grant.join(",") } : { MG_PLUGIN_NET: "public" };
  const proxy = env.MG_PLUGINS_PROXY?.trim();
  if (proxy) Object.assign(out, { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy, NODE_USE_ENV_PROXY: "1" });
  return out;
}

/**
 * The network guard, loaded with --require before the plugin. Plain CommonJS with no imports of ours: it runs inside
 * the plugin's process.
 */
export const GUARD_SOURCE = String.raw`'use strict';
const net = require('node:net');
const dns = require('node:dns');
const dgram = require('node:dgram');
const mode = process.env.MG_PLUGIN_NET || 'none';
const patterns = (process.env.MG_PLUGIN_NET_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const allowPrivate = process.env.MG_ALLOW_PRIVATE === '1';
const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
let proxyHost = '';
try { if (proxy) proxyHost = new URL(proxy).hostname.toLowerCase(); } catch (e) {}
function denied(what) {
  const e = new Error('This plugin may not reach ' + what + '. A plugin declares the network it needs in plugin.json ("network").');
  e.code = 'ERR_ACCESS_DENIED';
  return e;
}
function isPrivate(ip) {
  if (net.isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224 || (a === 198 && (b === 18 || b === 19));
  }
  const s = String(ip).toLowerCase();
  if (s === '::' || s === '::1') return true;
  const m = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (m) return isPrivate(m[1]);
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(s);
}
function hostOk(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (mode === 'none') return false;
  if (proxyHost && h === proxyHost) return true;
  if (net.isIP(h)) return allowPrivate || !isPrivate(h) ? mode === 'public' || patterns.includes(h) : false;
  if (mode === 'public') return allowPrivate || h !== 'localhost';
  return patterns.some((p) => (p.startsWith('*.') ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p));
}
const realLookup = dns.lookup;
function guardedLookup(host, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  if (typeof opts === 'number') opts = { family: opts };
  opts = opts || {};
  realLookup(host, Object.assign({}, opts, { all: true }), (err, addrs) => {
    if (err) return cb(err);
    const ok = addrs.filter((a) => allowPrivate || (proxyHost && host === proxyHost) || !isPrivate(a.address));
    if (!ok.length) return cb(denied(host + ' (a private network address)'));
    if (opts.all) return cb(null, ok);
    cb(null, ok[0].address, ok[0].family);
  });
}
const realConnect = net.Socket.prototype.connect;
function connect(...args) {
  let o = args[0];
  if (Array.isArray(o)) o = o[0];
  if (o === null || typeof o !== 'object') o = typeof args[0] === 'string' && !/^\d+$/.test(args[0]) ? { path: args[0] } : { port: args[0], host: args[1] };
  let err = null;
  if (o.path) err = denied('a local socket');
  else if (!hostOk(o.host || 'localhost')) err = denied(String(o.host || 'localhost'));
  if (err) { process.nextTick(() => this.destroy(err)); return this; }
  if (!net.isIP(String(o.host || '').replace(/^\[|\]$/g, '')) && typeof o === 'object') o.lookup = guardedLookup;
  return realConnect.apply(this, args);
}
const lock = (obj, key, value) => Object.defineProperty(obj, key, { value, writable: false, configurable: false, enumerable: false });
lock(net.Socket.prototype, 'connect', connect);
lock(net.Server.prototype, 'listen', function () { throw denied('a listening socket'); });
lock(dgram, 'createSocket', function () { throw denied('UDP'); });
lock(dgram.Socket.prototype, 'bind', function () { throw denied('UDP'); });
lock(dgram.Socket.prototype, 'send', function () { throw denied('UDP'); });
if (mode === 'none') {
  const no = function () { const cb = arguments[arguments.length - 1]; const e = denied('the network (DNS)'); if (typeof cb === 'function') process.nextTick(cb, e); else throw e; };
  for (const k of Object.keys(dns)) if (typeof dns[k] === 'function' && /^(lookup|resolve)/.test(k)) lock(dns, k, no);
  for (const k of Object.keys(dns.promises)) if (typeof dns.promises[k] === 'function' && /^(lookup|resolve)/.test(k)) lock(dns.promises, k, () => Promise.reject(denied('the network (DNS)')));
  for (const R of [dns.Resolver, dns.promises.Resolver]) {
    if (!R) continue;
    for (const k of Object.getOwnPropertyNames(R.prototype)) if (/^(resolve|reverse)/.test(k)) lock(R.prototype, k, no);
  }
} else {
  lock(dns, 'lookup', guardedLookup);
}
`;

/** Write the guard once to a file the plugin may read (named by its hash, so a changed guard is a new file). */
export function guardFile(dir = tmpdir()): string {
  const hash = createHash("sha256").update(GUARD_SOURCE).digest("hex").slice(0, 16);
  const folder = path.join(realpathSync(dir), "mg-plugin-guard");
  const file = path.join(folder, `guard-${hash}.cjs`);
  if (!existsSync(file)) {
    mkdirSync(folder, { recursive: true, mode: 0o755 });
    writeFileSync(file, GUARD_SOURCE, { mode: 0o444 });
  }
  return file;
}

export type SandboxPlan = { cmd: string; args: string[]; env: Record<string, string>; uid?: number; gid?: number; notes: string[] };

export type SandboxInput = {
  runtime: "node" | "executable";
  dir: string;
  entryPath: string;
  network?: NetworkGrant;
  command: string;
  memoryMb: number;
  cpuSeconds: number;
  /** The base environment (already the allow-list). */
  env: Record<string, string>;
};

/** How to start the plugin: the command line, environment and user, with every layer above that applies. */
export function sandboxPlan(p: SandboxInput, o: { env?: Env; shell?: string | null; nodePath?: string; guard?: string; uid?: number | null } = {}): SandboxPlan {
  const env = o.env ?? process.env;
  const notes: string[] = [];
  if (p.runtime === "executable" && !executablesAllowed(env)) {
    throw new Error("Plugins that aren't Node are turned off on this server. The platform admin can turn them on with MG_PLUGINS_ALLOW_EXECUTABLE=1.");
  }
  let cmd: string, args: string[];
  const childEnv = { ...p.env, ...networkEnv(p.network, env) };
  if (p.runtime === "node") {
    const guard = o.guard ?? guardFile();
    cmd = o.nodePath ?? process.execPath;
    args = [
      "--permission", `--allow-fs-read=${p.dir}`, `--allow-fs-read=${guard}`,
      `--max-old-space-size=${p.memoryMb}`, "--disallow-code-generation-from-strings",
      "--require", guard, p.entryPath, p.command,
    ];
  } else {
    cmd = p.entryPath;
    args = [p.command];
    notes.push("Executable plugin: Node's permission checks and the network guard don't apply; it runs with the environment, user and resource limits only.");
  }
  const user = sandboxUser(env, o.uid === undefined ? (typeof process.getuid === "function" ? process.getuid() : null) : o.uid);
  if (!user) notes.push("Runs as the server's own user (the server isn't root, so it can't switch to another).");

  // Resource limits through the shell's ulimit (CPU seconds, largest file, open files), then exec: same process id.
  const shell = o.shell === undefined ? (existsSync("/bin/sh") ? "/bin/sh" : null) : o.shell;
  if (shell) {
    const fileBlocks = 200 * 1024 * 2; // 200 MB in 512-byte blocks
    args = ["-c", 'ulimit -t "$0" && ulimit -f "$1" && ulimit -n 256 || exit 125; shift; exec env -u SHLVL -u PWD -u OLDPWD -u _ "$@"', String(p.cpuSeconds), String(fileBlocks), cmd, ...args];
    cmd = shell;
  } else {
    notes.push("No /bin/sh: CPU time isn't limited (the wall-clock limit still is).");
  }
  return { cmd, args, env: childEnv, ...(user ?? {}), notes };
}
