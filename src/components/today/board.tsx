"use client";
import { useMemo, type ReactNode } from "react";
import type { EventItem, ReminderDTO } from "@/lib/briefs";
import { RemindersList, useReminders, type Person } from "./reminders";
import { WeekStrip } from "./week-strip";
import type { Lane } from "./week";

/**
 * The working part of Today. In a family graph: the children's week across the top. Elsewhere: whatever the page
 * passes as `top` (coming up, key people and projects). Then the brief and the to-do list, with the page's side
 * column (passed in from the server) beside them. Reminder state lives here so a tick shows on the week strip and the
 * list at once.
 */
export function TodayBoard({ tz, nowIso, week, top, lanes, family, laneNote, events, eventsFailed, reminders, remindersFailed, people, isFamily, brief, side }: {
  tz: string; nowIso: string;
  /** Show the family week strip (family graphs). */
  week: boolean;
  top?: ReactNode;
  lanes: Lane[]; family: Lane; laneNote: string | null;
  events: EventItem[]; eventsFailed: boolean; reminders: ReminderDTO[]; remindersFailed: boolean;
  people: Person[]; isFamily: boolean; brief: ReactNode; side: ReactNode;
}) {
  const now = useMemo(() => new Date(nowIso), [nowIso]);
  const api = useReminders(reminders, now, tz);

  return (
    <>
      {week && (
        <WeekStrip lanes={lanes} family={family} events={events} reminders={api.reminders} eventsFailed={eventsFailed}
          nowIso={nowIso} tz={tz} laneNote={laneNote} />
      )}
      {top}

      <div className="mt-8 grid gap-x-8 gap-y-8 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-8">
          {brief}
          <RemindersList api={api} loadFailed={remindersFailed} now={now} tz={tz} people={people} isFamily={isFamily} />
        </div>
        <div className="min-w-0 space-y-8">{side}</div>
      </div>
    </>
  );
}
