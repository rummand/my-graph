import type { MessageTree } from "../../core";

/**
 * "stored" namespace (da): det, My Graph gemmer og viser igen senere — titler på forslag og pladsholdere — gemt som en
 * nøgle + værdier, så hver læser ser dem på sit eget sprog. t("stored.<key>").
 */
const messages: MessageTree = {
  titles: {
    fromSource: "Fra „{title}“",
    fromMeeting: "Fra mødet „{title}“",
    addFromSource: "Tilføj {what}, fra „{title}“",
    fromWeb: "Fra nettet: {query}",
    fromMessage: "Fra din besked",
    proposed: "Foreslåede ændringer",
    approvedSuggestion: "Godkendt forslag",
    onProfile: "På profilen for {name}",
    removeDates: { one: "Fjern {count} dato, der kom fra {label}", other: "Fjern {count} datoer, der kom fra {label}" },
    datesFrom: { one: "{count} dato fra {label}", other: "{count} datoer fra {label}" },
    aulaCalendarDates: { one: "{count} dato fra Aula-kalenderen", other: "{count} datoer fra Aula-kalenderen" },
    aulaCalendarChanges: "Ændringer i Aula-kalenderen",
    aulaPeople: "{parts} fra Aula",
    aulaPeopleNone: "Personer fra Aula",
    calendarUpdates: "{parts} fra {label}",
    calendarUpdatesNone: "Kalenderopdateringer fra {label}",
    restOf: "Resten af {title}",
    parts: {
      people: { one: "{count} person", other: "{count} personer" },
      places: { one: "{count} skole eller daginstitution", other: "{count} skoler og daginstitutioner" },
      connections: { one: "{count} forbindelse", other: "{count} forbindelser" },
      newDates: { one: "{count} ny dato", other: "{count} nye datoer" },
      changes: { one: "{count} ændring", other: "{count} ændringer" },
      cancellations: { one: "{count} aflysning", other: "{count} aflysninger" },
    },
  },
  sources: {
    aulaSensitive: "Følsom besked – åbn den i Aula",
    aulaAccount: "Aula: {name}",
    aulaAccountUnknown: "Aula: dit login",
  },
};

export default messages;
