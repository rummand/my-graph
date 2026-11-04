import type { MessageTree } from "../../core";

/** "changes" namespace (da): forslag (ændringssæt), der venter på, at en person beslutter. t("changes.<key>"). */
const messages: MessageTree = {
  title: "Forslag",
  lead: "Det, som agenter vil ændre i {graph}. Intet kommer ind i grafen, før en af jer har besluttet det.",
  leadFamily: "Det, som agenter vil ændre i jeres familiegraf. Intet kommer ind i grafen, før en af jer har besluttet det.",
  filter: { draft: "Venter", delivered: "Tilføjet", abandoned: "Afvist", all: "Alle" },
  empty: "Intet her lige nu.",
  emptyDraft: "Intet venter på dig. Når assistenten, en import eller en forbindelse finder noget nyt, bliver det foreslået her først.",
  notReady: "Forslag kan ikke vises endnu. Denne del af My Graph er stadig under opbygning, så det, der ville blive foreslået, venter.",
  count: { one: "{count} ændring", other: "{count} ændringer" },
  by: "af {name}",
  status: { draft: "Venter på dig", delivered: "Tilføjet til grafen", abandoned: "Afvist" },
  origin: {
    person: "Dig", assistant: "Assistenten", chat: "En samtale", connector: "En forbindelse", web: "Websøgning", ingest: "Biblioteket",
    automation: "En automatisering", heartbeat: "Et tjek", keeper: "Hjernevogteren", restore: "En gendannelse",
  },
  verdict: { outstanding: "Ikke tilføjet endnu", landed: "Allerede i grafen", conflicted: "Strider mod grafen nu" },
  receipt: {
    source: "Fra {title}",
    sourceUntitled: "Fra et dokument",
    conversation: "Fra en samtale",
    web: "Fra nettet",
    sure: "{pct} % sikker",
  },
  op: {
    addNode: "Tilføj", updateNode: "Ændr", retireNode: "Træk tilbage", mergeNodes: "Læg sammen", addEdge: "Forbind", updateEdge: "Ændr en forbindelse",
    removeEdge: "Fjern en forbindelse", addKind: "Ny type", addRelationType: "Ny relation", addAttribute: "Ny detalje",
    addReminder: "Påmindelse", editWiki: "Redigér wikiside",
  },
  excluded: "Udeladt",
  back: "Forslag",
  notFound: "Vi kunne ikke finde det forslag",
  notFoundBody: "Det er måske afvist, eller det hører til en anden graf.",
  decideHint: "Gennemgå hver ændring og dens belæg. Beslutningen træffes her, når forslag er helt færdigbygget.",
  created: "Foreslået {date}",
  deliveredAt: "Tilføjet {date}",
};

export default messages;
