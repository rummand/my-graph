/**
 * Digital Post (mit.dk / e-Boks): a "how this works" card in the Danish connectors, not a sync (yet).
 *
 * What works today, without any sign-in to Digital Post:
 *   1. The notice emails. mit.dk and e-Boks can email you when a letter arrives ("Du har modtaget ny post …"). The
 *      Gmail, Outlook and IMAP connectors already bring those emails in; the reading pipeline recognises them
 *      (src/lib/importers/dk/digital-post.ts) and proposes a reminder "New letter from <sender> in Digital Post".
 *   2. The letters themselves. Save a letter as PDF in mit.dk (or share it from the iPhone with "Send to My Graph");
 *      the pipeline recognises Danish public letters (importers/dk/public-letter.ts): the sender becomes an
 *      organization and every deadline ("frist", "senest den …", "svarfrist") a reminder, each with its quote.
 *
 * Why there is no direct sync in this round: Digital Post has no API for a citizen's own apps. The community clients
 * (e.g. Net::MitDK in Perl) sign in through MitID like a browser and then keep a mit.dk session alive whose tokens
 * last about 20 minutes, so they need a renewal daemon running all the time and a fresh MitID approval whenever it
 * misses a beat. That is the same shape as our Aula route (helper at home + pairing code, dk/aula), but mit.dk's
 * private REST API is undocumented, changes without notice, holds the most sensitive post a household gets (tax,
 * health, courts), and can't be tested here without a real MitID. It is a candidate for the next round, read-only,
 * reusing the Aula helper pattern; until then this manifest stays `coming_soon` and nothing is ever fetched.
 */
import { z } from "zod";
import { defineManifest } from "../../manifest";
import type { Connector } from "../../types";

export const digitalPostManifest = defineManifest({
  id: "digital_post", version: "1", status: "coming_soon", icon: "letter", region: "dk",
  graphKinds: ["family", "personal", "partner"],
  auth: { type: "mitid_session" },
  config: z.object({}),
  secrets: z.object({}),
  fields: [],
  streams: [],
  schedule: { everyMinutes: 60 },
  rateLimit: { perMinute: 10, backoff: "exponential" },
  maps: {},
});

/** No sync: the store refuses to create a coming-soon connection and the runner never runs one. */
export const digitalPostConnector: Connector = { manifest: digitalPostManifest };
