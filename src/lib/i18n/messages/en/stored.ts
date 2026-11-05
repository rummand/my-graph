import type { MessageTree } from "../../core";

/**
 * "stored" namespace (en): things My Graph stores and shows again later — proposal titles and placeholder titles —
 * kept as a key + params so each reader sees them in their own language. t("stored.<key>").
 * See src/lib/changes/titles.ts and src/lib/ingest/titles.ts.
 */
const messages: MessageTree = {
  titles: {
    fromSource: "From “{title}”",
    fromMeeting: "From the meeting “{title}”",
    addFromSource: "Add {what}, from “{title}”",
    fromWeb: "From the web: {query}",
    fromMessage: "From your message",
    proposed: "Proposed changes",
    approvedSuggestion: "Approved suggestion",
    onProfile: "On {name}'s profile",
    removeDates: { one: "Remove {count} date that came from {label}", other: "Remove {count} dates that came from {label}" },
    datesFrom: { one: "{count} date from {label}", other: "{count} dates from {label}" },
    aulaCalendarDates: { one: "{count} date from the Aula calendar", other: "{count} dates from the Aula calendar" },
    aulaCalendarChanges: "Changes in the Aula calendar",
    aulaPeople: "{parts} from Aula",
    aulaPeopleNone: "People from Aula",
    calendarUpdates: "{parts} from {label}",
    calendarUpdatesNone: "Calendar updates from {label}",
    restOf: "Rest of {title}",
    parts: {
      people: { one: "{count} person", other: "{count} people" },
      places: { one: "{count} school or daycare", other: "{count} schools and daycares" },
      connections: { one: "{count} connection", other: "{count} connections" },
      newDates: { one: "{count} new date", other: "{count} new dates" },
      changes: { one: "{count} change", other: "{count} changes" },
      cancellations: { one: "{count} cancellation", other: "{count} cancellations" },
    },
  },
  sources: {
    aulaSensitive: "Sensitive, open in Aula",
    aulaAccount: "Aula: {name}",
    aulaAccountUnknown: "Aula: your login",
  },
};

export default messages;
