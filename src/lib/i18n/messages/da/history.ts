import type { MessageTree } from "../../core";

/** "history" namespace (da): hvad der er ændret, og hvem der har sagt hvad. t("history.<key>"). */
const messages: MessageTree = {
  title: "Hvad er ændret",
  empty: "Der er ikke registreret nogen ændringer af {name} endnu.",
  showProposal: "Se forslaget",
  more: { one: "og {count} tidligere ændring", other: "og {count} tidligere ændringer" },
  actor: { person: "En person", assistant: "Assistenten", connector: "En forbindelse", import: "En import", system: "My Graph" },
  kind: {
    created: "{who} tilføjede det",
    updated: "{who} ændrede {field}",
    updatedNoField: "{who} ændrede det",
    retired: "{who} trak det tilbage",
    restored: "{who} hentede det tilbage",
    merged: "{who} lagde noget sammen med det",
    added: "{who} tilføjede {field}",
    removed: "{who} fjernede {field}",
    other: "{who}: {kind}",
  },
  field: {
    label: "navnet", summary: "beskrivelsen", aliases: "de andre navne", visibility: "hvem der kan se det", sensitive: "følsomheden",
    kind: "typen", startAt: "datoen", endAt: "slutdatoen", status: "status", confidence: "hvor sikre vi er", relation: "forbindelsen",
  },
  fromTo: "fra {from} til {to}",
  toOnly: "til {to}",
  empty_value: "ingenting",
  yes: "ja",
  no: "nej",

  whoSaid: {
    title: "Hvem har sagt det",
    lead: "Alle og alt, der har fortalt grafen om {name}.",
    records: { one: "{count} registrering", other: "{count} registreringer" },
    last: "senest {date}",
    assistant: "Assistenten",
    rules: "Indbyggede regler",
    formerMember: "Et tidligere medlem",
  },
};

export default messages;
