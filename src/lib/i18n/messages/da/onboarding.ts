import type { MessageTree } from "../../core";

/** "onboarding" namespace (da): introduktionen på I dag. t("onboarding.<key>"). Familieord kun i en familiegraf. */
const messages: MessageTree = {
  titleFamily: "Sådan arbejder assistenten i jeres familiegraf",
  title: "Sådan arbejder assistenten i {graph}",
  tryTitle: "Prøv at spørge",
  step: "Trin {step} af {total}",
  introFamily: "Den læser familiens kalender, breve, personer og sider her, og kun det, du må se. Den foreslår; du bestemmer.",
  intro: "Kun det, der er i {graph}, bliver brugt. Intet fra dine andre grafer kommer ind, og intet herfra kommer ud. Den foreslår; du bestemmer.",
  canDo: "Det kan den",
  canAnswer: "Svare på spørgsmål, med et link til, hvor hvert svar kommer fra",
  canSuggestFamily: "Foreslå påmindelser, oplysninger og familieregler, som venter her, til du godkender dem",
  canSuggest: "Foreslå påmindelser, oplysninger og ændringer i din graf, som venter her, til du godkender dem",
  canCheckIn: "Tjekke ind efter en plan og fortælle dig, hvad der er ændret, uden selv at ændre noget",
  settingsTitle: "Dine indstillinger fra start",
  memory: {
    label: "Hukommelse:",
    value: "passes af Brain Keeper",
    hintFamily: "Ønsker, du nævner, som “ingen planer søndag aften”, bliver husket uden at du bliver spurgt. Brain Keeper gennemgår dem, slår gentagelser sammen, og det, der kun stammer fra et dokument, venter på dig.",
    hint: "Ønsker, du nævner, som “opdateringer om mandagen”, bliver husket uden at du bliver spurgt. Brain Keeper gennemgår dem, slår gentagelser sammen, og det, der kun stammer fra et dokument, venter på dig.",
    link: "Se og redigér dem under Hukommelse",
  },
  facts: {
    label: "Ændrer din graf uden at spørge:",
    value: "aldrig",
    hint: "Hver ny oplysning, person eller forbindelse bliver foreslået først og venter på, at du godkender den. Det kan ikke slås fra.",
  },
  checkIn: {
    label: "Tjek:",
    on: "hver time fra 07.00 til 20.00",
    off: "slået fra",
    hintOnFamily: "Den kigger efter nye breve, frister og fødselsdage og foreslår kun.",
    hintOn: "Den kigger efter nye filer, mails og frister og foreslår kun.",
    hintOff: "Slå til, så kigger den hver time fra 07.00 til 20.00, hver dag. Den foreslår kun.",
    switch: "Daglige tjek",
  },
  cap: {
    before: "Højst",
    after: { one: "forslag om dagen", other: "forslag om dagen" },
    hint: "Så den aldrig maser på. Det, du siger nej til, foreslår den ikke igen.",
    label: "Højst antal forslag om dagen",
  },
  questionsFamily: "Spørgsmål ud fra det, der allerede er i jeres familiegraf:",
  questions: "Spørgsmål ud fra det, der allerede er i {graph}:",
  tip: {
    title: "Vær konkret",
    body: "Nævn personen, dagen og hvad du vil have tilbage. Så får du et skarpere svar og færre opfølgende spørgsmål.",
    instead: "I stedet for",
    try: "Prøv",
  },
  next: "Næste: prøv at spørge",
  skip: "Spring over, jeg kigger mig omkring",
  done: "Færdig",
  later: "Du kan ændre alt det her senere under Automatiseringer.",
  error: {
    save: "Det blev ikke gemt. Prøv igen.",
    offline: "Vi kunne ikke få forbindelse til My Graph. Tjek din forbindelse.",
  },
};

export default messages;
