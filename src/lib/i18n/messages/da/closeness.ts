import type { MessageTree } from "../../core";

/** "closeness" namespace (da): how close the viewer is to people, from interactions (Close / In touch / Drifting / Faded). t("closeness.<key>"). */
const messages: MessageTree = {
  band: { close: "Tæt på", in_touch: "I kontakt", drifting: "Glider væk", faded: "Falmet" },
  kind: {
    message: "Besked", email: "E-mail", call: "Opkald", meeting: "Møde", event: "Begivenhed", photo: "Billede",
    mention: "Nævnt i et dokument", edit: "Ændrede grafen",
  },
  kindLower: {
    message: "besked", email: "e-mail", call: "opkald", meeting: "møde", event: "begivenhed", photo: "billede",
    mention: "nævnt i et dokument", edit: "ændrede grafen",
  },
  showFaded: { one: "Vis falmet person ({count})", other: "Vis falmede personer ({count})" },
  hideFaded: "Skjul falmede personer",
  fadedHint: "Personer, du ikke har været i kontakt med i lang tid. Intet slettes; søgning finder dem altid.",
  lastInTouch: "Sidst i kontakt",
  lastLine: "{kind} {when}",
  hint: "Sidst i kontakt {when}",
  neverHint: "Ingen kontakt fundet endnu",
  quietFor: { one: "Ikke i kontakt i en måned", other: "Ikke i kontakt i {count} måneder" },
  timeline: "Seneste kontakt",
  timelineEmpty: "Intet endnu. Beskeder, e-mails, opkald, møder, billeder og dokumenter, der nævner dem, vises her, når de er i grafen.",
  timelineWhy: "Fundet i det, du kan se i denne graf; kun du ser denne liste.",
  open: "Åbn",
  pin: "Hold tæt",
  pinned: "Holdes tæt",
  pinHint: "De falmer ikke for dig, uanset hvor længe det er siden.",
  unpinHint: "Lad dem falme igen, når I ikke er i kontakt.",
  pinFailed: "Det virkede ikke. Prøv igen.",
  nudge: "Du har ikke været i kontakt med {name} i et stykke tid",
  nudgeDetail: "Sidst: {kind}, {when}.",
  setting: "Mind mig om personer, jeg har mistet kontakten med",
  settingHint: "Højst én stille påmindelse på I dag, og kun om personer, du plejede at være tæt på. Slået fra, medmindre du slår den til.",
};

export default messages;
