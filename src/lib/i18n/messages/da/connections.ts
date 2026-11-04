import type { MessageTree } from "../../core";

/** "connections" namespace (da). Same keys as en/connections.ts. */
const messages: MessageTree = {
  metaTitle: "Forbindelser",
  title: "Forbindelser",
  lead: "Konti, der af sig selv henter mails, breve og datoer ind i {graph}. Alt, hvad de henter, læses som data og aldrig som instruktioner, og det, der findes i det, venter på, at du godkender det.",
  noneTitle: "Intet er forbundet endnu",
  none: "Det er endnu ikke muligt at forbinde konti direkte. Indtil da kan du selv hente mails ind.",
  byHandTitle: "Hent mails ind nu",
  byHand: "Eksporter en postkasse som en .mbox-fil eller en mappe med beskeder som en .zip med .eml-filer, og upload den i biblioteket. Hver besked bliver sin egen ting, samtaler holdes samlet, og tidslinjen viser dem på deres egne datoer.",
  toLibrary: "Gå til biblioteket",
  comingTitle: "Det kan du forbinde senere",
  coming: {
    mail: { title: "En mailkonto", hint: "Nye mails fra udvalgte mapper eller afsendere, læst efter en tidsplan, du vælger." },
    calendar: { title: "Et kalenderlink", hint: "Datoer og aftaler fra en delt kalender (.ics)." },
    aula: { title: "Aula", hint: "Beskeder og breve fra skole og institution, læst med dit eget login." },
    web: { title: "Websider", hint: "Sider, du peger på, gemt med et link til, hvor de kom fra." },
  },
  rules: "Hver forbindelse kører som dig, ser kun det, du kan se i denne graf, og kommer med forslag: Intet, den finder, kommer ind i grafen, før nogen har godkendt det.",
};

export default messages;
