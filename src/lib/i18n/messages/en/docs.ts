import type { MessageTree } from "../../core";
import guides from "@/lib/docs/guides-en";

/** "docs" namespace (en): the Documentation section (/docs). t("docs.<key>"). Guides are generated from the film. */
const messages: MessageTree = {
  nav: "Documentation",
  title: "Documentation",
  lead: "How My Graph works: a film that walks through everything, and a short guide for each part.",
  film: {
    title: "My Graph, explained",
    lead: "A film of about {minutes} minutes that walks through every part of My Graph with the demo family.",
    watch: "Watch the film",
    english: "The film is in English, with English captions.",
    minutes: "{minutes} min",
    missing: "The film hasn't been published to this server yet.",
    missingHint: "Whoever runs this server can publish it with ops/video/my-graph/publish.mjs.",
    chapters: "Chapters",
    transcript: "Transcript",
    transcriptLead: "What is said in the film. Click a time to jump there.",
    jump: "Play from {time}",
    back: "Documentation",
    captions: "English captions",
    download: "Captions as a file",
    noVideo: "Your browser can't play this film.",
  },
  guides_: {
    title: "Guides",
    lead: "One short guide for each chapter of the film, with its screens.",
    watchPart: "Watch this part of the film",
    prev: "Previous",
    next: "Next",
    all: "All guides",
    screen: "The {title} screen",
    notFound: "There's no guide by that name.",
  },
  guides,
};

export default messages;
