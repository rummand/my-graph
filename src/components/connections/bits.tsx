"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { clsx } from "clsx";
import { Baby, BookUser, Briefcase, CalendarDays, Folder, Globe, HeartPulse, House, Images, Mail, MapPin, MessagesSquare, Mic, NotebookPen, Plug, School, ScrollText, Trophy, Network, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui";
import { formatAgo, useLocale, useT } from "@/lib/i18n/client";
import type { ConnectionDTO, ConnectorInfo } from "@/lib/connectors";

export type Person = { id: string; label: string };

/** fetch JSON from our API; throws an Error with the server's plain message. */
export async function api<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(url, {
    ...rest,
    headers: { ...(json !== undefined ? { "content-type": "application/json" } : {}), ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? "That didn't go through. Try again.");
  return body as T;
}

const ICONS: Record<ConnectorInfo["icon"], LucideIcon> = {
  calendar: CalendarDays, school: School, mail: Mail, folder: Folder, globe: Globe, mic: Mic, plug: Plug,
  contacts: BookUser, photo: Images, tree: Network, trophy: Trophy, letter: ScrollText, health: HeartPulse, chat: MessagesSquare,
  note: NotebookPen, map: MapPin, work: Briefcase, home: House, baby: Baby,
};

export function ConnectorIcon({ icon, className }: { icon: ConnectorInfo["icon"]; className?: string }) {
  const I = ICONS[icon] ?? Globe;
  return <I className={clsx("size-4 shrink-0 text-muted", className)} aria-hidden />;
}

export function iconFor(connector: string): ConnectorInfo["icon"] {
  if (connector === "record") return "mic";
  if (connector === "mcp") return "plug";
  if (connector === "spond" || connector === "holdsport") return "trophy";
  if (connector === "gmail" || connector === "microsoft") return "mail";
  if (connector === "google_drive" || connector === "dropbox") return "folder";
  if (connector === "google_photos") return "photo";
  if (connector === "google_contacts" || connector === "carddav") return "contacts";
  if (connector === "digital_post") return "letter";
  if (connector === "sundhed") return "health";
  if (connector === "minuddannelse") return "school";
  if (connector === "famly") return "baby";
  if (connector === "mac") return "chat";
  if (connector === "slack") return "work";
  if (connector === "notion") return "note";
  if (connector === "home_assistant") return "home";
  if (["github", "github_oauth", "linear", "linear_oauth", "jira"].includes(connector)) return "work";
  return connector === "imap" ? "mail" : connector === "aula_calendar" || connector === "aula" ? "school" : "calendar";
}

export function StatusBadge({ status }: { status: ConnectorInfo["status"] }) {
  const t = useT();
  return <Badge tone={status === "unofficial" ? "warn" : status === "coming_soon" ? "neutral" : "accent"}>{t(`connections.badge.${status}`)}</Badge>;
}

/** Re-render every 30 seconds so "checked 4 minutes ago" stays true. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** "Up to date, checked 4 minutes ago" / "Needs you: …" / "Couldn't check … Will try again in 30 minutes." */
export function useStatusText() {
  const t = useT();
  const locale = useLocale();
  const now = useNow();
  return (c: ConnectionDTO): string => {
    const ago = (iso: string | null) => (iso ? formatAgo(iso, locale, new Date(now)) : "");
    switch (c.status) {
      case "ok": return t("connections.status.ok", { ago: ago(c.lastRunAt) });
      case "new": return t("connections.status.new");
      case "running": return t("connections.status.running");
      case "paused": return t("connections.status.paused");
      case "needs_you": {
        const detail = c.detailCode ? t(`connections.codes.${c.detailCode}`, undefined, c.detail ?? "") : c.detail ?? "";
        return t("connections.status.needs_you", { detail: detail.replace(/[.]$/, "") + "." }).replace(/\.\.$/, ".");
      }
      case "error":
        return c.nextRunAt ? t("connections.status.error", { ago: ago(c.lastRunAt), next: ago(c.nextRunAt) }) : t("connections.status.errorNoNext");
    }
  };
}

export function StatusDot({ status }: { status: ConnectionDTO["status"] }) {
  return (
    <span aria-hidden className={clsx("inline-block size-2 shrink-0 rounded-full",
      status === "ok" && "bg-accent",
      status === "needs_you" && "bg-warn",
      status === "error" && "bg-danger/70",
      (status === "paused" || status === "new") && "bg-line",
      status === "running" && "animate-pulse bg-accent motion-reduce:animate-none")} />
  );
}

export function CountsLine({ c }: { c: ConnectionDTO }) {
  const t = useT();
  const parts: string[] = [];
  if (c.counts.total === 0) parts.push(t("connections.counts.none"));
  else {
    parts.push(t("connections.counts.total", { count: c.counts.total }));
    if (c.counts.week > 0 && c.counts.week !== c.counts.total) parts.push(t("connections.counts.week", { count: c.counts.week }));
  }
  return (
    <p className="text-sm text-muted">
      {parts.join(", ")}
      {c.counts.waiting > 0 && <>{", "}<Link href="/changes" className="text-warn hover:underline">{t("connections.counts.waiting", { count: c.counts.waiting })}</Link></>}
    </p>
  );
}
