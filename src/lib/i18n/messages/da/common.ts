import type { MessageTree } from "../../core";

/** Ord der bruges overalt. */
const messages: MessageTree = {
  save: "Gem",
  saving: "Gemmer…",
  saved: "Gemt.",
  cancel: "Annuller",
  close: "Luk",
  back: "Tilbage",
  continue: "Fortsæt",
  edit: "Rediger",
  remove: "Fjern",
  open: "Åbn",
  more: "Mere",
  loading: "Henter…",
  signOut: "Log ud",
  signIn: "Log ind",
  couldNotSave: "Det kunne ikke gemmes. Prøv igen.",
  somethingWrong: "Noget gik galt. Prøv igen.",
  you: "Dig",
  today: "I dag",
  yesterday: "I går",
  justNow: "lige nu",
  ago: "for {time} siden",
  roles: { owner: "Ejer", parent: "Forælder", child: "Barn", guest: "Gæst" },
};

export default messages;
