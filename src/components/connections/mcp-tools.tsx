"use client";
/**
 * Which of an MCP server's tools the assistant may use in this graph. Read-only tools start on; tools that change
 * something start off and, even when on, ask each time (the approval card). The server's own descriptions are shown
 * as its words, quietly.
 */
import { useEffect, useState } from "react";
import { Button, Section } from "@/components/ui";
import { formatAgo, useLocale, useT } from "@/lib/i18n/client";
import { api } from "./bits";

type Tool = { name: string; title: string | null; description: string | null; writes: boolean };
type Catalog = { serverName: string | null; catalogAt: string | null; chosen: boolean; tools: Tool[]; resources: unknown[]; enabled: string[] };

export function McpTools({ connectionId, refreshKey }: { connectionId: string; refreshKey?: string | null }) {
  const t = useT();
  const locale = useLocale();
  const [cat, setCat] = useState<Catalog | null>(null);
  const [on, setOn] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let gone = false;
    api<Catalog>(`/api/connections/${connectionId}/tools`).then((c) => { if (!gone) { setCat(c); setOn(new Set(c.enabled)); } }).catch(() => {});
    return () => { gone = true; };
  }, [connectionId, refreshKey]);

  const save = async () => {
    setBusy(true); setError(null); setSaved(false);
    try {
      const r = await api<{ enabled: string[] }>(`/api/connections/${connectionId}/tools`, { method: "PATCH", json: { enabled: [...on] } });
      setOn(new Set(r.enabled));
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("connections.errors.generic"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={t("mcp.tools.title")}>
      <p className="mb-4 max-w-[65ch] text-sm text-muted">{t("mcp.tools.lead")}</p>
      {!cat || cat.tools.length === 0 ? <p className="text-sm text-muted">{t("mcp.tools.none")}</p> : (
        <>
          <ul className="divide-y divide-line rounded-lg bg-surface">
            {cat.tools.map((tool) => {
              const id = `tool-${connectionId}-${tool.name}`;
              return (
                <li key={tool.name} className="flex items-start gap-3 px-4 py-3">
                  <input id={id} type="checkbox" className="mt-1 size-4 accent-[var(--accent)]" checked={on.has(tool.name)} disabled={busy}
                    onChange={(e) => { setSaved(false); setOn((s) => { const n = new Set(s); if (e.target.checked) n.add(tool.name); else n.delete(tool.name); return n; }); }} />
                  <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
                    <span className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-medium">{tool.title ?? tool.name}</span>
                      <code className="text-xs text-muted">{tool.name}</code>
                      <span className={tool.writes ? "text-sm text-warn" : "text-sm text-muted"}>{tool.writes ? t("mcp.tools.writes") : t("mcp.tools.reads")}</span>
                    </span>
                    {tool.description && <span className="mt-0.5 block max-w-[70ch] text-sm text-muted" title={t("mcp.tools.serverSays")}>{tool.description}</span>}
                  </label>
                </li>
              );
            })}
          </ul>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button size="sm" onClick={() => void save()} disabled={busy}>{t("mcp.tools.save")}</Button>
            {saved && <span role="status" className="text-sm text-muted">{t("mcp.tools.saved")}</span>}
            {cat.catalogAt && <span className="text-sm text-muted">{t("mcp.tools.readAt", { ago: formatAgo(cat.catalogAt, locale) })}</span>}
          </div>
          {cat.resources.length > 0 && <p className="mt-2 text-sm text-muted">{t("mcp.tools.resources", { count: cat.resources.length })}</p>}
          <p className="mt-2 max-w-[65ch] text-xs text-muted">{t("mcp.data")}</p>
          {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
        </>
      )}
    </Section>
  );
}
