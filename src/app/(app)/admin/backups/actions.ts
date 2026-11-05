"use server";
import { revalidatePath } from "next/cache";
import { auditAdmin, requirePlatformAdmin } from "@/lib/plans/admin";
import { BackupBusy, backupRunning, runBackup } from "@/lib/backup";

export type BackupNowState = { status: "idle" | "started" | "busy" | "refused"; message?: string };

/**
 * "Back up now": platform admin only (404 for anyone else); server actions are same-origin only (Next checks Origin
 * against Host). Starts the backup in the background and returns at once; the page shows it running.
 */
export async function backUpNow(_prev: BackupNowState, _form: FormData): Promise<BackupNowState> {
  const admin = await requirePlatformAdmin();
  if (await backupRunning()) return { status: "busy" };
  await auditAdmin(admin, "admin.backup.run", { type: "backup", id: "manual" });
  void runBackup("manual")
    .then((r) => { if (!r.ok) console.error("[backup] manual backup failed:", r.error); })
    .catch((e) => { if (!(e instanceof BackupBusy)) console.error("[backup] manual backup failed:", e instanceof Error ? e.message : e); })
    .finally(() => revalidatePath("/admin/backups"));
  // Give it a moment to take the lock, so the page that reloads shows it running.
  await new Promise((r) => setTimeout(r, 400));
  revalidatePath("/admin/backups");
  return { status: "started" };
}
