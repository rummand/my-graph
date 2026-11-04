"use client";
/**
 * Google's own file picker for a Drive connection (drive.file: My Graph only ever sees what is picked here). The
 * picker runs in the browser, so it gets the person's own short-lived token for this connection from our server
 * (POST, same-origin, never cached), and Google's script from apis.google.com.
 */
import { api } from "./bits";

type PickerDoc = { id: string; name: string; mimeType: string };
type PickerData = { action: string; docs?: PickerDoc[] };
type PickerBuilder = {
  addView(v: unknown): PickerBuilder; setOAuthToken(t: string): PickerBuilder; setDeveloperKey(k: string): PickerBuilder;
  setAppId(id: string): PickerBuilder; enableFeature(f: unknown): PickerBuilder; setCallback(fn: (d: PickerData) => void): PickerBuilder;
  setOrigin(o: string): PickerBuilder; build(): { setVisible(v: boolean): void };
};
type GooglePicker = {
  PickerBuilder: new () => PickerBuilder;
  DocsView: new (id?: unknown) => { setIncludeFolders(b: boolean): unknown; setSelectFolderEnabled(b: boolean): unknown };
  ViewId: { DOCS: unknown };
  Feature: { MULTISELECT_ENABLED: unknown };
  Action: { PICKED: string; CANCEL: string };
};
type Win = Window & { gapi?: { load(name: string, cb: () => void): void }; google?: { picker?: GooglePicker } };

let loading: Promise<GooglePicker> | null = null;

function loadPicker(): Promise<GooglePicker> {
  const w = window as Win;
  if (w.google?.picker) return Promise.resolve(w.google.picker);
  loading ??= new Promise<GooglePicker>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://apis.google.com/js/api.js";
    s.async = true;
    s.onerror = () => { loading = null; reject(new Error("Google's picker couldn't be loaded.")); };
    s.onload = () => w.gapi!.load("picker", () => (w.google?.picker ? resolve(w.google.picker) : reject(new Error("Google's picker couldn't be loaded."))));
    document.head.appendChild(s);
  });
  return loading;
}

/** Open the picker; resolves with what the person picked (empty when they cancelled). */
export async function openDrivePicker(connectionId: string): Promise<PickerDoc[]> {
  const [cfg, picker] = await Promise.all([
    api<{ accessToken: string; developerKey: string; appId: string | null }>(`/api/connections/oauth/${connectionId}/picker`, { method: "POST" }),
    loadPicker(),
  ]);
  return new Promise((resolve) => {
    const view = new picker.DocsView(picker.ViewId.DOCS);
    view.setIncludeFolders(true);
    view.setSelectFolderEnabled(true);
    let b = new picker.PickerBuilder().addView(view).setOAuthToken(cfg.accessToken).setDeveloperKey(cfg.developerKey)
      .enableFeature(picker.Feature.MULTISELECT_ENABLED).setOrigin(window.location.origin)
      .setCallback((d) => {
        if (d.action === picker.Action.PICKED) resolve((d.docs ?? []).map((x) => ({ id: x.id, name: x.name, mimeType: x.mimeType })));
        else if (d.action === picker.Action.CANCEL) resolve([]);
      });
    if (cfg.appId) b = b.setAppId(cfg.appId);
    b.build().setVisible(true);
  });
}
