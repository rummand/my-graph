import { redirect } from "next/navigation";

/** "Corpora" are "Rules" now: old links land on /rules. */
export default function CorporaRedirect() {
  redirect("/rules");
}
