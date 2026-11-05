"use client";
/**
 * Apps: vendors' own MCP servers, found by name or by what they do. Connecting one opens the ordinary MCP form,
 * prefilled (address, sign-in, the app's name) and marked with the directory id. It gets no more trust than any MCP
 * connection: reading tools on, changing tools off and asking each time, unattended runs read only.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { clsx } from "clsx";
import {
  Banknote, BookOpen, Code2, FileStack, Handshake, Heart, LayoutGrid, ListChecks, Palette, Search, Video, Workflow, type LucideIcon,
} from "lucide-react";
import { Button, Input, Section } from "@/components/ui";
import { useT } from "@/lib/i18n/client";
import type { ConnectionDTO, ConnectorInfo } from "@/lib/connectors";
import {
  appsFor, categoriesOf, descriptionKey, filterApps, isConnectionOf, keyHintKey, serverUrlFor,
  type AppCategory, type DirectoryApp,
} from "@/lib/connectors/mcp/directory";
import { McpConnectForm } from "./mcp-form";

const EASE = [0.22, 1, 0.36, 1] as const;

const CATEGORY_ICONS: Record<AppCategory, LucideIcon> = {
  design: Palette, projects: ListChecks, money: Banknote, files: FileStack, sales: Handshake, meetings: Video,
  automation: Workflow, life: Heart, dev: Code2, knowledge: BookOpen,
};

export function AppsDirectory({ mcp, family, graphKind, connections, onDone }: {
  /** The MCP connector as offered in this graph (the directory is hidden without it). */
  mcp: ConnectorInfo; family: boolean; graphKind?: string | null; connections: ConnectionDTO[]; onDone: (c: ConnectionDTO) => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<AppCategory | "all" | "dk">("all");
  const [open, setOpen] = useState<string | null>(null);
  const offered = useMemo(() => appsFor(graphKind), [graphKind]);
  const cats = categoriesOf(offered);
  const hasDk = offered.some((a) => a.region === "dk");
  const shown = filterApps(offered, { category, query }, (a) => t(descriptionKey(a.id)));
  const connectedTo = (a: DirectoryApp) => connections.find((c) => c.connector === "mcp" && isConnectionOf(c.config, a)) ?? null;

  const chip = (key: AppCategory | "all" | "dk", label: string, Icon?: LucideIcon) => (
    <button key={key} type="button" aria-pressed={category === key} onClick={() => { setCategory(key); setOpen(null); }}
      className={clsx("inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm transition-colors",
        category === key ? "bg-accent-tint text-accent" : "bg-surface text-muted hover:text-fg")}>
      {Icon && <Icon className="size-3.5" aria-hidden />}{label}
    </button>
  );

  return (
    <Section title={t("apps.title")}>
      <p className="mb-4 max-w-[65ch] text-sm text-muted">{t("apps.lead")}</p>
      <div className="mb-3 flex items-center gap-2">
        <Search className="size-4 shrink-0 text-muted" aria-hidden />
        <Input type="search" value={query} onChange={(e) => { setQuery(e.target.value); setOpen(null); }} placeholder={t("apps.searchPlaceholder")}
          aria-label={t("apps.search")} className="max-w-sm" />
      </div>
      <div className="mb-4 flex flex-wrap gap-1.5" role="group" aria-label={t("apps.search")}>
        {chip("all", t("apps.all"), LayoutGrid)}
        {hasDk && chip("dk", t("apps.dk"))}
        {cats.map((c) => chip(c, t(`apps.categories.${c}`), CATEGORY_ICONS[c]))}
      </div>
      {shown.length === 0 ? <p className="text-sm text-muted">{t("apps.none")}</p> : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {shown.map((a) => {
            const conn = connectedTo(a);
            const isOpen = open === a.id;
            return (
              <li key={a.id} className={clsx("rounded-lg bg-surface px-4 py-3", isOpen && "sm:col-span-2")}>
                <AppCard app={a} connection={conn} open={isOpen} onToggle={() => setOpen(isOpen ? null : a.id)} />
                <AnimatePresence initial={false}>
                  {isOpen && (
                    <motion.div key="form" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.22, ease: EASE }} className="overflow-hidden">
                      <div className="pt-4">
                        <AppConnect app={a} mcp={mcp} family={family} onCancel={() => setOpen(null)} onDone={(c) => { onDone(c); setOpen(null); }} />
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function AppCard({ app, connection, open, onToggle }: { app: DirectoryApp; connection: ConnectionDTO | null; open: boolean; onToggle: () => void }) {
  const t = useT();
  const Icon = CATEGORY_ICONS[app.category];
  return (
    <div className="flex items-start gap-3">
      <span aria-hidden className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md bg-accent-tint text-sm font-semibold text-accent">
        {app.name.charAt(0).toUpperCase()}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-medium">{app.name}</span>
          {app.vendor !== app.name && <span className="text-sm text-muted">{t("apps.by", { vendor: app.vendor })}</span>}
        </p>
        <p className="mt-0.5 text-sm text-muted">{t(descriptionKey(app.id))}</p>
        <p className="mt-1 flex items-center gap-1 text-xs text-muted"><Icon className="size-3" aria-hidden />{t(`apps.categories.${app.category}`)}</p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        {connection
          ? <Link href={`/connections/${connection.id}`} className="rounded-full bg-accent-tint px-2.5 py-0.5 text-sm text-accent hover:underline">{t("apps.connected")}</Link>
          : !open && <Button size="sm" variant="secondary" onClick={onToggle} aria-expanded={open}>{t("apps.connect")}</Button>}
        {connection && !open && <button type="button" onClick={onToggle} className="text-xs text-muted hover:underline">{t("apps.connectAnother")}</button>}
      </div>
    </div>
  );
}

function AppConnect({ app, mcp, family, onDone, onCancel }: {
  app: DirectoryApp; mcp: ConnectorInfo; family: boolean; onDone: (c: ConnectionDTO) => void; onCancel: () => void;
}) {
  const t = useT();
  const [allowWrites, setAllowWrites] = useState(false);
  const [eu, setEu] = useState(false);
  const own = app.notes.includes("ownServer");
  const url = serverUrlFor(app, { allowWrites, eu });
  const host = (() => { try { return new URL(url || app.serverUrl.replace("{instance}", "example.com")).host; } catch { return app.vendor; } })();
  const vars = { vendor: app.vendor, host, example: app.serverUrl.replace("{instance}", "n8n.example.com") };
  const help = own ? t("apps.form.helpOwn", vars) : app.auth === "key" ? t("apps.form.helpKey", vars) : app.auth === "none" ? t("apps.form.helpNone", vars) : t("apps.form.help", vars);
  const hasKey = app.auth === "key" || app.alsoKey;
  return (
    <div className="space-y-4">
      {app.notes.length > 0 && (
        <ul className="space-y-1 text-sm">
          {app.notes.map((n) => <li key={n} className={n === "moneyMoves" ? "text-warn" : "text-muted"}>{t(`apps.notes.${n}`, { vendor: app.vendor })}</li>)}
        </ul>
      )}
      {(app.readOnlyUrl || app.euUrl) && (
        <div className="space-y-2">
          {app.readOnlyUrl && (
            <label className="flex cursor-pointer items-start gap-2.5">
              <input type="checkbox" checked={allowWrites} onChange={(e) => setAllowWrites(e.target.checked)} className="mt-1 size-4 accent-[var(--accent)]" />
              <span>
                <span className="block text-[15px]">{t("apps.form.allowWrites", vars)}</span>
                <span className="block text-sm text-muted">{t("apps.form.allowWritesHint", vars)}</span>
              </span>
            </label>
          )}
          {app.euUrl && (
            <label className="flex cursor-pointer items-start gap-2.5">
              <input type="checkbox" checked={eu} onChange={(e) => setEu(e.target.checked)} className="mt-1 size-4 accent-[var(--accent)]" />
              <span className="text-[15px]">{t("apps.form.eu", vars)}</span>
            </label>
          )}
        </div>
      )}
      {/* Keyed on the address, so a changed choice above starts the form from the new address. */}
      <McpConnectForm key={url} info={mcp} family={family} onCancel={onCancel} onDone={onDone}
        preset={{
          serverUrl: url, authMode: app.auth, label: app.name, directoryId: app.id, help,
          keyHint: hasKey ? t(keyHintKey(app.id), undefined, t("mcp.auth.keyHint")) : undefined,
          urlPlaceholder: own ? vars.example : undefined,
        }} />
      <p className="text-sm">
        <a href={app.docsUrl} target="_blank" rel="noopener noreferrer" className="text-muted underline-offset-2 hover:underline">{t("apps.docs", { vendor: app.vendor })}</a>
      </p>
    </div>
  );
}
