/**
 * Running an installed plugin (server-only): one command, one process, its messages as an async stream.
 *
 * Limits, all enforced here: a wall-clock timeout and an idle timeout (no output for a while), a cap on stdout bytes,
 * on the length of one line and on the number of RECORDs, a memory cap for Node plugins (--max-old-space-size), and
 * the process runs in its own process group so a timeout kills everything it started. The environment is scrubbed:
 * the plugin never sees My Graph's database address, keys or anything else in this server's environment; it gets only
 * PATH, a temporary HOME, LANG, TZ and MG_PLUGIN_* variables. Settings (secrets included) go in on stdin, never in
 * arguments (which other users of the machine can read in the process list) or files.
 */
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { allowPrivate } from "@/lib/connectors/ssrf";
import type { InstalledPlugin } from "./manifest";
import { inputLine, MAX_LINE, parseLine, type Command, type Message } from "./protocol";

export type RunLimits = { timeoutMs: number; idleMs: number; memoryMb: number; maxRecords: number; maxBytes: number; maxStderr: number };

export const DEFAULT_LIMITS: RunLimits = { timeoutMs: 120_000, idleMs: 60_000, memoryMb: 256, maxRecords: 2000, maxBytes: 64 * 1024 * 1024, maxStderr: 16 * 1024 };

/** Limits for one run: the plugin's own (never above the server's ceiling), shorter for spec/check/discover. */
export function limitsFor(plugin: Pick<InstalledPlugin, "limits">, command: Command, over: Partial<RunLimits> = {}): RunLimits {
  const l = plugin.limits ?? {};
  const quick = command !== "read";
  return {
    ...DEFAULT_LIMITS,
    timeoutMs: quick ? 30_000 : Math.min(600_000, (l.timeoutSeconds ?? 120) * 1000),
    memoryMb: Math.min(2048, l.memoryMb ?? DEFAULT_LIMITS.memoryMb),
    maxRecords: Math.min(50_000, l.maxRecords ?? DEFAULT_LIMITS.maxRecords),
    ...over,
  };
}

export type PluginFailure = "spawn" | "timeout" | "idle" | "limit" | "protocol" | "crashed" | "aborted";

export class PluginRunError extends Error {
  constructor(readonly failure: PluginFailure, message: string, readonly stderr = "") {
    super(message);
    this.name = "PluginRunError";
  }
}

export type RunSummary = { exitCode: number | null; records: number; stderr: string; ms: number };

/** The environment a plugin gets: nothing of the server's own. */
export function pluginEnv(plugin: Pick<InstalledPlugin, "id">): Record<string, string> {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: tmpdir(), TMPDIR: tmpdir(), LANG: "C.UTF-8", TZ: "UTC", NODE_ENV: "production",
    MG_PLUGIN_ID: plugin.id, MG_PLUGIN_PROTOCOL: "1",
    // Whether private addresses (localhost) may be fetched: only in development, as for every connector.
    MG_ALLOW_PRIVATE: allowPrivate() ? "1" : "0",
  };
}

function commandLine(plugin: Pick<InstalledPlugin, "runtime" | "entryPath">, command: Command, memoryMb: number): [string, string[]] {
  if (plugin.runtime === "node") return [process.execPath, [`--max-old-space-size=${memoryMb}`, "--disallow-code-generation-from-strings", plugin.entryPath, command]];
  return [plugin.entryPath, [command]];
}

/**
 * Run `command` and yield each message as it arrives. Throws PluginRunError when the plugin breaks a limit, writes
 * something that isn't the protocol, or exits with a failure. Breaking out of the loop kills the plugin.
 */
export async function* runPlugin(
  plugin: Pick<InstalledPlugin, "id" | "runtime" | "entryPath" | "dir" | "limits">,
  command: Command,
  input: { config: Record<string, unknown>; catalog?: unknown; state?: unknown },
  opts: { limits?: Partial<RunLimits>; signal?: AbortSignal; redact?: (s: string) => string } = {},
): AsyncGenerator<Message, RunSummary, void> {
  const limits = limitsFor(plugin, command, opts.limits);
  const t0 = Date.now();
  const [cmd, args] = commandLine(plugin, command, limits.memoryMb);
  const child = spawn(cmd, args, { cwd: plugin.dir, env: pluginEnv(plugin) as unknown as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] as const, detached: true, windowsHide: true });

  const queue: Message[] = [];
  let failure: PluginRunError | null = null;
  let exited = false;
  let exitCode: number | null = null;
  let wake: (() => void) | null = null;
  const notify = () => { const w = wake; wake = null; w?.(); };
  let stderr = "";
  let bytes = 0;
  let records = 0;
  let partial = "";
  const redact = opts.redact ?? ((s: string) => s);

  const kill = () => {
    if (exited || !child.pid) return;
    try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch { /* gone */ } }
    const hard = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } }, 2000);
    hard.unref?.();
  };
  const fail = (f: PluginFailure, message: string) => {
    if (!failure) failure = new PluginRunError(f, message, redact(stderr.slice(-2000)));
    kill();
    notify();
  };

  const wall = setTimeout(() => fail("timeout", `The plugin took longer than ${Math.round(limits.timeoutMs / 1000)} seconds and was stopped.`), limits.timeoutMs);
  let idle = setTimeout(() => fail("idle", `The plugin said nothing for ${Math.round(limits.idleMs / 1000)} seconds and was stopped.`), limits.idleMs);
  const onAbort = () => fail("aborted", "The run was stopped.");
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  if (opts.signal?.aborted) onAbort();

  child.on("error", (e) => fail("spawn", `The plugin couldn't be started: ${e.message}`));
  child.stdin.on("error", () => { /* the plugin may exit without reading */ });
  child.stdin.end(inputLine(input));

  child.stderr.on("data", (d: Buffer) => { if (stderr.length < limits.maxStderr) stderr += d.toString("utf8").slice(0, limits.maxStderr - stderr.length); });
  child.stdout.on("data", (d: Buffer) => {
    if (failure) return;
    clearTimeout(idle);
    idle = setTimeout(() => fail("idle", `The plugin said nothing for ${Math.round(limits.idleMs / 1000)} seconds and was stopped.`), limits.idleMs);
    bytes += d.length;
    if (bytes > limits.maxBytes) return fail("limit", `The plugin wrote more than ${Math.round(limits.maxBytes / 1024 / 1024)} MB.`);
    partial += d.toString("utf8");
    let nl: number;
    while ((nl = partial.indexOf("\n")) >= 0) {
      const line = partial.slice(0, nl);
      partial = partial.slice(nl + 1);
      const r = parseLine(line);
      if (!r.ok) return fail("protocol", r.error);
      if (!r.message) continue;
      if (r.message.type === "RECORD" && ++records > limits.maxRecords) return fail("limit", `The plugin sent more than ${limits.maxRecords} records in one run.`);
      queue.push(r.message);
    }
    if (partial.length > MAX_LINE) return fail("protocol", `A line is longer than ${MAX_LINE} characters.`);
    notify();
  });
  child.on("close", (code, signal) => {
    exited = true;
    exitCode = code;
    if (partial.trim()) {
      const r = parseLine(partial);
      partial = "";
      if (!r.ok) fail("protocol", r.error);
      else if (r.message) queue.push(r.message);
    }
    if (!failure && (code !== 0 || signal)) {
      failure = new PluginRunError("crashed", `The plugin stopped with ${signal ? `signal ${signal}` : `exit code ${code}`}.`, redact(stderr.slice(-2000)));
    }
    notify();
  });

  try {
    while (true) {
      if (queue.length) { yield queue.shift()!; continue; }
      if (failure) throw failure;
      if (exited) break;
      await new Promise<void>((r) => { wake = r; });
    }
  } finally {
    clearTimeout(wall);
    clearTimeout(idle);
    opts.signal?.removeEventListener("abort", onAbort);
    kill();
  }
  return { exitCode, records, stderr: redact(stderr), ms: Date.now() - t0 };
}

/** Run a command to the end and collect what it said (spec, check, discover: small answers). */
export async function collect(
  plugin: Parameters<typeof runPlugin>[0], command: Command, input: Parameters<typeof runPlugin>[2], opts: Parameters<typeof runPlugin>[3] = {},
): Promise<{ messages: Message[]; summary: RunSummary }> {
  const messages: Message[] = [];
  const it = runPlugin(plugin, command, input, opts);
  while (true) {
    const n = await it.next();
    if (n.done) return { messages, summary: n.value };
    messages.push(n.value);
  }
}
