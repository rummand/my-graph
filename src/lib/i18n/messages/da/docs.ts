import type { MessageTree } from "../../core";
import guides from "@/lib/docs/guides-da";

/** "docs" namespace (da): Dokumentation (/docs). t("docs.<key>"). Vejledningerne er lavet ud fra filmen. */
const messages: MessageTree = {
  nav: "Dokumentation",
  title: "Dokumentation",
  lead: "Sådan virker My Graph: en film, der gennemgår det hele, og en kort vejledning til hver del.",
  film: {
    title: "My Graph, forklaret",
    lead: "En film på omkring {minutes} minutter, der gennemgår alle dele af My Graph med demofamilien.",
    watch: "Se filmen",
    english: "Filmen er på engelsk, med engelske undertekster.",
    minutes: "{minutes} min.",
    missing: "Filmen er ikke lagt op på denne server endnu.",
    missingHint: "Den, der driver serveren, kan lægge den op med ops/video/my-graph/publish.mjs.",
    chapters: "Kapitler",
    transcript: "Udskrift",
    transcriptLead: "Det, der bliver sagt i filmen (på engelsk). Klik på et tidspunkt for at springe dertil.",
    jump: "Afspil fra {time}",
    back: "Dokumentation",
    captions: "Engelske undertekster",
    download: "Undertekster som fil",
    noVideo: "Din browser kan ikke afspille filmen.",
  },
  guides_: {
    title: "Vejledninger",
    lead: "En kort vejledning til hvert kapitel i filmen, med skærmbillederne.",
    watchPart: "Se denne del af filmen",
    prev: "Forrige",
    next: "Næste",
    all: "Alle vejledninger",
    screen: "Skærmbilledet {title}",
    notFound: "Der findes ingen vejledning med det navn.",
  },
  guides,
};

export default messages;
