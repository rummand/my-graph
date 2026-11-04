import type { MessageTree } from "../../core";

/** "mcp" namespace (da): MCP-servere under Forbindelser: login, værktøjer, godkendelser. */
const messages: MessageTree = {
  auth: {
    label: "Sådan logger den ind",
    oauth: "Log ind på serverens egen side",
    oauthHint: "Du logger ind dér og vælger, hvad My Graph må læse. My Graph ser aldrig din adgangskode.",
    key: "Indsæt en API-nøgle",
    keyHint: "Laves på serveren, fx under API og AI-værktøjer i Record.",
    none: "Intet login (en offentlig server)",
    signIn: "Log ind med {server}",
    signInAgain: "Log ind igen",
    signingIn: "Åbner login…",
    signedIn: "Logget ind. Den læser nu, hvad serveren tilbyder.",
    serverUrl: "Serverens adresse",
    serverUrlHint: "MCP-adressen, som regel med /mcp til sidst.",
    apiKey: "API-nøgle",
    apiKeySaved: "En nøgle er gemt. Lad feltet stå tomt for at beholde den.",
  },
  tools: {
    title: "Hvad assistenten må bruge",
    lead: "Værktøjer, serveren tilbyder, og hvilke assistenten må bruge i denne graf. Værktøjer, der kun læser, er slået til fra start. Værktøjer, der ændrer noget på serveren, er slået fra, og selv når de er slået til, venter hver brug på din godkendelse.",
    none: "Serveren er ikke læst endnu. Tjek nu for at se dens værktøjer.",
    reads: "Læser",
    writes: "Ændrer noget, spørger dig først",
    save: "Gem valg",
    saved: "Gemt",
    resources: { one: "Den tilbyder også {count} ressource.", other: "Den tilbyder også {count} ressourcer." },
    readAt: "Som serveren beskrev dem {ago}.",
    serverSays: "Serverens egen beskrivelse",
  },
  approval: {
    title: "Godkend dette?",
    body: "{connection} vil bruge “{tool}”, som ændrer noget hos {server}.",
    args: "Med",
    approve: "Godkend og kør",
    deny: "Lad være",
    done: "Udført.",
    denied: "Ikke udført.",
    expires: "Godkendelsen udløber {when}.",
  },
  data: "Det, serveren svarer, vises som data. My Graph følger aldrig instruktioner i det.",
};

export default messages;
