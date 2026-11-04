/**
 * Design set tokens (pure, shared by server and client): the shape, validation, the curated font list and the
 * built-in sets. A design set guides how every artifact made in My Graph looks: colours for light and dark, a
 * display and a body font from a curated Google Fonts list, a type scale, corner radius, spacing, a logo and a
 * tone of voice the assistant writes in. `templates` holds small per-kind choices (cover style, logo, footer).
 */
import { z } from "zod";

export const ARTIFACT_KINDS = ["report", "one_pager", "deck", "brief", "profile"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/* ── Fonts ───────────────────────────────────────────────────────────────────────────────────────────── */

export type FontInfo = { family: string; category: "sans" | "serif" | "display"; weights: number[]; fallback: string };

const SANS = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
const SERIF = "ui-serif, Georgia, 'Times New Roman', serif";

/** The curated Google Fonts a design set can use (keys are the family names). */
export const FONTS: FontInfo[] = [
  { family: "Schibsted Grotesk", category: "sans", weights: [400, 500, 600, 700], fallback: SANS },
  { family: "Inter", category: "sans", weights: [400, 500, 600, 700], fallback: SANS },
  { family: "IBM Plex Sans", category: "sans", weights: [400, 500, 600, 700], fallback: SANS },
  { family: "Source Sans 3", category: "sans", weights: [400, 600, 700], fallback: SANS },
  { family: "DM Sans", category: "sans", weights: [400, 500, 600, 700], fallback: SANS },
  { family: "Manrope", category: "sans", weights: [400, 500, 600, 700], fallback: SANS },
  { family: "Work Sans", category: "sans", weights: [400, 500, 600, 700], fallback: SANS },
  { family: "Public Sans", category: "sans", weights: [400, 600, 700], fallback: SANS },
  { family: "Figtree", category: "sans", weights: [400, 500, 600, 700], fallback: SANS },
  { family: "Space Grotesk", category: "sans", weights: [400, 500, 600, 700], fallback: SANS },
  { family: "Bricolage Grotesque", category: "display", weights: [400, 600, 700], fallback: SANS },
  { family: "Archivo", category: "sans", weights: [400, 500, 600, 700], fallback: SANS },
  { family: "Sora", category: "sans", weights: [400, 600, 700], fallback: SANS },
  { family: "Nunito Sans", category: "sans", weights: [400, 600, 700], fallback: SANS },
  { family: "Open Sans", category: "sans", weights: [400, 600, 700], fallback: SANS },
  { family: "Roboto", category: "sans", weights: [400, 500, 700], fallback: SANS },
  { family: "Lato", category: "sans", weights: [400, 700], fallback: SANS },
  { family: "Montserrat", category: "sans", weights: [400, 500, 600, 700], fallback: SANS },
  { family: "Poppins", category: "sans", weights: [400, 500, 600, 700], fallback: SANS },
  { family: "Noto Sans", category: "sans", weights: [400, 600, 700], fallback: SANS },
  { family: "Literata", category: "serif", weights: [400, 600, 700], fallback: SERIF },
  { family: "Source Serif 4", category: "serif", weights: [400, 600, 700], fallback: SERIF },
  { family: "Newsreader", category: "serif", weights: [400, 500, 600, 700], fallback: SERIF },
  { family: "Fraunces", category: "serif", weights: [400, 600, 700], fallback: SERIF },
  { family: "Playfair Display", category: "serif", weights: [400, 600, 700], fallback: SERIF },
  { family: "Lora", category: "serif", weights: [400, 600, 700], fallback: SERIF },
  { family: "Merriweather", category: "serif", weights: [400, 700], fallback: SERIF },
  { family: "Libre Baskerville", category: "serif", weights: [400, 700], fallback: SERIF },
  { family: "EB Garamond", category: "serif", weights: [400, 600, 700], fallback: SERIF },
  { family: "Crimson Pro", category: "serif", weights: [400, 600, 700], fallback: SERIF },
  { family: "IBM Plex Serif", category: "serif", weights: [400, 600, 700], fallback: SERIF },
  { family: "Noto Serif", category: "serif", weights: [400, 600, 700], fallback: SERIF },
  { family: "Instrument Serif", category: "display", weights: [400], fallback: SERIF },
];

const FONT_BY_NAME = new Map(FONTS.map((f) => [f.family.toLowerCase(), f]));
export const FONT_FAMILIES = FONTS.map((f) => f.family) as [string, ...string[]];

export function fontInfo(family: string): FontInfo {
  return FONT_BY_NAME.get(family.toLowerCase()) ?? FONTS[0];
}

/** CSS font-family value for a curated font. */
export function fontStack(family: string): string {
  const f = fontInfo(family);
  return `'${f.family}', ${f.fallback}`;
}

/** One Google Fonts stylesheet URL for the given families (only curated names are ever put in it). */
export function googleFontsHref(families: string[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const name of families) {
    const f = fontInfo(name);
    if (seen.has(f.family)) continue;
    seen.add(f.family);
    const fam = encodeURIComponent(f.family).replace(/%20/g, "+");
    parts.push(f.weights.length > 1 ? `family=${fam}:wght@${f.weights.join(";")}` : `family=${fam}`);
  }
  return `https://fonts.googleapis.com/css2?${parts.join("&")}&display=swap`;
}

/** The curated font closest to a CSS font-family list (first curated name in it, else by serif/sans). */
export function nearestFont(cssFamily: string, prefer: "sans" | "serif" = "sans"): string | null {
  const names = cssFamily.split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
  for (const n of names) {
    const f = FONT_BY_NAME.get(n.toLowerCase());
    if (f) return f.family;
  }
  const lower = names.map((n) => n.toLowerCase());
  if (lower.some((n) => /helvetica|arial|system-ui|-apple-system|segoe/.test(n))) return "Inter";
  if (lower.some((n) => /garamond/.test(n))) return "EB Garamond";
  if (lower.some((n) => /georgia|times|serif$/.test(n) && n !== "sans-serif")) return prefer === "serif" ? "Source Serif 4" : "Source Serif 4";
  if (lower.some((n) => n === "sans-serif")) return "Inter";
  return null;
}

/* ── Colours ─────────────────────────────────────────────────────────────────────────────────────────── */

export const COLOR_ROLES = ["bg", "surface", "ink", "muted", "accent", "accent2", "line"] as const;
export type ColorRole = (typeof COLOR_ROLES)[number];
export type Palette = Record<ColorRole, string>;

const HEX = /^#[0-9a-f]{6}$/i;

/** "#abc" / "#AABBCC" / "rgb(1,2,3)" → "#aabbcc", or null. */
export function normalizeHex(input: string): string | null {
  const s = input.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{8}$/.test(s)) return s.slice(0, 7);
  const m = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/.exec(s);
  if (m) {
    const [r, g, b] = [m[1], m[2], m[3]].map((x) => Math.min(255, Number(x)));
    return `#${[r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
  }
  return null;
}

function rgb(hex: string): [number, number, number] {
  const h = normalizeHex(hex) ?? "#000000";
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours (1–21). */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** Mix two hex colours (t = 0 → a, 1 → b). */
export function mix(a: string, b: string, t: number): string {
  const [ra, ga, ba] = rgb(a);
  const [rb, gb, bb] = rgb(b);
  const c = (p: number, q: number) => Math.round(p + (q - p) * t).toString(16).padStart(2, "0");
  return `#${c(ra, rb)}${c(ga, gb)}${c(ba, bb)}`;
}

/** A dark palette derived from a light one (used when a website only gives one set of colours). */
export function deriveDark(light: Palette): Palette {
  const bg = mix(light.ink, "#000000", 0.55);
  const lift = (hex: string) => (luminance(hex) < 0.18 ? mix(hex, "#ffffff", 0.45) : hex);
  return {
    bg,
    surface: mix(bg, "#ffffff", 0.06),
    ink: mix(light.bg, "#ffffff", 0.3),
    muted: mix(light.muted, "#ffffff", 0.35),
    accent: lift(light.accent),
    accent2: lift(light.accent2),
    line: mix(bg, "#ffffff", 0.14),
  };
}

/* ── Tokens and templates ────────────────────────────────────────────────────────────────────────────── */

const hex = z.string().trim().transform((s, ctx) => {
  const n = normalizeHex(s);
  if (!n || !HEX.test(n)) {
    ctx.addIssue({ code: "custom", message: `"${s.slice(0, 20)}" isn't a colour. Use a hex value like #2F4BB0.` });
    return z.NEVER;
  }
  return n;
});

export const paletteSchema = z.object({
  bg: hex, surface: hex, ink: hex, muted: hex, accent: hex, accent2: hex, line: hex,
});

const LOGO_SRC = /^(data:image\/(png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+|\/api\/files\/[0-9a-f-]{36})$/i;
export const MAX_LOGO_CHARS = 400_000;

export const logoSchema = z.object({
  src: z.string().max(MAX_LOGO_CHARS, "That logo is too large. Use an image under 300 KB.").regex(LOGO_SRC, "Use an image from the library or one read from a website."),
  alt: z.string().trim().max(120).default(""),
});

export const SPACINGS = ["compact", "comfortable", "airy"] as const;

export const tokensSchema = z.object({
  colors: z.object({ light: paletteSchema, dark: paletteSchema }),
  fonts: z.object({
    display: z.enum(FONT_FAMILIES, { message: "Pick a display font from the list." }),
    body: z.enum(FONT_FAMILIES, { message: "Pick a body font from the list." }),
  }),
  /** Ratio between heading sizes. */
  scale: z.number().min(1.1, "The type scale must be between 1.1 and 1.6.").max(1.6, "The type scale must be between 1.1 and 1.6."),
  /** Body size in px. */
  baseSize: z.number().int().min(13).max(20).default(16),
  /** Corner radius in px. */
  radius: z.number().int().min(0, "Radius must be between 0 and 24.").max(24, "Radius must be between 0 and 24."),
  spacing: z.enum(SPACINGS),
  logo: logoSchema.nullable().default(null),
  /** How the assistant should write for this set. */
  tone: z.string().trim().max(400, "Keep the tone of voice under 400 characters.").default(""),
});

export type DesignTokens = z.infer<typeof tokensSchema>;

export const COVERS = ["plain", "band", "rule"] as const;
export const templateSchema = z.object({
  cover: z.enum(COVERS).default("plain"),
  showLogo: z.boolean().default(true),
  /** Shown at the foot of every page or slide. */
  footer: z.string().trim().max(120).default(""),
});
export type KindTemplate = z.infer<typeof templateSchema>;
export type Templates = Record<ArtifactKind, KindTemplate>;

export const templatesSchema = z.object({
  report: templateSchema.optional(), one_pager: templateSchema.optional(), deck: templateSchema.optional(),
  brief: templateSchema.optional(), profile: templateSchema.optional(),
}).default({}).transform((t) => fillTemplates(t as Partial<Templates>));

export function fillTemplates(t: Partial<Templates> | undefined, base?: Partial<Templates>): Templates {
  const out = {} as Templates;
  for (const k of ARTIFACT_KINDS) out[k] = { cover: "plain", showLogo: true, footer: "", ...(base?.[k] ?? {}), ...(t?.[k] ?? {}) };
  return out;
}

export type TokenWarning = { field: string; message: string };

export type TokenCheck = { ok: true; tokens: DesignTokens; warnings: TokenWarning[] } | { ok: false; errors: { field: string; message: string }[] };

/** Validate tokens, and warn (without refusing) where text would be hard to read. */
export function validateTokens(input: unknown): TokenCheck {
  const r = tokensSchema.safeParse(input);
  if (!r.success) return { ok: false, errors: r.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })) };
  return { ok: true, tokens: r.data, warnings: readabilityWarnings(r.data) };
}

export function readabilityWarnings(t: DesignTokens): TokenWarning[] {
  const out: TokenWarning[] = [];
  for (const mode of ["light", "dark"] as const) {
    const p = t.colors[mode];
    const where = mode === "light" ? "light" : "dark";
    if (contrast(p.ink, p.bg) < 4.5) out.push({ field: `colors.${mode}.ink`, message: `Text on the ${where} background is hard to read (contrast ${contrast(p.ink, p.bg).toFixed(1)}:1, aim for 4.5:1).` });
    if (contrast(p.ink, p.surface) < 4.5) out.push({ field: `colors.${mode}.surface`, message: `Text on ${where} panels is hard to read (contrast ${contrast(p.ink, p.surface).toFixed(1)}:1).` });
    if (contrast(p.muted, p.bg) < 3) out.push({ field: `colors.${mode}.muted`, message: `Secondary text on the ${where} background is faint (contrast ${contrast(p.muted, p.bg).toFixed(1)}:1, aim for 3:1).` });
    if (contrast(p.accent, p.bg) < 3) out.push({ field: `colors.${mode}.accent`, message: `The ${where} accent is hard to see on the background (contrast ${contrast(p.accent, p.bg).toFixed(1)}:1).` });
  }
  return out;
}

/* ── Built-in sets ───────────────────────────────────────────────────────────────────────────────────── */

export type DesignSetView = {
  id: string;
  name: string;
  description: string | null;
  builtin: boolean;
  version: number;
  tokens: DesignTokens;
  templates: Templates;
  sourceUrl?: string | null;
  updatedAt?: string | null;
};

export const BUILTIN_IDS = ["mygraph", "minimal", "editorial", "corporate"] as const;
export type BuiltinId = (typeof BUILTIN_IDS)[number];
export const isBuiltinId = (id: string): id is BuiltinId => (BUILTIN_IDS as readonly string[]).includes(id);

type BuiltinDef = { id: BuiltinId; name: string; description: string; versions: { tokens: DesignTokens; templates: Partial<Templates> }[] };

const BUILTINS: BuiltinDef[] = [
  {
    id: "mygraph",
    name: "My Graph",
    description: "The app's own look: lichen ground, ink text, cobalt for sources.",
    versions: [{
      tokens: {
        colors: {
          light: { bg: "#f1f3ef", surface: "#ffffff", ink: "#17201c", muted: "#5b6660", accent: "#2f4bb0", accent2: "#2f7a63", line: "#dce0da" },
          dark: { bg: "#121513", surface: "#1a1e1b", ink: "#e8ece9", muted: "#99a39d", accent: "#8fa3f0", accent2: "#74c7a8", line: "#2c322e" },
        },
        fonts: { display: "Schibsted Grotesk", body: "Literata" },
        scale: 1.25, baseSize: 16, radius: 8, spacing: "comfortable", logo: null,
        tone: "Warm, plain and specific, from a parent's point of view. Short sentences. Name people and places.",
      },
      templates: { deck: { cover: "band", showLogo: true, footer: "" }, profile: { cover: "band", showLogo: false, footer: "" } },
    }],
  },
  {
    id: "minimal",
    name: "Minimal",
    description: "Black on white, generous space, one typeface.",
    versions: [{
      tokens: {
        colors: {
          light: { bg: "#ffffff", surface: "#f6f6f4", ink: "#111111", muted: "#686868", accent: "#111111", accent2: "#8a8a8a", line: "#e6e6e3" },
          dark: { bg: "#0e0e0e", surface: "#181818", ink: "#f2f2f0", muted: "#9a9a96", accent: "#f2f2f0", accent2: "#77776f", line: "#2a2a28" },
        },
        fonts: { display: "Inter", body: "Inter" },
        scale: 1.2, baseSize: 16, radius: 2, spacing: "airy", logo: null,
        tone: "Spare and exact. Say it once, without adjectives.",
      },
      templates: {},
    }],
  },
  {
    id: "editorial",
    name: "Editorial",
    description: "A magazine page: warm paper, serif headlines, an oxblood accent.",
    versions: [{
      tokens: {
        colors: {
          light: { bg: "#fbf8f3", surface: "#f3ede4", ink: "#1d1a16", muted: "#6c6358", accent: "#a3311f", accent2: "#2e5d57", line: "#e3dacd" },
          dark: { bg: "#17140f", surface: "#211d17", ink: "#f1ebe1", muted: "#a89e90", accent: "#e88a72", accent2: "#7fb8ae", line: "#342e26" },
        },
        fonts: { display: "Fraunces", body: "Source Serif 4" },
        scale: 1.333, baseSize: 17, radius: 0, spacing: "comfortable", logo: null,
        tone: "Narrative and vivid, like a good feature: lead with the most human detail, then the facts.",
      },
      templates: { report: { cover: "rule", showLogo: true, footer: "" }, one_pager: { cover: "rule", showLogo: true, footer: "" }, deck: { cover: "rule", showLogo: true, footer: "" } },
    }],
  },
  {
    id: "corporate",
    name: "Corporate",
    description: "Clear and businesslike: navy and teal, Plex Sans, compact.",
    versions: [{
      tokens: {
        colors: {
          light: { bg: "#f5f7fa", surface: "#ffffff", ink: "#0f1b2d", muted: "#52627a", accent: "#1f4e8c", accent2: "#0e8a7e", line: "#dfe4ec" },
          dark: { bg: "#0c1420", surface: "#131d2c", ink: "#e6ecf4", muted: "#93a1b5", accent: "#7fa8e8", accent2: "#4cc2b4", line: "#24324a" },
        },
        fonts: { display: "IBM Plex Sans", body: "IBM Plex Sans" },
        scale: 1.2, baseSize: 15, radius: 6, spacing: "compact", logo: null,
        tone: "Businesslike and brief. Lead with the decision or the status, then the evidence. No filler.",
      },
      templates: {
        report: { cover: "band", showLogo: true, footer: "" }, deck: { cover: "band", showLogo: true, footer: "" },
        brief: { cover: "band", showLogo: true, footer: "" }, one_pager: { cover: "band", showLogo: true, footer: "" },
      },
    }],
  },
];

/** A built-in set at a version (latest when omitted or unknown). */
export function builtinSet(id: BuiltinId, version?: number): DesignSetView {
  const def = BUILTINS.find((b) => b.id === id)!;
  const latest = def.versions.length;
  const v = version && version >= 1 && version <= latest ? version : latest;
  const ver = def.versions[v - 1];
  return { id: def.id, name: def.name, description: def.description, builtin: true, version: v, tokens: ver.tokens, templates: fillTemplates(ver.templates) };
}

export function builtinSets(): DesignSetView[] {
  return BUILTIN_IDS.map((id) => builtinSet(id));
}

export function builtinLatestVersion(id: BuiltinId): number {
  return BUILTINS.find((b) => b.id === id)!.versions.length;
}

/** The built-in a graph starts with: Work and project graphs → Corporate, everything else → My Graph. */
export function defaultBuiltinFor(graphKind: string): BuiltinId {
  return graphKind === "work" || graphKind === "project" ? "corporate" : "mygraph";
}

/** A fresh custom set to edit, starting from a built-in. */
export function startingTokens(from: BuiltinId = "mygraph"): { tokens: DesignTokens; templates: Templates } {
  const s = builtinSet(from);
  return { tokens: structuredClone(s.tokens), templates: structuredClone(s.templates) };
}
