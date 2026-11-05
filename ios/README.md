# My Graph for iOS

A native SwiftUI app for My Graph (iOS 18+), with a share extension ("Send to My Graph") and a "Next up" widget.
It has no third-party dependencies. It talks to the same server as the web app, through the same JSON and SSE routes.

## Build and run

You need Xcode 26 and [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`).

```sh
cd ios
xcodegen generate                      # writes MyGraph.xcodeproj (git-ignored)
open MyGraph.xcodeproj                 # or build from the command line:
xcodebuild -scheme MyGraph -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -derivedDataPath build/DerivedData build
xcrun simctl install booted build/DerivedData/Build/Products/Debug-iphonesimulator/MyGraph.app
xcrun simctl launch booted app.mygraph.ios
```

The `MyGraph` scheme builds the app, `MyGraphShare` (share extension) and `MyGraphWidget` (WidgetKit), and tests
with `MyGraphTests` (unit tests of the sending and dictation logic) and `MyGraphUITests` (see "UI tests").
Run `xcodegen generate` again after adding or removing files.

## Choosing the server

- The default is production: `https://web-production-1858e.up.railway.app`.
- On the sign-in screen, tap **Server: …** to type another address. The app checks `/api/health` before it saves.
- The local development server (`http://localhost:3917`) is a hidden option. Long-press the logo on the sign-in
  screen, or tap **Version** seven times in Settings. Plain-http localhost is allowed (`NSAllowsLocalNetworking`).

Debug builds also accept launch arguments, which make simulator runs and screenshots scriptable:

```sh
xcrun simctl launch booted app.mygraph.ios -MGServer http://localhost:3917 \
  -MGLogin anna@example.com:demo-demo-demo -MGTab people -MGRoute person:<uuid>
# also: -MGAsk "question", -MGGraphs, -MGSignOut,
#       -MGRoute memory|changes|changes:<id>|documents|history:<id>|settings|widget|chats|node:<id>|source:<id>|chat:new|chat:<id>
#       -MGShareSheet file:<token>|text:<token>|url:<address>   (opens the system share sheet, for the extension test)
# language: -AppleLanguages "(da)" -AppleLocale da_DK
```

None of this is compiled into Release builds.

## How it works

- **Session.** Signing in uses `POST /api/auth/login`. The `mg_session`, `mg_device` and `mg_graph` cookies live in
  `HTTPCookieStorage`. After each response they are mirrored into the Keychain, using the App Group as the access
  group and readable after first unlock, so they survive restarts and the share extension and widget can use them.
  Cookie values are never logged.
- **Origin.** Every POST, PATCH and DELETE sends `Origin: <server origin>`, which the middleware's CSRF check accepts.
- **Sign-in states.**
  - A 401 sends you back to sign-in.
  - A 403 with `pending: true` shows "Ask a parent to approve this device"; that screen polls `/api/auth/status`.
  - Signing out keeps `mg_device`, so the device doesn't need approval again.
- **Offline.** Today, People and the graph list are cached as JSON in the App Group container. A saved session
  opens straight into the cache while the server is checked.
- **Chat.** `POST /api/chat` is read as Server-Sent Events: start, step, sources, sensitivity, delta, done and error.
  - **Stop** calls `/api/chat/:id/stop` and cancels the stream.
  - Proposals use `/api/chat/:id/proposals/:n`.
  - Mentions are typed as `@Emma` and sent as `@[Emma](node:<uuid>)`. Suggestions come from `/api/mentions`, with
    `/api/nodes?q=` as the fallback.
- **Send to My Graph** (share extension, "Send til My Graph" in Danish). Takes photos, PDFs, any file (Word,
  PowerPoint, Excel, CSV, audio…), text and links from any app. You pick the graph (it remembers the last one) and who
  can see it. Files go through the normal upload (`POST /api/library`, 20 per request, 50 MB each); text becomes a
  note and a link a saved web page (`POST /api/library/paste`, `{ kind: "text" | "url", … }`). A progress bar follows
  the upload's bytes, then "Added to <graph>". The logic is shared with Paste: `Shared/SendKit.swift`. In the share
  sheet's apps row iOS shows the containing app's name and icon ("My Graph"); the extension's screen is titled
  "Send to My Graph".
- **Paste** in the Library tab is the system Paste button (no "Allow Paste" prompt; greyed out when the clipboard has
  nothing it takes). Images and files upload; a web address is saved as a web page; other text becomes a note.
  The Library's + → Files now accepts any file type.
- **Ask opens the active session.** The Ask tab opens the server's always-active conversation
  (`GET /api/chat/active?light=1` → `{ conversationId }`, null = a new conversation is open), the same one the web's Ask
  panel opens. Every question keeps its conversation active (the server does this in `POST /api/chat`). The
  pencil button is "New conversation" (`PUT /api/chat/active { conversationId: null }`); the list button opens
  "Chats", where a tap reopens a saved session (`PUT … { conversationId }`). When the app comes back to the
  foreground it follows a switch made on the web or another device, unless an answer is being written. A server
  without `/api/chat/active` (404) opens the latest conversation instead.
- **Dictation in Ask.** The microphone button beside the question uses `SFSpeechRecognizer` with `AVAudioEngine`,
  on the iPhone itself when the language supports it ("Listening on this iPhone…"). It starts in the app's language;
  the DA/EN toggle in the listening bar (or a long press on the microphone) switches between Danish (`da-DK`) and
  English (`en-US` in the US, else `en-GB`) and restarts listening. Partial text appears in the field as you speak,
  after whatever you had typed. The keyboard's own dictation keeps working. Permission prompts are in English and
  Danish (`NSMicrophoneUsageDescription`, `NSSpeechRecognitionUsageDescription`).
- **Notifications.** Local notifications are scheduled for open reminders due in the next 14 days (up to 50). They
  are refreshed when the app opens and by `BGAppRefreshTask` (`<bundle id>.refresh`). The permission prompt is a card
  on Today after sign-in, never a cold system alert.
- **Push.** Once notifications are allowed and someone is signed in, the app registers with APNs and sends the token
  (`POST /api/devices { token, platform: "ios", environment: sandbox|production, appVersion, locale }`) on every
  start; sign-out calls `DELETE /api/devices { token }` first (the server also drops a device with its session).
  The answer's `remindersByPush` says whether the server pushes reminders; then the app stops scheduling its own local
  ones, so nothing arrives twice. A server without APNs configured answers `false` and local reminders carry on.
  A tap opens the right screen (`Shared/PushPayload.swift`): a person, a change set, Changes, Today; it switches graph
  first when the notification is about another one, and opens the web for screens the app doesn't have
  (connections, the practice). Settings → "Sent by My Graph" shows the server's switches and quiet hours
  (`/api/devices/settings`). Debug builds register as `sandbox`, Release as `production`.
- **From this iPhone** (More → From this iPhone; also Library's + menu, and a row at the top of Library while no
  source is on). Four sources, each off until the person turns it on, each with what it reads, Send now and how the
  last send went ("Sent 312 contacts to Family" → **Review what it found** opens Changes). Everything goes to
  `POST /api/import/<contacts|photos|places|health>` `{ title, visibility, data }` in the current graph, in batches
  under 9 MB (`MyGraph/FromPhone/PhoneImportKit.swift`, shapes = `src/lib/importers/schemas.ts`); the server only
  proposes changes. Per server + graph the app keeps an id → fingerprint ledger (Application Support), so later sends
  carry only what changed; a batch that fails (or a 429) stays for next time.
  - **Contacts** (`CNContactStore`, full or limited access): names, emails, phones, addresses, birthday (`--MM-DD`
    without a year), organisation, job title, related names with the iPhone's localized labels. The card's note is
    not read (Apple's notes entitlement).
  - **Photos**: by default only photos the person picks (PHPicker, no library access): each is uploaded through
    `/api/library` (HEIC, other formats and anything over 4096 px or 15 MB become JPEG, keeping date and GPS), then
    its details are sent with the upload's `sourceId`. "Also send details of every photo" is a separate opt-in
    (library access; a limited library sends only what was shared). No faces or names (PhotoKit has none).
  - **Places**: `startMonitoringVisits` with "Always" location (asked in iOS's two steps, after the explanation).
    Visits wait in a small file on the phone and are sent when the app opens or in the background refresh, at most
    every 6 hours, and only into the graph Places was turned on in. Pause, delete stored visits; turning Places off
    deletes them. "Look up place names" uses Apple Maps (CLGeocoder), 25 per send.
  - **Health** (HealthKit, read only, always `private`): latest height, weight and resting heart rate, and where
    Health Records exist (`supportsHealthRecords()`, not in Denmark today) vaccinations, conditions, medications,
    allergies, labs and procedures, with date/value/note read from the FHIR resource. The HealthKit entitlement
    (`com.apple.developer.healthkit` + `health-records`) is in `project.yml`; remove those two keys if your App ID
    doesn't have HealthKit, and the Health switch says it can't open Health.
  - Debug: `-MGRoute phone`, and `-MGPhoneSend contacts|health|places` turns a source on and sends it.
- **Widget.** "Next up" fetches reminders and today's events with the shared session. If it can't, it falls back to
  the snapshot the app writes to the App Group.
- **Design.** Colours follow DESIGN.md's tokens for light and dark (`Shared/Theme.swift`).
  - `PersonColor.hue` is an exact port of `personHue` in `src/lib/ui/person-color.ts`, checked against the TypeScript
    on real ids.
  - Graph colours use the web's `oklch(0.64 0.14 h)`.
  - Schibsted Grotesk (variable font, OFL; licence in `MyGraph/Resources/Fonts/OFL.txt` and in Settings) is scaled
    with Dynamic Type.
- **Languages.** English and Danish come from `Shared/Localizable.xcstrings`, plus `InfoPlist.xcstrings` for
  permission prompts. Every request sends `Accept-Language`. Once signed in, the account's language wins
  (`/api/auth/me` → `locale`): screens switch through `\.locale` at once and the app keeps it as its language for the
  next launch (`Shared/AppLanguage.swift`). Settings → Language saves it on the account (`PATCH /api/settings`), so
  the web and the phone agree. A `-AppleLanguages` launch argument (screenshots, UI tests) keeps the iPhone's choice.
  Server-written text (greeting, brief, suggestion labels, the week's shared row) comes in the account's language.
- **Today** is one request (`GET /api/today`), cached for offline. It shows connections that need you, what is waiting
  (suggestions and proposed changes), the brief, the week by person, to-dos, what needs attention and recent documents.
- **Changes.** Proposed changes from agents (chat, uploads, web research, the Brain Keeper) never touch the graph until
  a person delivers them. Today shows waiting proposals with Deliver, Drop and Review; Review (and More → Changes)
  opens the proposal with a tick box per change (`PATCH /api/changes/:id/changes/:changeId`), its receipts, and
  Deliver (with the proposal's fingerprint, so a stale approval is refused) or Drop. Graph viewers see them read-only.
- **History.** Person and node screens end with "What changed" (`GET /api/history?subjectId=`), linking to the
  proposal each change came from and to the full list.
- **Documents.** More → Documents lists the graph's documents (`GET /api/artifacts`), read-only; a tap opens the
  document on the web.

## TestFlight checklist

1. **Apple Developer account** (paid) and its **Team ID**. Set `DEVELOPMENT_TEAM` in `project.yml`.
2. **Bundle ids.** Defaults are `app.mygraph.ios`, `app.mygraph.ios.share` and `app.mygraph.ios.widget`. To change
   them, set `BUNDLE_ID` in `project.yml` to an id you own; the extensions follow it.
3. **App Group.** Register `group.app.mygraph.ios` (or your own; change `APP_GROUP`). Enable it for all three App IDs.
   The Keychain sharing relies on it.
4. **Associated Domains** on the app's App ID, for passkeys: `webcredentials:<your domain>` (`WEB_DOMAIN` in
   `project.yml`). The server must publish the matching file; see below.
5. **Background fetch** and **Push Notifications** capabilities (`aps-environment` is in the entitlements; Xcode
   turns it into `production` when it exports for TestFlight or the App Store).
6. **APNs key for the server.** In Certificates, Identifiers & Profiles → Keys, create a key with "Apple Push
   Notifications service (APNs)", download the `.p8` (once) and note its Key ID and your Team ID. On the server
   (Railway → Variables) set `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_KEY` (the `.p8` contents; newlines as `\n` or the
   whole file base64-encoded on one line), `APNS_BUNDLE_ID=app.mygraph.ios` (your `BUNDLE_ID`) and `APNS_ENV`
   (`production` for TestFlight/App Store; `sandbox` only if every device runs Xcode debug builds; each device's own
   environment is sent with its token and wins). Redeploy; the log says "iPhone push is on". Check with
   `POST /api/devices/test` from a signed-in iPhone session.
7. Archive with the `MyGraph` scheme (Release), upload with Xcode Organizer, and add testers in App Store Connect.
   `ITSAppUsesNonExemptEncryption` is already `false`.

## Server routes made for the app

- `GET /api/auth/me` → `{ me: { id, name, email, role, personNodeId, locale, theme, timeZone, graph: { id, name, kind,
  role, color, memberCount, isFamily } } }`. The app reads the viewer and the account's language from it.
- `GET /api/today?days=7` → everything Today shows in one request, written in the account's language: `greeting`
  (`text`, `date`), `brief`, `reminders`, `week` (`items`, `people`), `weekByPerson` (rows with entries, the shared row
  last), `suggestions` (with `kindLabel`, `originLabel`, `alwaysLabel`), `changeSets` (drafts), `recent`, `connections`
  that need the person, `attention` (unsure facts, failed uploads, possible duplicates) and `failed` (names of parts
  that couldn't load; they are null, the rest still arrives). Pure helpers and tests: `src/app/api/today/shape.ts`.
- If `/api/today` answers 404 (an older server), Today falls back to the six separate routes.

## Server changes still needed

1. **Passkeys: apple-app-site-association.** iOS only offers a passkey for an RP ID whose domain lists the app.
   - Serve `https://<APP_URL host>/.well-known/apple-app-site-association` as `application/json`, with no redirect:

     ```json
     { "webcredentials": { "apps": ["<TEAMID>.app.mygraph.ios"] } }
     ```

   - `isPublicPath()` in `src/lib/auth/constants.ts` must let `/.well-known/` through. Today the middleware would
     redirect it to `/login`. A route handler at `src/app/.well-known/apple-app-site-association/route.ts` is the
     simplest way to serve it.
   - `WEBAUTHN_RP_ID` must be that host. The native assertion's origin is `https://<rpId>`, which `expectedOrigins`
     already accepts when it equals `APP_URL`.
   - The app's passkey code is in `MyGraph/Auth/PasskeySignIn.swift`. It is not testable on localhost (`rpId` is
     `localhost`).
2. **Push** is built (`src/lib/push`, `/api/devices`); it needs only the APNs variables above.
3. **Share extension auth.** No change is needed: the extension reuses the Keychain-shared cookie. A bearer token
   would only be needed if cookies stop being shareable.
4. **History sentences.** `/api/history` returns raw events; the app writes the sentences itself
   (`MyGraph/More/HistoryViews.swift`, mirroring the web's `history` messages). A `text` field written by the server
   in the reader's language would keep the two in step.

## UI tests

`UITests/` holds an XCUITest target (`MyGraphUITests`) that drives the app against a running server as Anna and checks
every tap against the API afterwards. The tests seed what they need through their own signed-in client
(`UITests/Seeder.swift`): a to-do, a chat question the assistant answers with a reminder proposal, and a short note
uploaded to the library, whose read-through proposes a change set.

| Test | Taps |
| --- | --- |
| `testApproveAndDenySuggestionsOnToday` | Deny on one suggestion and Approve on another, on Today |
| `testTickingATodoMarksItDone` | The tick on a new to-do |
| `testApprovingAChatProposal` | Approve on a fresh chat proposal |
| `testDeliveringAChangeSetWithOneChangeLeftOut` | Opens the proposal, unticks its last change, Deliver |

```sh
cd ios && xcodegen generate
TEST_RUNNER_MG_SHOTS=/tmp/mg-shots \
  xcodebuild -scheme MyGraph -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -derivedDataPath build/DerivedData test
# another server: TEST_RUNNER_MG_SERVER=https://…   (needs anna@example.com / demo-demo-demo)
```

`SendAndAskUITests` covers the newer parts:

| Test | Does |
| --- | --- |
| `testSendingAPDFThroughTheShareExtension` | Opens the real share sheet with a PDF, picks My Graph, Send, waits for "Added to …", finds it via `/api/library` |
| `testSendingTextThroughTheShareExtension` | The same with text, which arrives as a note |
| `testPastingTextAndAnImageIntoTheLibrary` | Puts text, then an image, on the clipboard and taps Paste; checks both landed |
| `testDictationButtonListensAndSwitchesLanguage` | Taps the microphone, allows the prompts, switches to Danish, Done |
| `testAskOpensTheActiveSessionAndNewConversationSetsIt` | Sets the session through the API, checks Ask opens it; New conversation and reopening from Chats, checked on the server |

They need the dev server (`http://localhost:3917`) with the demo data, and mux for the chat and upload seeds. The
suggestions test skips when Anna has fewer than two pending suggestions; the chat test skips when the assistant
doesn't propose anything. Waits are long (up to five minutes) because the development server compiles routes on
first use. The tests change Anna's data the way a person would: a suggestion approved and one denied, a reminder made
and ticked, a reminder added from chat, and a few library facts delivered.

## Not verified on the simulator

- Uploading from Photos, Files, the camera, and the document scanner. The camera and VisionKit scanner don't run on
  the simulator; their menu items are hidden or disabled there.
- Sending through the share extension from another app (Photos, Files, Safari). The UI test shares from My Graph's
  own share sheet, which runs the same extension process and code.
- Dictation with real speech: the simulator has no voice to hear; the test checks the permission flow, the listening
  state and the language switch.
- Adding the widget to the Home Screen. Its view was checked inside the app at widget sizes.
- From this iPhone: Health (authorization sheets, Health Records), Places (real visits need a device moving
  about) and picking photos. Contacts was sent from the simulator to the dev server, and a second send said
  "Nothing new since the last send".
- "Always allow" on a suggestion or a chat proposal (the UI tests cover Approve and Deny, which share the code path).
- The language switch in Settings: it saves on the account, and SwiftUI text switches at once through `\.locale`, but
  text built in code (`String(localized:)`) follows only after the app is opened again.
