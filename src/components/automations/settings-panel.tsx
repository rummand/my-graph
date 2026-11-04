"use client";
import { useRef, useState } from "react";
import { Button, Tabs } from "@/components/ui";
import type { AssistantSettings } from "@/lib/automations";
import { ACTION_LABEL } from "@/lib/automations/policy";
import type { Usage } from "@/lib/automations/overview";
import { api, Toggle } from "./bits";

type SettingsView = Omit<AssistantSettings, "onboardedAt"> & { onboardedAt: string | null };

const CAPS: { key: string; label: string; hint: string }[] = [
  { key: "library", label: "Read the library", hint: "Letters, photos and files" },
  { key: "timeline", label: "Read the timeline", hint: "Events and dates" },
  { key: "people", label: "Read about people", hint: "Birthdays, how people are, who you see" },
  { key: "reminders", label: "Suggest reminders", hint: "Always asks first" },
  { key: "wiki_write", label: "Suggest wiki notes", hint: "Always asks first" },
];

/** How the assistant behaves for me in this graph. Every change saves straight away. */
export function SettingsPanel({ initial, usage }: { initial: SettingsView; usage: Usage }) {
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
      setError(e instanceof Error ? e.message : "Couldn't save.");
    }
  }

  const acceptance = usage.approved + usage.denied > 0 ? Math.round((usage.approved / (usage.approved + usage.denied)) * 100) : null;
  return (
    <div className="space-y-5 rounded-lg bg-surface p-4">
      <p className="text-sm text-muted">
        This week: {usage.runs} run{usage.runs === 1 ? "" : "s"} and {usage.suggestions} suggestion{usage.suggestions === 1 ? "" : "s"}
        {acceptance !== null ? `, you approved ${acceptance}%` : ""}.
      </p>

      <Row label="Save memories without asking" hint="Preferences and notes from your chats. Facts always need your approval.">
        <Toggle checked={s.autoSaveMemories} label="Save memories without asking" onChange={(v) => patch({ autoSaveMemories: v }, { autoSaveMemories: v })} />
      </Row>

      <div>
        <p className="text-sm font-medium">Always allowed</p>
        {s.alwaysAllow.length === 0 ? (
          <p className="mt-0.5 text-sm text-muted">Nothing. The assistant asks every time. Choose “Always allow” on a suggestion to skip asking for that kind.</p>
        ) : (
          <ul className="mt-1.5 space-y-1">
            {s.alwaysAllow.map((k) => (
              <li key={k} className="flex items-center justify-between gap-2 text-sm">
                <span>{ACTION_LABEL[k] ?? k}</span>
                <Button size="sm" variant="ghost" onClick={() => patch({ alwaysAllow: s.alwaysAllow.filter((x) => x !== k) }, { alwaysAllow: s.alwaysAllow.filter((x) => x !== k) })}>Revoke</Button>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-1 text-xs text-muted">Check-ins and automations still ask before adding facts, merging or editing the wiki.</p>
      </div>

      <div>
        <p className="mb-1 text-sm font-medium">What it may use</p>
        <ul className="space-y-2">
          {CAPS.map((c) => (
            <li key={c.key}>
              <Row label={c.label} hint={c.hint} small>
                <Toggle checked={s.capabilities[c.key] !== false} label={c.label}
                  onChange={(v) => patch({ capabilities: { [c.key]: v } }, { capabilities: { ...s.capabilities, [c.key]: v } })} />
              </Row>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <p className="mb-1.5 text-sm font-medium">How it writes</p>
        <Tabs value={s.tone} onSelect={(t) => patch({ tone: t }, { tone: t })}
          items={[{ value: "warm", label: "Warm" }, { value: "brief", label: "Brief" }, { value: "detailed", label: "Detailed" }]} />
      </div>

      <Row label="Suggestions a day, at most" hint="From check-ins and automations. Answers in chat don't count.">
        <input type="number" min={0} max={50} value={s.dailySuggestionCap} aria-label="Suggestions a day, at most"
          onChange={(e) => {
            const n = Math.max(0, Math.min(50, Number(e.target.value) || 0));
            setS({ ...s, dailySuggestionCap: n });
            if (capTimer.current) clearTimeout(capTimer.current);
            capTimer.current = setTimeout(() => void patch({ dailySuggestionCap: n }, { dailySuggestionCap: n }), 600);
          }}
          className="h-9 w-20 rounded-md bg-surface px-2 text-right text-[15px] tabular-nums ring-1 ring-inset ring-line focus:outline-none focus:ring-2 focus:ring-accent" />
      </Row>

      <p aria-live="polite" className="min-h-5 text-sm">
        {error ? <span className="text-danger">{error}</span> : saved ? <span className="text-muted">Saved.</span> : null}
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
