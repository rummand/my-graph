import type { Viewer } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { startDataSafetyScheduler } from "@/lib/backup/scheduler";
import { cancelIfSignedIn, deletionState, listExports } from "@/lib/export";
import { exportView } from "@/lib/export/http";
import { graphsOfUser } from "@/lib/graphs/store";
import { DataExport, type ExportItem } from "./data-export";
import { DeleteAccount } from "./delete-account";
import { Row } from "./section";

/** Settings > Your data: download a copy (zip, made in the background) and delete the account (7-day grace). */
export async function DataSection({ v }: { v: Viewer }) {
  startDataSafetyScheduler();
  // Being here means they signed in: a pending deletion is cancelled (the sweep would do it within minutes anyway).
  await cancelIfSignedIn(v.id).catch(() => false);
  const [t, mine, exports, state] = await Promise.all([
    getT(), graphsOfUser(v, { includeArchived: false }), listExports(v.id), deletionState(v.id),
  ]);
  const owned = mine.filter((g) => g.myRole === "owner").map((g) => ({ id: g.id, name: g.name }));
  const items = JSON.parse(JSON.stringify(exports.map(exportView))) as ExportItem[];
  const cancelled = state?.lastCancelled?.reason === "signed_in" || state?.lastCancelled?.reason === "blocked" ? state.lastCancelled.reason : null;

  return (
    <>
      <Row id="data-h" title={t("settings.data.exportTitle")} lead={t("settings.data.exportLead")}>
        <DataExport ownedGraphs={owned} initial={items} />
      </Row>
      <Row id="delete-h" title={t("settings.data.deleteTitle")} lead={t("settings.data.deleteLead")}>
        <DeleteAccount
          email={v.email}
          scheduledFor={state?.scheduled ? state.scheduled.scheduledFor.toISOString() : null}
          cancelled={cancelled}
          blockers={state?.blockers ?? []}
          heirs={state?.heirs ?? []}
          graphHeirs={state?.graphHeirs ?? []}
        />
      </Row>
    </>
  );
}
