import { requireUser } from "@/lib/auth";
import { Shell } from "@/components/shell";

/** Every signed-in page lives under (app) and gets the shell. Public pages (login, setup) live outside it. */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const viewer = await requireUser();
  return <Shell viewer={viewer}>{children}</Shell>;
}
