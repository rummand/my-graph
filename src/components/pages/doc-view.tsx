"use client";
/**
 * Renders a stored TipTap document as plain React (no editor, no client JS). Used by the read view on server and
 * client. Only known node types and safe links are rendered; anything else is skipped.
 */
import { Fragment, type ReactNode } from "react";
import Link from "next/link";
import { clsx } from "clsx";
import { NodeChip, PersonChip } from "@/components/ui";
import { useT } from "@/lib/i18n/client";
import type { TFn } from "@/lib/i18n/core";
import { safeHref, type DocMark, type DocNode } from "@/lib/wiki/doc";
import { PAGE_LINK_CLASS, PROSE } from "./prose";

/** What the server knows about a mentioned node: its type, and whether this viewer may open it. */
export type MentionInfo = Map<string, { type: string; readable: boolean }>;

function withMarks(text: ReactNode, marks: DocMark[] | undefined, key: string): ReactNode {
  let out = text;
  for (const m of marks ?? []) {
    switch (m.type) {
      case "bold": out = <strong>{out}</strong>; break;
      case "italic": out = <em>{out}</em>; break;
      case "underline": out = <u>{out}</u>; break;
      case "strike": out = <s>{out}</s>; break;
      case "code": out = <code>{out}</code>; break;
      case "link": {
        const href = safeHref(m.attrs?.href);
        if (!href) break;
        const external = /^https?:/.test(href);
        out = <a href={href} {...(external ? { target: "_blank", rel: "noopener noreferrer nofollow" } : {})}>{out}</a>;
        break;
      }
    }
  }
  return <Fragment key={key}>{out}</Fragment>;
}

function render(n: DocNode, key: string, t: TFn, info?: MentionInfo): ReactNode {
  const kids = () => (n.content ?? []).map((c, i) => render(c, `${key}.${i}`, t, info));
  switch (n.type) {
    case "text": return withMarks(n.text ?? "", n.marks, key);
    case "hardBreak": return <br key={key} />;
    case "paragraph": return <p key={key}>{kids()}</p>;
    case "heading": {
      const level = Math.min(Math.max(Number(n.attrs?.level) || 2, 1), 4);
      // The page title is the h1; document headings start at h2 so the outline stays correct.
      const Tag = (["h2", "h2", "h3", "h4"] as const)[level - 1];
      return <Tag key={key}>{kids()}</Tag>;
    }
    case "bulletList": return <ul key={key}>{kids()}</ul>;
    case "orderedList": return <ol key={key} start={Number(n.attrs?.start) || undefined}>{kids()}</ol>;
    case "listItem": return <li key={key}>{kids()}</li>;
    case "taskList": return <ul key={key} data-type="taskList">{kids()}</ul>;
    case "taskItem": {
      const checked = n.attrs?.checked === true;
      return (
        <li key={key} data-type="taskItem" data-checked={checked}>
          <label className="pointer-events-none"><input type="checkbox" checked={checked} readOnly tabIndex={-1} aria-readonly aria-label={checked ? t("wiki.doc.done") : t("wiki.doc.notDone")} /></label>
          <div>{kids()}</div>
        </li>
      );
    }
    case "blockquote": return <blockquote key={key}>{kids()}</blockquote>;
    case "codeBlock": return <pre key={key}><code>{(n.content ?? []).map((c) => c.text ?? "").join("")}</code></pre>;
    case "horizontalRule": return <hr key={key} />;
    case "mention": {
      const id = String(n.attrs?.id ?? "");
      const label = String(n.attrs?.label ?? t("wiki.doc.someone"));
      const known = info?.get(id);
      const type = known?.type ?? (typeof n.attrs?.nodeType === "string" ? n.attrs.nodeType : "topic");
      const readable = known ? known.readable : true;
      // Chips use the interface face so a name reads as a thing you can open, not as part of the sentence.
      return (
        <span key={key} data-type="mention" className="font-sans not-italic">
          {type === "person"
            ? <PersonChip id={id} name={label} href={readable ? `/people/${id}` : undefined} className="align-[0.05em]" />
            : <NodeChip type={type} label={label} href={readable ? `/node/${id}` : undefined} />}
        </span>
      );
    }
    case "pageLink": {
      const slug = typeof n.attrs?.slug === "string" ? n.attrs.slug : null;
      const label = String(n.attrs?.label ?? t("wiki.doc.page"));
      const href = slug ? `/wiki/${encodeURIComponent(slug)}` : `/wiki?q=${encodeURIComponent(label)}`;
      return <Link key={key} href={href} data-type="pageLink" className={PAGE_LINK_CLASS}>{label}</Link>;
    }
    default:
      return null;
  }
}

export function DocView({ doc, mentions, className }: { doc: DocNode; mentions?: MentionInfo; className?: string }) {
  const t = useT();
  return <div className={clsx(PROSE, className)}>{(doc.content ?? []).map((c, i) => render(c, String(i), t, mentions))}</div>;
}

/** True when a document has no visible content. */
export function isEmptyDoc(doc: DocNode): boolean {
  const has = (n: DocNode): boolean =>
    (n.type === "text" && !!n.text?.trim()) || n.type === "mention" || n.type === "pageLink" || n.type === "horizontalRule" || (n.content ?? []).some(has);
  return !has(doc);
}
