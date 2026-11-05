/**
 * Backups (server-only): nightly encrypted dumps of the database plus a manifest of uploaded files, kept on the
 * volume (BACKUP_DIR, default /data/backups) and copied to S3-compatible storage when configured. See ./README.md for
 * the owner's setup and how to restore. Pure rules live in ./policy, encryption in ./crypto.
 */
export { runBackup, listBackups, readState, backupDir, backupRunning, BackupBusy, type BackupMeta, type BackupState, type RunResult, type BackupListing } from "./run";
export { backupSettings, type BackupSettings } from "./policy";
export { startDataSafetyScheduler } from "./scheduler";
