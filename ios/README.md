# My Graph for iOS

A native SwiftUI app for My Graph (iOS 18+), with a share extension ("Save to My Graph") and a "Next up" widget.
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
with `MyGraphUITests` (see "UI tests").
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
#       -MGRoute memory|changes|changes:<id>|documents|history:<id>|settings|widget|node:<id>|source:<id>|chat:new|chat:<id>
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
- **Notifications.** Local notifications are scheduled for open reminders due in the next 14 days (up to 50). They
  are refreshed when the app opens and by `BGAppRefreshTask` (`<bundle id>.refresh`). The permission prompt is a card
  on Today after sign-in, never a cold system alert.
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
5. **Background fetch** and **Push Notifications** capabilities. Push is only needed once the server sends it.
6. Archive with the `MyGraph` scheme (Release), upload with Xcode Organizer, and add testers in App Store Connect.
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
2. **Push (optional, for remote notifications).**
   - A device-token route: `POST /api/devices { token, platform: "ios", locale }` and `DELETE` on sign-out.
   - A `device_tokens` table: user, graph, token, created, last seen.
   - An APNs HTTP/2 sender with a `.p8` key (`APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_KEY`, `APNS_TOPIC=app.mygraph.ios`),
     sent in-process from the existing reminder, suggestion and approval code paths.
   - Pushes should respect visibility and send titles only, without sensitive detail.
   - Local reminder notifications already work without any of this.
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

They need the dev server (`http://localhost:3917`) with the demo data, and mux for the chat and upload seeds. The
suggestions test skips when Anna has fewer than two pending suggestions; the chat test skips when the assistant
doesn't propose anything. Waits are long (up to five minutes) because the development server compiles routes on
first use. The tests change Anna's data the way a person would: a suggestion approved and one denied, a reminder made
and ticked, a reminder added from chat, and a few library facts delivered.

## Not verified on the simulator

- Uploading from Photos, Files, the camera, and the document scanner. The camera and VisionKit scanner don't run on
  the simulator; their menu items are hidden or disabled there.
- Saving through the share extension from another app.
- Adding the widget to the Home Screen. Its view was checked inside the app at widget sizes.
- "Always allow" on a suggestion or a chat proposal (the UI tests cover Approve and Deny, which share the code path).
- The language switch in Settings: it saves on the account, and SwiftUI text switches at once through `\.locale`, but
  text built in code (`String(localized:)`) follows only after the app is opened again.
