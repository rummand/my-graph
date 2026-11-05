import type { MessageTree } from "../../core";

/** "commitments" namespace (da): hvad husstanden skylder, har til gode og har lovet. */
const messages: MessageTree = {
  nav: "Aftaler og frister",
  meta: { title: "Aftaler og frister · My Graph" },
  title: "Aftaler og frister",
  lead: "Det, {graph} skylder, har til gode og har lovet, fra breve, mail, skolen og beskeder. Hver enkelt viser, hvor den kommer fra.",
  leadFamily: "Det, familien skylder, har til gode og har lovet, fra breve, mail, skolen og beskeder. Hver enkelt viser, hvor den kommer fra.",

  header: {
    nothing: "Intet forfalder i den kommende uge.",
    thisWeek: { one: "{count} i denne uge", other: "{count} i denne uge" },
    atRisk: { one: "{count} i fare", other: "{count} i fare" },
    overdue: { one: "{count} overskredet", other: "{count} overskredet" },
    open: { one: "{count} åben i alt", other: "{count} åbne i alt" },
  },

  tabs: { label: "Vis", all: "Alle åbne", owe: "Vi skylder", owed: "Vi har til gode", promise: "Løfter", done: "Klaret" },
  people: { label: "Hvis", everyone: "Alle", only: "Kun {name}s", nobody: "Ingen endnu" },

  section: { overdue: "Overskredet", at_risk: "I fare", this_week: "Den kommende uge", later: "Senere", undated: "Ingen dato endnu", done: "Klaret" },
  sectionHint: {
    overdue: "Dagen er gået. Markér dem som klaret, eller skriv hvad der skete.",
    at_risk: "Forfalder snart, og ingen er gået i gang endnu.",
    undated: "Vi kender til dem, men ikke hvornår de forfalder.",
  },

  kind: {
    reply: "Svar", payment: "Betaling", renewal: "Fornyelse", notice: "Opsigelsesfrist", appointment: "Aftale",
    form: "Blanket", deliver: "Aflevering", return: "Levere tilbage", other: "Gøremål",
  },
  direction: { owe: "Vi skylder", owed: "Vi har til gode", promise: "Løfte" },
  status: { open: "Åben", done: "Klaret", cancelled: "Droppet", missed: "Overset" },

  due: {
    today: "I dag", tomorrow: "I morgen", yesterday: "I går",
    inDays: { one: "om {count} dag", other: "om {count} dage" },
    daysAgo: { one: "for {count} dag siden", other: "for {count} dage siden" },
    none: "Ingen dato endnu", around: "omkring {date}", lastDay: "sidste frist {date}",
    done: "Klaret {date}", dropped: "Droppet {date}",
  },
  recurrence: { daily: "Hver dag", weekly: "Hver uge", monthly: "Hver måned", yearly: "Hvert år", other: "Gentages" },

  row: {
    responsible: "Ansvarlig: {names}", nobody: "Ingen er ansvarlig endnu", with: "med {name}", owedBy: "fra {name}",
    from: "Fra {title}", ifMissed: "Hvis den overses", snoozed: "Udsat til {date}", started: "Gået i gang {date}",
    reminder: "Påmindelse {date}", details: "Detaljer", hideDetails: "Skjul detaljer", open: "Åbn aftalen",
    clashes: "Kolliderer med {name}", note: "Note: {note}", doneBy: "Klaret af {name}",
  },

  actions: {
    done: "Klaret", doneWithNote: "Klaret, med en note", doneTitle: "Markér „{label}“ som klaret", reopen: "Genåbn", started: "Jeg er i gang",
    snooze: "Udsæt", snoozeTitle: "Mind mig om det igen", snoozeTomorrow: "I morgen tidlig", snoozeIn3: "Om 3 dage", snoozeNextWeek: "Næste mandag",
    snoozeHint: "Flytter påmindelsen. Fristen bliver, hvor den er.",
    reassign: "Giv videre", reassignTitle: "Hvem gør det?",
    edit: "Redigér", editTitle: "Ret aftalen",
    drop: "Ikke vores", dropTitle: "Hvorfor tage den af listen?",
    more: "Flere handlinger for „{label}“",
    save: "Gem", cancel: "Annullér", note: "Note (valgfri)", notePlaceholder: "Betalt fra fælleskontoen",
    labelLabel: "Hvad skal ske", dueLabel: "Frist", amountLabel: "Beløb (kr.)", consequenceLabel: "Hvis den overses", leadLabel: "Varsl dage før",
    noDate: "Ingen dato",
  },
  drop: { not_mine: "Ikke vores at gøre", not_a_commitment: "Ikke en aftale", duplicate: "Står der allerede", cancelled: "Aflyst, bliver ikke til noget" },

  result: {
    done: "Markeret som klaret.", reopen: "Genåbnet.", snooze: "Udsat. Påmindelsen er flyttet.", progress: "Noteret, at du er i gang.",
    reassign: "Givet videre.", edit: "Gemt.", cancel: "Taget af listen.",
    proposed: "Gemt som forslag: en, der må ændre den, skal levere det.",
    next: "Den gentages: næste gang venter på dig under Venter på dig.",
    failed: "Det gik ikke. Prøv igen.",
    undo: "Fortryd",
  },

  waiting: {
    title: "Venter på dig",
    hint: "Fundet i breve, mail og beskeder. Intet kommer på listen, før du leverer det.",
    more: { one: "{count} mere venter", other: "{count} mere venter" },
  },

  empty: {
    title: "Intet at holde styr på endnu",
    body: "Aftaler og frister dukker op her, når et brev, en regning, en besked fra skolen eller en chat siger, at noget skal ske inden en dato: svare, betale, forny, opsige, skrive under, tage med. Hver enkelt bliver foreslået dig først, med det sted i teksten den kommer fra.",
    action: "Læg et brev i biblioteket",
    filtered: "Intet her med de filtre.",
    done: "Intet er markeret som klaret for nylig.",
    clear: "Vis alt",
  },

  today: {
    line: "{thisWeek}, {atRisk}",
    lineOverdue: "{overdue}, {thisWeek}, {atRisk}",
    calm: "Ingen aftaler eller frister i denne uge.",
    open: "Aftaler og frister",
    label: "Aftaler og frister, der snart forfalder",
  },

  person: { title: "Aftaler og frister", empty: "Intet åbent for {name}.", all: "Alle aftaler og frister" },

  detail: {
    title: "Aftale eller frist", back: "Alle aftaler og frister", responsible: "Ansvarlig", with: "Med", about: "Handler om",
    from: "Hvor den kommer fra", noSource: "Tilføjet i hånden, intet dokument bag.", due: "Frist", amount: "Beløb",
    consequence: "Hvis den overses", reminder: "Påmindelse", repeats: "Gentages", kind: "Slags", direction: "Hvilken vej",
    leadDays: { one: "Varsler {count} dag før", other: "Varsler {count} dage før" }, quote: "„{quote}“",
  },

  assistant: {
    list: "Vis aftalerne og fristerne på siden",
    done: "Markér en aftale som klaret",
    snooze: "Udsæt en aftale",
    reassign: "Giv en aftale videre",
    filter: "Filtrér aftalerne",
    confirmDone: "Markér „{label}“ som klaret?",
    confirmSnooze: "Udsæt „{label}“ til {date}?",
    confirmReassign: "Gør {name} ansvarlig for „{label}“?",
    unknown: "Der er ingen aftale med det id på siden.",
    unknownPerson: "Der er ingen med det id i grafen.",
  },

  search: { section: "Aftaler og frister", due: "Frist {date}" },
};

export default messages;
