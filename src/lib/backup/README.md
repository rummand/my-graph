# Backups

Every night (03:00 Europe/Copenhagen by default) the app writes an encrypted backup to the volume and, when S3-compatible
storage is set up, copies it off-site. The platform admin sees the state and can press **Back up now** at
`/admin/backups`. Restoring is done from a terminal with `scripts/restore.ts`.

## What a backup is

A folder `BACKUP_DIR/<id>/`, e.g. `/data/backups/20261104T020000Z-nightly/`:

| File | What |
| --- | --- |
| `database.sql.gz.mgbk` | `pg_dump --no-owner --no-privileges`, gzipped, encrypted (when a new enough `pg_dump` is installed) |
| `database.ndjson.gz.mgbk` | otherwise: every table in `public` and `drizzle`, one JSON object per row, gzipped, encrypted |
| `uploads.json.gz.mgbk` | every uploaded file the database refers to: storage key, sha256, size, present on disk |
| `meta.json` | plain JSON, no secrets: when, format, sizes, checksums, row counts per table, off-site result |

A folder is written as `<id>.partial` and renamed when complete. Uploaded files are content-addressed and never change,
so on the volume they aren't copied again; off-site, each one is copied once, encrypted, to `<prefix>files/<key>.mgbk`.

Encryption: AES-256-GCM, key = scrypt(`BACKUP_KEY`, per-file salt). Header `MGBK` + version + salt + IV, then the
ciphertext, then the 16-byte tag (see `crypto.ts`). A wrong key or any changed byte is refused.

Retention, on the volume and in the bucket: the newest backup of each of the last **7 days** that have one, plus the
newest of each of the last **4 ISO weeks** (`BACKUP_KEEP_DAILY`, `BACKUP_KEEP_WEEKLY`). Failed or partial backups go
after 2 days.

## Owner setup (Railway)

1. **Key (required in production).** Generate one and add it to the service's variables, then store a copy in your
   password manager. Without this key no backup can ever be read.
   ```
   openssl rand -base64 32       # → BACKUP_KEY
   ```
   Without `BACKUP_KEY`, production refuses to back up and the admin page says so in red.
2. **Off-site copy (strongly recommended).** Create a bucket and an access key limited to it (Cloudflare R2, Backblaze
   B2, AWS S3, Hetzner, Scaleway, MinIO…) and set:
   ```
   BACKUP_S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com   # the S3 API endpoint, no bucket in it
   BACKUP_S3_BUCKET=my-graph-backups
   BACKUP_S3_KEY=<access key id>
   BACKUP_S3_SECRET=<secret access key>
   BACKUP_S3_REGION=auto            # optional; default us-east-1 (R2 accepts both)
   BACKUP_S3_PREFIX=my-graph/       # optional
   BACKUP_S3_FILES=0                # optional: don't copy uploaded files, only the database and the file list
   ```
   Path-style URLs are used (`endpoint/bucket/key`). Single uploads up to 5 GB.
3. **Optional:** `BACKUP_TIME=03:00`, `BACKUP_TZ=Europe/Copenhagen`, `BACKUP_FORMAT=auto|pg_dump|json`,
   `BACKUP_DIR` (default: next to `UPLOAD_DIR`, i.e. `/data/backups`), `BACKUP_DISABLED=1` to stop the nightly run.
4. The Docker image installs `postgresql-client-17` (pg_dump/psql). With an older client than the server, backups use the
   JSON format instead, which restores just as well (it needs the migrations, which the restore script applies).
5. The nightly timer starts with the server once `src/instrumentation.ts` calls `startDataSafetyScheduler()` (see the
   workstream report); until then it starts the first time the admin Backups page, Settings or an export is opened.
6. After the first night, open `/admin/backups` and check "Last backup" says OK and "Off-site copy" says Copied.
   Then do a test restore (below) once, so you know it works before you need it.

## Restoring

Always into a new, empty database first; check it; then point the app at it.

```
# From a checkout of this repo, with the backup folder copied from the volume:
BACKUP_KEY=… npx tsx scripts/restore.ts ./20261104T020000Z-nightly --database-url postgres://…/mygraph_restored

# Or straight from the bucket, also fetching uploaded files the target volume is missing:
BACKUP_KEY=… BACKUP_S3_ENDPOINT=… BACKUP_S3_BUCKET=… BACKUP_S3_KEY=… BACKUP_S3_SECRET=… \
  npx tsx scripts/restore.ts 20261104T020000Z-nightly --from-s3 --fetch-files --upload-dir /data/uploads \
  --database-url postgres://…/mygraph_restored
```

The script checks the checksum, decrypts the whole file once to prove the key and the bytes before loading anything,
loads it in one transaction, compares row counts with the backup's own, and reports which uploads are present, fetched
or missing. `--wipe` empties a non-empty target first (never use it on the live database).

To take a backup by hand from a terminal: `npx tsx scripts/backup.ts`.
