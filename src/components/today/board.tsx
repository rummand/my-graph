"use client";
import { useMemo, type ReactNode } from "react";
import type { EventItem, ReminderDTO } from "@/lib/briefs";
import { RemindersList, useReminders, type Person } from "./reminders";
import { WeekStrip } from "./week-strip";
import type { Lane } from "./week";

/**
 * The working part of Today: the family week across the top, then the brief and the to-do list, with the
 * page's side column (passed in from the server) beside them. Reminder state lives here so a tick shows on
 * the week strip and the list at once.
 */
export function TodayBoard({ tz, nowIso, lanes, family, laneNote, events, eventsFailed, reminders, remindersFailed, people, brief, side }: {
  tz: string; nowIso: string; lanes: Lane[]; family: Lane; laneNote: string | null;
  events: EventItem[]; eventsFailed: boolean; reminders: ReminderDTO[]; remindersFailed: boolean;
  people: Person[]; brief: ReactNode; side: ReactNode;
}) {
  const now = useMemo(() => new Date(nowIso), [nowIso]);
  const api = useReminders(reminders, now, tz);

  return (
    <>
      <WeekStrip lanes={lanes} family={family} events={events} reminders={api.reminders} eventsFailed={eventsFailed}
        nowIso={nowIso} tz={tz} laneNote={laneNote} />

      <div className="mt-8 grid gap-x-8 gap-y-8 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-8">
          {brief}
          <RemindersList api={api} loadFailed={remindersFailed} now={now} tz={tz} people={people} />
        </div>
        <div className="min-w-0 space-y-8">{side}</div>
      </div>
    </>
  );
}
