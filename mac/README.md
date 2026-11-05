# My Graph for Mac

A menu bar app (Swift, SwiftUI, macOS 14+) that sends what a person chooses from their Mac to My Graph — Messages,
Notes, Contacts, Calendar, Reminders, Photos, watched folders, Voice Memos and Calls — and writes back the reminders
and events they approved into a "My Graph" list and calendar. It also has **Ask My Graph** (a floating panel on the
same always-active conversation as the web and the iPhone) and **Quick note**.

Agents propose, humans decide: everything the Mac sends arrives as library sources and proposals; nothing is added to
the graph until a person delivers it on the web. The Mac never changes the person's own calendars, lists, contacts or
notes. The only things it creates are a "My Graph" calendar and a "My Graph" reminders list, and the only write it
makes in My Graph is "this reminder was ticked done here" (`/outbox/ack`). Server contract: `docs/mac-app-api.md`.

## Build and run

You need Xcode 26 and [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`).

```sh
cd mac
xcodegen generate                       # writes MyGraphMac.xcodeproj (git-ignored)
xcodebuild -scheme MyGraphMac -destination 'platform=macOS' -derivedDataPath build/DerivedData build
xcodebuild -scheme MyGraphMac -destination 'platform=macOS' -derivedDataPath build/DerivedData test
open "build/DerivedData/Build/Products/Debug/My Graph.app"
```

Run `xcodegen generate` again after adding or removing files. Strings: `python3 scripts/strings.py` adds new `L("…")`
keys to `MyGraphMac/Resources/Mac.xcstrings` and lists the ones without Danish (`--check` fails the build of a CI
step when one is missing).

### Debug builds

Launch arguments (never compiled into Release):

```sh
open -n "build/DerivedData/Build/Products/Debug/My Graph.app" --args \
  -MGServer http://localhost:3917 -MGLogin anna@example.com:demo-demo-demo -MGFileSecrets
#   -MGFileSecrets       keep the session and the device token in Application Support/My Graph/debug-secrets.json
#                        instead of the Keychain (an ad hoc build changes signature on every build, and the login
#                        keychain then asks before each read)
#   -MGSnapshot <dir>    render the menu, each Settings tab, Ask and Quick note to PNGs (light + dark), then quit
#   -MGAsk "question"    with -MGSnapshot: also render Ask answering it
#   -MGOpen settings|sources|account|general|ask|note
#   -AppleLanguages "(da)" -AppleLocale da_DK
```

URL hooks (`mygraph-mac://`): `ask?q=…`, `note?q=…`, `settings`, `sync[?source=contacts]` in every build; in Debug
also `debug-add-folder?path=…`, `debug-send-sample?source=contacts|calendar|reminders|calls` (made-up items through the
real send path), `debug-note?q=…` and `debug-dump` (prints settings, permissions and source states).

The login is rate-limited (about 5 per 15 minutes per address): with `-MGFileSecrets` the session is kept, so pass
`-MGLogin` only the first time.

## How it is put together

- **Shared code, not copies.** `project.yml` compiles the iOS app's files straight from `ios/`: `Shared/API.swift`,
  `Models.swift`, `SSE.swift`, `SendKit.swift`, `CookieVault.swift`, `AppGroup.swift`, `AppLanguage.swift`,
  `Route.swift`, `PushPayload.swift`, `Localizable.xcstrings`, and `MyGraph/FromPhone/PhoneImportKit.swift` (payload
  shapes, batching, fingerprints), `ContactsSource.swift` (card mapping), `Ask/ChatModel.swift` (the SSE chat) and
  `Auth/PasskeySignIn.swift` (one `#if os(iOS)` for the window anchor). A separate `mac/project.yml` keeps the iOS
  project untouched; a local Swift package would have meant moving those files and making their API public. The Mac
  supplies its own `Keychain` (login keychain, same two calls) and sets `MGAppGroup` to a non-`group.` suite so macOS
  never asks about another app's group container.
- **Sign-in and token.** Sign-in is the iOS flow (`POST /api/auth/login`, cookies mirrored into the Keychain). Then
  `POST /api/connections/mac/device` gives this Mac a bearer token for the session's current graph (Keychain).
  Everything in the background uses only the token, on a cookie-less `URLSession`; Ask and Quick note use the session.
  Switching graph signs this Mac in to that graph (a new token); cursors start afresh for it.
- **Sync engine** (`Sync/SyncEngine.swift`): every source runs every 15 minutes, soon after FSEvents (folders, Voice
  Memos), `EKEventStoreChanged` and `CNContactStoreDidChange`, and on "Send now". One run at a time; failures wait
  1, 2, 4 … minutes (at most 6 hours); `429` waits `Retry-After`; `409` (switched off / paused) stops until the
  settings change; `401` asks the person to sign in again. Batches stay under the server's `maxBatchBytes` (5 MB; never
  over 9 MB). State: `~/Library/Application Support/My Graph/state.json` (0600) with cursors, per-item fingerprints
  (only changed contacts, events, reminders and photo details are sent, and everything once a day; the server drops
  what it already has) and file records.
- **Sources** (`Sources/`), all off until the person turns them on (here or on the web):

  | Source | Reads | Permission |
  | --- | --- | --- |
  | Messages | `~/Library/Messages/chat.db` read-only (SQLite C API); `text` or `attributedBody`; Apple-epoch nanoseconds; cursor ROWID; only conversations ticked on the web (`/connections/mac`, from the list this Mac reports) | Full Disk Access |
  | Notes | JXA through `/usr/bin/osascript` (a child of the app, so macOS asks about "My Graph"); chosen folders; never locked notes or Recently Deleted | Automation (Notes) |
  | Contacts | `CNContactStore`, mapped by the shared `ContactsSource` | Contacts |
  | Calendar | EventKit, 30 days back to 120 ahead, every calendar except "My Graph" | Calendars (full access) |
  | Reminders | EventKit, open ones and ones finished in the last 30 days, every list except "My Graph" | Reminders (full access) |
  | Photos | picked photos are uploaded (`PhotosPicker`, no library access needed) with their details; details of every photo only with a separate opt-in | Photos (for the opt-in) |
  | Folders | folders picked with `NSOpenPanel` (security-scoped bookmarks), FSEvents; `fileId` = volume UUID + inode, kept across an editor's safe save (new inode at the same path); skips hidden, temporary, packages and files over 50 MB; waits until a file has been quiet 3 s | none |
  | Voice Memos | `~/Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings` (`.m4a` …) | Full Disk Access |
  | Calls | `~/Library/Application Support/CallHistoryDB/CallHistory.storedata` (`ZCALLRECORD`), from the server's `cursors.calls` | Full Disk Access |

- **Write-back** (`Sync/WriteBack.swift`, plan in `Core/Outbox.swift`): with "Show approved events" / "Keep your My
  Graph reminders" on, `GET /outbox?since=` is turned into EventKit changes in the app's own calendar and list only.
  Events are a read-only mirror (written again if deleted there, while upcoming); a reminder ticked done in Reminders
  is acked once; a reminder the person deleted there is not put back. Each item carries "Open in My Graph: <url>".
- **UI.** Menu bar window (`.window` style): the graph and Switch, Ask (⌥⌘Space) and Quick note (⌥⌘N), "Waiting for
  you: N" (opens `/changes`), each source's last result, Settings, Pause, Quit. Settings: Account, Sources (switch,
  what is read, permission state with Allow / Open System Settings, Send now, last result), General (open at login via
  `SMAppService`, shortcut recorders, notifications). Global shortcuts use Carbon `RegisterEventHotKey` (no
  Accessibility permission). Note: Finder uses ⌥⌘Space for its search window by default; whichever registered first
  wins — General says so when the app couldn't get a shortcut.
- **Notifications**: new proposals waiting (with **Review**, opening `/changes`), and a source that needs the person
  (once per problem). **Shortcuts**: "Ask My Graph" and "Add note to My Graph" (App Intents).
- **Languages**: English and Danish (`Mac.xcstrings`, `InfoPlist.xcstrings`; the shared iOS catalog for shared code).

## Tests

`MyGraphMacTests` (no app host) compiles `MyGraphMac/Core` and `PhoneImportKit.swift`: attributedBody extraction,
Apple-epoch dates, call record mapping, Messages and Call History read from fixture databases the tests build with
sqlite3 (no real data is read), message batching by bytes into contiguous ROWID ranges, batch envelopes and limits,
file id / version decisions (including safe save), the outbox plan (create, update, delete, tick reported once, a
deleted reminder not put back, a deleted event recreated only while upcoming), Notes picking and the contract's
settings/status/outbox JSON.

## Distribution (Developer ID + notarization)

The app is **not sandboxed**: Full Disk Access (Messages, Calls, Voice Memos) is only possible outside the App Sandbox,
so it ships outside the Mac App Store as a Developer ID app.

1. **Certificates.** In the Apple Developer account, create a *Developer ID Application* certificate and install it in
   the login keychain. Set `DEVELOPMENT_TEAM` in `project.yml` (and `BUNDLE_ID` if you change it), then
   `CODE_SIGN_IDENTITY: "Developer ID Application"` for Release.
2. **Hardened runtime** is on (`ENABLE_HARDENED_RUNTIME: YES`). Entitlements (`MyGraphMac/MyGraphMac.entitlements`):
   `com.apple.security.automation.apple-events` (Notes), `…personal-information.addressbook`, `…calendars`,
   `…photos-library`. No sandbox, no JIT or library-validation exceptions. Passkey sign-in additionally needs
   `com.apple.developer.associated-domains` = `webcredentials:<your domain>` with a provisioning profile, and the
   server's `apple-app-site-association` listing `<TEAMID>.app.mygraph.mac` (see ios/README.md); without it the app
   says to use the password.
3. **Archive and export**:
   ```sh
   xcodebuild -scheme MyGraphMac -configuration Release -archivePath build/MyGraphMac.xcarchive archive
   xcodebuild -exportArchive -archivePath build/MyGraphMac.xcarchive -exportPath build/export \
     -exportOptionsPlist ExportOptions.plist     # method: developer-id, teamID: <TEAMID>
   codesign --verify --deep --strict --verbose=2 "build/export/My Graph.app"
   ```
4. **Notarize and staple** (store an app-specific password once with
   `xcrun notarytool store-credentials mygraph --apple-id <id> --team-id <TEAMID>`):
   ```sh
   ditto -c -k --keepParent "build/export/My Graph.app" build/MyGraph-mac.zip
   xcrun notarytool submit build/MyGraph-mac.zip --keychain-profile mygraph --wait
   xcrun stapler staple "build/export/My Graph.app"
   ditto -c -k --keepParent "build/export/My Graph.app" build/MyGraph-mac.zip   # zip the stapled app again
   spctl --assess --type execute --verbose "build/export/My Graph.app"
   ```
5. **Publish**: put `MyGraph-mac.zip` in the server's `MG_DOWNLOADS_DIR` (default `./downloads`); `/connections/mac`
   links `/downloads/MyGraph-mac.zip`.

Privacy permissions are tied to the signature: a signed build keeps them across updates; ad hoc builds ask again
after every rebuild (and the login keychain asks before reading the saved session — use `-MGFileSecrets` in Debug).

## What needs the person

- Full Disk Access (Messages, Calls, Voice Memos) can only be given in System Settings → Privacy & Security → Full
  Disk Access; the app opens that page and notices when it is given.
- Contacts, Calendars, Reminders and Photos show macOS's own prompt the first time the source (or write-back) is
  turned on — here or on the web; a run that finds a source on but never asked asks then and sends afterwards.
- Notes asks once for Automation ("My Graph wants to control Notes").
- Which Messages conversations and Notes folders are sent is chosen on the web (`/connections/mac`); the app sends the
  list of names (never messages or notes) and opens that page.
