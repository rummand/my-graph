import type { MessageTree } from "../../core";

/** "aula" namespace (da): /connections/aula, forbind Aula-beskeder med Forbind Aula-hjælperen. */
const messages: MessageTree = {
  metaTitle: "Forbind Aula",
  title: "Forbind Aula",
  lead: "Beskeder, opslag, kalenderen, afhentninger og sygedage fra skole og dagtilbud, læst med dit eget MitID-login. Kun læsning: My Graph sender, svarer eller markerer aldrig noget som læst i Aula.",
  unofficial: "Uofficiel: kan holde op med at virke",
  unofficialWhy: "Aula har ingen måde, hvorpå forældre kan læse deres beskeder fra en anden app. Det her bruger samme vej som Aula-appen og fællesskabets integrationer, kun til din egen familie. Når Aula ændrer noget, kan det stoppe, indtil My Graph er opdateret.",
  familyOnly: "Aula kan kun forbindes med en familiegraf. Skift til din familiegraf for at forbinde den.",
  back: "Alle forbindelser",

  status: {
    title: "Din Aula-forbindelse",
    connectedAs: "Forbundet som {name}.",
    connected: "Forbundet.",
    children: "Børn på dette login: {names}.",
    open: "Se, hvad den har hentet",
    waiting: "Venter på, at du logger ind med hjælperen.",
    needsYou: "Kræver dig: forbind Aula igen. Lav en ny parringskode herunder, og kør hjælperen igen.",
    error: "Det seneste tjek gik ikke igennem. Den prøver igen af sig selv.",
    ok: "Opdateret. Den kigger i Aula hvert kvarter.",
    justConnected: "Aula er forbundet. Det første tjek er i gang; nye beskeder kommer i biblioteket, og forslag venter på dig.",
  },

  steps: {
    title: "Log ind, trin for trin",
    lead: "Gør det på en computer derhjemme (Windows, Mac eller Linux) på jeres almindelige internet. Aulas login afviser servere og de fleste VPN'er, og derfor kan My Graph ikke gøre det for dig.",
    one: {
      title: "Få en parringskode",
      body: "Koden fortæller My Graph, at login'et fra din computer er dit. Den virker én gang, i 15 minutter.",
      action: "Få en parringskode",
      again: "Lav en ny kode",
      code: "Din parringskode",
      expires: "Gælder til {time}.",
      expired: "Koden er udløbet. Lav en ny.",
      copy: "Kopiér",
      copied: "Kopieret",
    },
    two: {
      title: "Hent og kør hjælperen",
      body: "Et lille script med My Graphs adresse indbygget. Det kræver Node.js 18 eller nyere (fra nodejs.org). Åbn en terminal i mappen, du hentede det til, og kør:",
      download: "Hent hjælperen",
      read: "Det er én kort fil, som du kan læse, før du kører den. Den gemmer intet på din computer.",
    },
    three: {
      title: "Godkend med MitID",
      body: "Hjælperen åbner Aulas eget login i din browser. Log ind, og godkend i MitID-appen, som du plejer. Når browseren stopper (siden kan se tom ud eller vise en fejl, det er forventet), så kopiér hele adressen fra adresselinjen, og sæt den ind i hjælperen.",
      phone: "Brug computerens browser, ikke telefonen med Aula-appen: appen ville tage login'et til sig selv.",
    },
    four: {
      title: "Færdig",
      body: "Hjælperen sender kun login-nøglerne til My Graph sammen med din kode. Siden opdager det af sig selv.",
      watching: "Holder øje med dit login…",
    },
  },

  mcp: {
    title: "Bruger du allerede aula-mcp?",
    body: "Hvis du logger ind på Aula med aula-mcp, kan du eksportere dens nøgler og give dem videre i stedet for at logge ind igen:",
  },

  how: {
    title: "Hvad der sker med dit login",
    mitid: "MitID bliver hos dig: du godkender på MitIDs egne sider og i din egen MitID-app. Hverken hjælperen eller My Graph ser nogensinde dit MitID.",
    tokens: "My Graph får kun Aulas login-nøgler. De gemmes krypteret, vises aldrig igen, skrives aldrig i loggen og sendes aldrig til assistenten.",
    renew: "My Graph holder selv login'et i live. Når Aula afslutter det (efter nogle uger, eller hvis du logger ud overalt), står der „Kræver dig: forbind Aula igen“, og så kører du hjælperen igen. Den starter aldrig selv et MitID-login.",
    reads: "Den læser hvert kvarter: nye beskeder og opslag, kalenderen for de næste 13 uger, dagens afhentninger og sygedage og nye fotoalbum som links.",
    sensitive: "Følsomme beskeder (dem, Aula kræver en ekstra MitID-godkendelse for at åbne) bliver aldrig åbnet. De vises som „Følsom besked – åbn den i Aula“.",
    never: "Den sender aldrig beskeder, melder aldrig sygdom, ændrer aldrig afhentninger, markerer aldrig beskeder som læst og henter aldrig billeder ned.",
    proposals: "Personer, datoer og frister, den finder, venter på din godkendelse, hver med et link til beskeden, de kom fra.",
  },

  visibility: {
    label: "Hvem kan se det, den henter",
    hint: "Beskeder om dine børn. Du kan ændre det senere på forbindelsen.",
  },

  errors: {
    generic: "Det gik ikke igennem. Prøv igen.",
  },
};

export default messages;
