/**
 * Installed plugins (server-only): only what the platform admin put in the plugin directory, never an upload. Each
 * plugin is a folder holding `plugin.json`:
 *
 *   { "id": "rss", "name": "RSS and Atom feeds", "version": "1.0.0", "protocol": 1,
 *     "runtime": "node", "entry": "index.mjs", "description": "…",
 *     "limits": { "timeoutSeconds": 120, "memoryMb": 256, "maxRecords": 2000 } }
 *
 * `runtime` is "node" (run with this server's Node, with a memory cap) or "executable" (the entry is run as it is).
 * The entry must be a file inside the plugin's folder (symlinks are resolved and must stay inside).
 *
 * Where: MG_PLUGINS_DIR. In development, when it is not set, the repo's `examples/plugin-*` folders.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { PROTOCOL_VERSION } from "./protocol";

export const pluginManifestSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/, "a plugin id is lower-case letters, digits and _"),
  name: z.string().min(1).max(80),
  version: z.string().regex(/^\d+(\.\d+){0,2}$/),
  protocol: z.literal(PROTOCOL_VERSION),
  runtime: z.enum(["node", "executable"]),
  entry: z.string().min(1).max(200).refine((s) => !path.isAbsolute(s) && !s.split(/[\\/]/).includes(".."), "the entry is a path inside the plugin's folder"),
  description: z.string().max(500).optional(),
  limits: z.object({
    timeoutSeconds: z.number().int().min(5).max(600).optional(),
    memoryMb: z.number().int().min(32).max(2048).optional(),
    maxRecords: z.number().int().min(1).max(50_000).optional(),
  }).optional(),
}).strict();
export type PluginManifest = z.infer<typeof pluginManifestSchema>;

export type InstalledPlugin = PluginManifest & { dir: string; entryPath: string };

/** The plugin directory, or null when none is configured (then nothing is installed). */
export function pluginsDir(env: Record<string, string | undefined> = process.env, cwd = process.cwd()): string | null {
  if (env.MG_PLUGINS_DIR?.trim()) return path.resolve(cwd, env.MG_PLUGINS_DIR.trim());
  if (env.NODE_ENV === "development" || env.NODE_ENV === "test") return path.resolve(cwd, "examples");
  return null;
}

/** Read one plugin folder. Throws with a plain reason when it isn't a valid plugin. */
export function readPlugin(dir: string): InstalledPlugin {
  const file = path.join(dir, "plugin.json");
  const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  const m = pluginManifestSchema.parse(raw);
  const realDir = realpathSync(dir);
  const entryPath = realpathSync(path.join(realDir, m.entry));
  if (!entryPath.startsWith(realDir + path.sep)) throw new Error(`The entry of "${m.id}" points outside its folder.`);
  if (!statSync(entryPath).isFile()) throw new Error(`The entry of "${m.id}" is not a file.`);
  return { ...m, dir: realDir, entryPath };
}

/** Every valid plugin in the directory (folders named plugin-* in the examples fallback), with problems on the side. */
export function installedPlugins(env: Record<string, string | undefined> = process.env, cwd = process.cwd()): { plugins: InstalledPlugin[]; problems: string[] } {
  const dir = pluginsDir(env, cwd);
  if (!dir || !existsSync(dir)) return { plugins: [], problems: [] };
  const examples = !env.MG_PLUGINS_DIR?.trim();
  const plugins: InstalledPlugin[] = [];
  const problems: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (examples && !name.startsWith("plugin-")) continue;
    const sub = path.join(dir, name);
    if (!statSync(sub).isDirectory() || !existsSync(path.join(sub, "plugin.json"))) continue;
    try {
      const p = readPlugin(sub);
      if (plugins.some((x) => x.id === p.id)) problems.push(`${name}: the id "${p.id}" is used twice.`);
      else plugins.push(p);
    } catch (e) {
      problems.push(`${name}: ${e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { plugins, problems };
}

export function installedPlugin(id: string, env: Record<string, string | undefined> = process.env, cwd = process.cwd()): InstalledPlugin | null {
  return installedPlugins(env, cwd).plugins.find((p) => p.id === id) ?? null;
}
