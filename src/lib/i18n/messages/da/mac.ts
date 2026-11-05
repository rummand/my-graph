import type { MessageTree } from "../../core";

/** "mac" namespace (da): /connections/mac, Beskeder og Noter med hjælperen My Graph til Mac. */
const messages: MessageTree = {
  metaTitle: "My Graph til Mac",
  title: "My Graph til Mac",
  lead: "Hent de samtaler fra Beskeder og de noter, du vælger, ind i denne graf. En lille hjælper på din Mac læser dem og sender dem hertil; det, de tilføjer, venter på din godkendelse.",
  unofficial: "Uofficielt: kan holde op med at virke",
  unofficialWhy: "Apple giver ikke andre apps adgang til Beskeder eller Noter. Hjælperen læser databasen for Beskeder på din Mac og beder Noter om dine noter, så en macOS-opdatering kan få den til at holde op med at virke, indtil My Graph er opdateret.",
  readOnly: "Du kan se denne graf, men ikke forbinde en Mac til den.",
  back: "Alle forbindelser",

  status: {
    title: "Din Mac",
    waiting: "Venter på, at hjælperen på din Mac parrer.",
    paired: "Parret med {device}.",
    pairedNoName: "Parret med din Mac.",
    lastSeen: "Hørte sidst fra den {ago}.",
    lastSend: "Sidst sendt {ago}: {what}.",
    nothingYet: "Intet er sendt endnu.",
    messages: { one: "{count} besked", other: "{count} beskeder" },
    notes: { one: "{count} note", other: "{count} noter" },
    paused: "På pause: hjælperens forsendelser afvises, indtil du genoptager den.",
    open: "Se, hvad den har hentet",
    signOut: "Log hjælperen ud",
    signOutConfirm: "Log hjælperen ud? Dens nøgle holder op med at virke med det samme. Det, den allerede har hentet, bliver.",
    signedOut: "Hjælperen er logget ud. Lav en ny parringskode for at bruge den igen.",
    justPaired: "Din Mac er parret. Vælg nu, hvad den må sende.",
  },

  steps: {
    title: "Sæt det op, trin for trin",
    lead: "På din Mac, med Node 18 eller nyere (nodejs.org eller brew install node). Det tager cirka fem minutter.",
    one: {
      title: "Hent en parringskode",
      body: "Koden bruges én gang og udløber efter 15 minutter. Den knytter hjælperen til dig og til denne graf.",
      action: "Hent en parringskode",
      again: "Hent en ny kode",
      code: "Din parringskode",
      copy: "Kopiér",
      copied: "Kopieret",
      expires: "Gælder til {time}.",
      expired: "Koden er udløbet. Hent en ny.",
    },
    two: {
      title: "Hent hjælperen",
      body: "Én fil, ingen installation. Den taler kun med denne My Graph. Du kan læse den først: det er almindelig JavaScript med kommentarer.",
      download: "Hent my-graph-mac.mjs",
    },
    three: {
      title: "Lad Terminal læse Beskeder",
      body: "macOS holder Beskeder privat for Beskeder. For at hjælperen kan læse dem, skal du åbne Systemindstillinger, Anonymitet og sikkerhed, Fuld diskadgang og slå Terminal til (eller det terminalprogram, du bruger). Luk og åbn Terminal igen bagefter.",
      notes: "Hvis du sender Noter, spørger macOS én gang, om Terminal må styre Noter. Svar OK.",
      skip: "Sender du kun Noter? Så kan du springe fuld diskadgang over.",
    },
    four: {
      title: "Kør den",
      body: "Åbn Terminal, gå til mappen, hvor du gemte filen (som regel Overførsler), og kør:",
      first: "Første kørsel parrer og fortæller My Graph, hvilke samtaler og mapper din Mac har (kun navne, ingen beskeder). Intet andet sendes, før du vælger nedenfor.",
      watching: "Venter på din Mac…",
    },
  },

  choose: {
    title: "Hvad din Mac må sende",
    lead: "Intet sendes, før du slår det til. Du kan ændre det når som helst; hjælperen spørger før hver forsendelse.",
    noCatalog: "Kør hjælperen én gang, så dukker dine samtaler og mapper i Noter op her, så du kan vælge.",
    catalogAt: "Din Mac viste disse {ago}.",
    save: "Gem",
    saved: "Gemt. Hjælperen bruger det fra næste kørsel.",
    messages: {
      label: "Beskeder (iMessage og sms)",
      hint: "Tekster, hvem der skrev dem og hvornår, og navnene på vedhæftninger (selve filerne bliver på din Mac).",
      cantRead: "Hjælperen kunne ikke læse Beskeder sidst. Giv Terminal fuld diskadgang (trin 3), og kør den igen.",
      scope: "Hvilke samtaler",
      chosen: "Kun de samtaler, jeg vælger",
      known: "Samtaler med personer, der allerede er i denne graf",
      knownCount: { zero: "Ingen af dine samtaler passer på nogen i denne graf endnu.", one: "Lige nu er det {count} samtale.", other: "Lige nu er det {count} samtaler." },
      since: "Hvor langt tilbage",
      since3m: "De sidste 3 måneder",
      since1y: "Det sidste år",
      sinceAll: "Alt",
      filter: "Find en samtale",
      selected: { zero: "Ingen samtaler valgt", one: "{count} samtale valgt", other: "{count} samtaler valgt" },
      inGraph: "I denne graf",
      count: { one: "{count} besked", other: "{count} beskeder" },
      group: "Gruppe",
      none: "Ingen samtaler passer.",
    },
    notes: {
      label: "Noter",
      hint: "Teksten i dine noter, deres mappe og datoer. Låste noter og Senest slettet læses aldrig.",
      cantRead: "Hjælperen kunne ikke læse Noter sidst. Tillad Terminal at styre Noter i Systemindstillinger, Anonymitet og sikkerhed, Automatisering.",
      all: "Alle mapper",
      folders: "Kun disse mapper",
      noFolders: "Slå Noter til og kør hjælperen én gang; så dukker dine mapper op her.",
      count: { one: "{count} note", other: "{count} noter" },
    },
    visibility: { label: "Hvem kan se det, den henter", hint: "Samtaler og noter er private for dig, medmindre du vælger andet." },
    resend: {
      title: "Send igen",
      body: "Glem, hvor hjælperen nåede til, så dens næste kørsel sender alt, du har valgt, igen. Det, der allerede er her, bliver ikke dobbelt.",
      messages: "Beskeder igen",
      notes: "Noter igen",
      done: "Gjort. Næste kørsel sender alt, du har valgt, igen.",
    },
  },

  schedule: {
    title: "Send af sig selv (valgfrit)",
    body: "Kør dette én gang, så kører hjælperen hver time, mens du er logget ind på din Mac (en launchd-agent som enhver baggrundsapp). Til det skal node selv have fuld diskadgang; hjælperen skriver, hvor den ligger.",
    stop: "For at stoppe den:",
  },

  how: {
    title: "Sådan virker det",
    only: "Hjælperen sender kun det, du har valgt her. Den sender, ændrer eller sletter aldrig noget i Beskeder eller Noter.",
    list: "For at du kan vælge, fortæller den My Graph navnene på dine samtaler, hvem der er med i dem, og navnene på dine mapper i Noter. Ingen beskeder eller noter, før du vælger.",
    key: "Parringen giver hjælperen sin egen nøgle, som gemmes i din Macs nøglering. My Graph gemmer kun et fingeraftryk af den. Logger du den ud eller afbryder forbindelsen, stopper den med det samme.",
    private: "Samtaler gemmes som følsomme og private for dig som standard, så når de læses, bruges der aldrig en anden AI-udbyder som reserve.",
    proposals: "Personer, datoer og planer i dem er forslag: intet føjes til grafen, før du godkender det under Ændringer.",
    cursor: "Den husker, hvor den nåede til, på din Mac og her, så hver kørsel kun sender det nye.",
  },

  errors: { generic: "Det gik ikke igennem. Prøv igen." },
};

export default messages;
