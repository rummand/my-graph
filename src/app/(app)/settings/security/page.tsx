import { redirect } from "next/navigation";

/** Sign-in and devices now live on the settings page itself. Old links land on that section. */
export default function SecurityPage() {
  redirect("/settings#security");
}
