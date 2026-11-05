import type { MessageTree } from "../../core";

/** "push" namespace (da): iPhone-notifikationer fra serveren (src/lib/push). Aldrig følsom tekst. */
const messages: MessageTree = {
  reminder: {
    title: "Påmindelse",
    due: "Nu",
    private: "Du har en påmindelse. Åbn My Graph for at se den.",
  },
  waiting: {
    title: "Venter på dig",
    body: { one: "1 forslag eller ændring venter på, at du kigger på det.", other: "{count} forslag og ændringer venter på, at du kigger på dem." },
    inGraph: { one: "1 forslag eller ændring venter i {graph}.", other: "{count} forslag og ændringer venter i {graph}." },
  },
  connection: {
    title: "En forbindelse har brug for dig",
    body: "{label} henter ikke længere noget ind. Åbn My Graph for at forbinde igen.",
  },
  clinical: {
    title: "Praksis",
    body: "Du har et nyt notat at gennemgå.",
  },
  test: {
    title: "My Graph",
    body: "Notifikationer virker på denne iPhone.",
  },
};

export default messages;
