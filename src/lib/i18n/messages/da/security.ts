import type { MessageTree } from "../../core";

/** "security" namespace (da): adgang givet tilbage ved frakobling, og fælles grænser. t("security.<key>"). */
const messages: MessageTree = {
  revoke: {
    revoked: "My Graphs adgang er givet tilbage til {provider}.",
    microsoft: "Microsoft har ingen måde, hvorpå en app kan give et enkelt login tilbage, så My Graph har slettet sine nøgler; de holder op med at virke inden for en time. Vil du også fjerne My Graph fra din Microsoft-konto, så åbn {personalUrl} (personlig konto) eller {workUrl} (arbejds- eller skolekonto).",
    noEndpoint: "{provider} har ingen måde at give adgang tilbage på, så My Graph har slettet sit login. Vil du også afslutte det på serveren, så fjern My Graph i tjenestens egne indstillinger.",
    failed: "{provider} kunne ikke få besked lige nu, så My Graph har slettet sit login alligevel. Du kan også fjerne My Graph i indstillingerne for din {provider}-konto.",
    failedWithUrl: "{provider} kunne ikke få besked lige nu, så My Graph har slettet sit login alligevel. Du kan også fjerne My Graph på {url}.",
    none: "",
  },
  limits: {
    tooMany: { one: "Det er meget på kort tid. Vent {count} sekund, og prøv igen.", other: "Det er meget på kort tid. Vent {count} sekunder, og prøv igen." },
    paste: { one: "Det er mange indsættelser på kort tid. Vent {count} minut, og prøv igen.", other: "Det er mange indsættelser på kort tid. Vent {count} minutter, og prøv igen." },
    approvals: { one: "Der er bedt om for mange godkendelser på kort tid. Prøv igen om {count} sekund.", other: "Der er bedt om for mange godkendelser på kort tid. Prøv igen om {count} sekunder." },
  },
};

export default messages;
