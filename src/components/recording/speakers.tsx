"use client";
/** Who was in the meeting: each speaker in their colour, linked to their person in the graph, or "Propose as person". */
import { useState, type CSSProperties } from "react";
import Link from "next/link";
import { Check } from "lucide-react";
import { Avatar } from "@/components/ui";
import { useT } from "@/lib/i18n/client";
import { personStyle } from "@/lib/ui/person-color";
import type { SpeakerView } from "@/lib/connectors/record/recordings";

const GENERIC = /^(speaker|taler|talker|person|participant|deltager|unknown|ukendt|guest|gæst)\s*\d*$/i;

export function Speakers({ recordingId, speakers, colorKey }: { recordingId: string; speakers: SpeakerView[]; colorKey: (name: string) => string }) {
  const t = useT();
  const [proposed, setProposed] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!speakers.length) return null;

  const propose = async (name: string) => {
    setBusy(name); setError(null);
    try {
      const res = await fetch(`/api/recordings/${recordingId}/people`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
      const body = (await res.json().catch(() => ({}))) as { changeSetId?: string; error?: string };
      if (!res.ok || !body.changeSetId) throw new Error(body.error ?? t("recordings.errors.generic"));
      setProposed((p) => ({ ...p, [name]: body.changeSetId! }));
    } catch (e) {
      setError(e instanceof Error ? e.message : t("recordings.errors.generic"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-labelledby="rec-people-h">
      <h2 id="rec-people-h" className="mb-3 text-lg font-semibold">{t("recordings.people.title")}</h2>
      <ul className="space-y-3">
        {speakers.map((s) => {
          const key = colorKey(s.name);
          const generic = GENERIC.test(s.name);
          return (
            <li key={s.key} className="flex items-start gap-2.5">
              <Avatar id={key} name={s.name} size={28} className="mt-0.5" />
              <div className="min-w-0">
                <p className="font-medium" style={{ ...(personStyle(key) as CSSProperties), color: "var(--person-ink)" }}>
                  {s.personId ? <Link href={`/people/${s.personId}`} className="hover:underline">{s.name}</Link> : s.name}
                </p>
                <p className="text-sm text-muted">
                  {s.spoke ? t("recordings.people.spoke") : t("recordings.people.listed")}
                  {s.personId && s.personLabel && s.personLabel !== s.name ? `, ${t("recordings.people.inGraph", { name: s.personLabel })}` : ""}
                </p>
                {!s.personId && !generic && (
                  proposed[s.name] ? (
                    <p className="mt-1 flex flex-wrap items-center gap-1.5 text-sm text-muted" role="status">
                      <Check aria-hidden className="size-4 text-accent" />{t("recordings.people.proposed")}
                      <Link href={`/changes/${proposed[s.name]}`} className="text-accent hover:underline">{t("recordings.people.review")}</Link>
                    </p>
                  ) : (
                    <button type="button" disabled={busy === s.name} onClick={() => void propose(s.name)}
                      className="mt-1 text-sm font-medium text-accent hover:underline disabled:opacity-50">{t("recordings.people.propose")}</button>
                  )
                )}
                {generic && <p className="text-xs text-muted">{t("recordings.people.unnamed")}</p>}
              </div>
            </li>
          );
        })}
      </ul>
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    </section>
  );
}
