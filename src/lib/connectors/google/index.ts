/**
 * Google connectors (server-only): Gmail, Google Calendar and Google Drive, each its own connection with its own
 * sign-in and the narrowest read-only scope. They run with the household's own Google app (GOOGLE_CLIENT_ID/SECRET).
 */
import type { Connector } from "../types";
import { runDeps } from "../oauth/deps";
import { requireSignIn } from "../oauth/fields";
import { googleCalendarManifest, syncGoogleCalendar, type GoogleCalendarConfig } from "./calendar";
import { googleDriveManifest, syncGoogleDrive, type GoogleDriveConfig } from "./drive";
import { gmailManifest, syncGmail, type GmailConfig } from "./gmail";
import { googleContactsManifest, syncGoogleContacts, type GoogleContactsConfig } from "./contacts";
import { keepContacts } from "../carddav/keep";
import { googlePhotosManifest, syncGooglePhotos, type GooglePhotosConfig } from "./photos";

export const gmailConnector: Connector<GmailConfig> = {
  manifest: gmailManifest,
  check: (_c, s) => requireSignIn(s),
  sync: (ctx) => syncGmail(ctx, runDeps(ctx)),
};

export const googleCalendarConnector: Connector<GoogleCalendarConfig> = {
  manifest: googleCalendarManifest,
  check: (_c, s) => requireSignIn(s),
  sync: (ctx) => syncGoogleCalendar(ctx, runDeps(ctx)),
};

export const googleDriveConnector: Connector<GoogleDriveConfig> = {
  manifest: googleDriveManifest,
  check: (_c, s) => requireSignIn(s),
  sync: (ctx) => syncGoogleDrive(ctx, runDeps(ctx)),
};

/** Google Photos: only the photos the person picks in Google's picker (see photos.ts). */
export const googlePhotosConnector: Connector<GooglePhotosConfig> = {
  manifest: googlePhotosManifest,
  check: (_c, s) => requireSignIn(s),
  sync: (ctx) => syncGooglePhotos(ctx, runDeps(ctx)),
};

export const googleContactsConnector: Connector<GoogleContactsConfig> = {
  manifest: googleContactsManifest,
  check: (_c, s) => requireSignIn(s),
  sync: (ctx) => syncGoogleContacts(ctx, runDeps(ctx), keepContacts),
};
