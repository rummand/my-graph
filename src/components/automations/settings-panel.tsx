"use client";
import { useRef, useState } from "react";
import Link from "next/link";
import { Button, Tabs } from "@/components/ui";
import type { AssistantSettings } from "@/lib/automations";
import { ACTION_LABEL } from "@/lib/automations/policy";
import { Brain } from "lucide-react";
import type { Usage } from "@/lib/automations/overview";
import { api, Toggle, useCopy } from "./bits";

type SettingsView = Omit<AssistantSettings, "onboardedAt"> & { onboardedAt: string | null };

/** Capabilities, and whether their hint differs between a family graph and other graphs. */
const CAPS: { key: string; varied?: boolean }[] = [
  { key: "library", varied: true }, { key: "timeline" }, { key: "people", varied: true }, { key: "reminders" }, { key: "wiki_write" }, { key: "web" },
];
/** Action keys whose label differs in a family graph. */
const VARIED_ACTIONS = new Set(["rule.save"]);

/** How the assistant behaves for me in this graph. Every change saves straight away. */
export function SettingsPanel({ initial, usage }: { initial: SettingsView; usage: Usage }) {
  const { t, vr } = useCopy();
  const actionLabel = (k: string) => {
    const key = `automations.settings.actions.${k.replace(/\./g, "_")}${VARIED_ACTIONS.has(k) ? `.${vr}` : ""}`;
    return t(key, undefined, ACTION_LABEL[k] ?? k);
  };
  const [s, setS] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const capTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function patch(p: Partial<AssistantSettings>, optimistic: Partial<SettingsView>) {
    const before = s;
    setS({ ...s, ...optimistic }); setError(null); setSaved(false);
    try {
      const r = await api<{ settings: SettingsView }>("/api/assistant-settings", { method: "PATCH", json: p });
      setS(r.settings); setSaved(true);
    } catch (e) {
      setS(before);
      setError(e instanceof Error ? e.message : t("automations.settings.couldNotSave"));
    }
  }

  const acceptance = usage.approved + usage.denied > 0 ? Math.round((usage.approved / (usage.approved + usage.denied)) * 100) : null;
  return (
    <div className="space-y-5 rounded-lg bg-surface p-4">
      <p className="text-sm text-muted">
        {t("automations.settings.usage", {
          runs: t("automations.settings.runs", { count: usage.runs }),
          suggestions: t("automations.settings.suggestions", { count: usage.suggestions }),
          approved: acceptance !== null ? t("automations.settings.approved", { pct: acceptance }) : "",
        })}
      </p>

      {/* Memory is the Brain Keeper's job: it keeps what you mention in chat without asking. No switch for that here. */}
      <div className="flex items-start gap-2.5">
        <Brain className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
        <div className="min-w-0">
          <p className="text-sm font-medium">{t("automations.settings.memoryTitle")}</p>
          <p className="text-sm text-muted">{t("automations.settings.memory")}</p>
          <Link href="/memory" className="text-sm text-accent hover:underline">{t("automations.settings.memoryLink")}</Link>
        </div>
      </div>

      <div>
        <p className="text-sm font-medium">{t("automations.settings.alwaysAllowed")}</p>
        {s.alwaysAllow.length === 0 ? (
          <p className="mt-0.5 text-sm text-muted">{t("automations.settings.nothingAllowed")}</p>
        ) : (
          <ul className="mt-1.5 space-y-1">
            {s.alwaysAllow.map((k) => (
              <li key={k} className="flex items-center justify-between gap-2 text-sm">
                <span>{actionLabel(k)}</span>
                <Button size="sm" variant="ghost" onClick={() => patch({ alwaysAllow: s.alwaysAllow.filter((x) => x !== k) }, { alwaysAllow: s.alwaysAllow.filter((x) => x !== k) })}>{t("automations.settings.revoke")}</Button>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-1 text-xs text-muted">{t("automations.settings.stillAsks")}</p>
      </div>

      <div>
        <p className="mb-1 text-sm font-medium">{t("automations.settings.mayUse")}</p>
        <ul className="space-y-2">
          {CAPS.map((c) => {
            const label = t(`automations.settings.caps.${c.key}.label`);
            return (
            <li key={c.key}>
              <Row label={label} hint={t(`automations.settings.caps.${c.key}.hint${c.varied ? `.${vr}` : ""}`)} small>
                <Toggle checked={s.capabilities[c.key] !== false} label={label}
                  onChange={(v) => patch({ capabilities: { [c.key]: v } }, { capabilities: { ...s.capabilities, [c.key]: v } })} />
              </Row>
            </li>
            );
          })}
        </ul>
      </div>

      <div>
        <p className="mb-1.5 text-sm font-medium">{t("automations.settings.howItWrites")}</p>
        <Tabs value={s.tone} onSelect={(tone) => patch({ tone }, { tone })}
          items={[{ value: "warm", label: t("automations.settings.tone.warm") }, { value: "brief", label: t("automations.settings.tone.brief") }, { value: "detailed", label: t("automations.settings.tone.detailed") }]} />
      </div>

      <Row label={t("automations.settings.cap")} hint={t("automations.settings.capHint")}>
        <input type="number" min={0} max={50} value={s.dailySuggestionCap} aria-label={t("automations.settings.cap")}
          onChange={(e) => {
            const n = Math.max(0, Math.min(50, Number(e.target.value) || 0));
            setS({ ...s, dailySuggestionCap: n });
            if (capTimer.current) clearTimeout(capTimer.current);
            capTimer.current = setTimeout(() => void patch({ dailySuggestionCap: n }, { dailySuggestionCap: n }), 600);
          }}
          className="h-9 w-20 rounded-md bg-surface px-2 text-right text-[15px] tabular-nums ring-1 ring-inset ring-line focus:outline-none focus:ring-2 focus:ring-accent" />
      </Row>

      <p aria-live="polite" className="min-h-5 text-sm">
        {error ? <span className="text-danger">{error}</span> : saved ? <span className="text-muted">{t("automations.settings.saved")}</span> : null}
      </p>
    </div>
  );
}

function Row({ label, hint, children, small }: { label: string; hint?: string; children: React.ReactNode; small?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className={small ? "text-sm" : "text-sm font-medium"}>{label}</p>
        {hint && <p className="text-sm text-muted">{hint}</p>}
      </div>
      <div className="shrink-0 pt-0.5">{children}</div>
    </div>
  );
}
