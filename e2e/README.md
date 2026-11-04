# End-to-end tests

Playwright tests that drive the running dev server as the seeded demo household (`npm run db:seed`).

```sh
npm run test:e2e                       # everything, against http://localhost:3917
npm run test:e2e -- e2e/flows.spec.ts  # one file
npm run test:e2e -- --grep-invert @slow  # skip the tests that wait on mux (chat, highlights, upload, documents)
E2E_BASE_URL=http://localhost:3000 npm run test:e2e
```

- Chromium comes from `~/Library/Caches/ms-playwright` (Playwright 1.56 → chromium-1194); set `PLAYWRIGHT_BROWSERS_PATH` if yours is elsewhere.
- `global.setup.ts` signs Anna, Mikkel and Sara in through `/api/auth/login` (with an `Origin` header, as the CSRF check
  wants), resets them to English, light theme and a known graph, and saves their cookies as storage state.
- Results, traces, the HTML report and storage state go to `$TMPDIR/my-graph-e2e` (override with `E2E_OUT`). Keep them
  out of the project: files written inside it while `next dev` runs make the dev server refresh open pages, which
  interrupts navigations mid-test.
- One worker, in order: the tests share one database and some change Anna's language and theme (and put them back).

| File | What it covers |
| --- | --- |
| `auth.spec.ts` | sign-in form, wrong password, sign-out, graph switcher |
| `pages.spec.ts` | every main page in Family and Work: loads, no 5xx, no page errors, no raw message keys or `{placeholders}`, no family wording in Work |
| `flows.spec.ts` | Today, chat answer with steps, approving a chat proposal, live highlights + Send in Work, library upload → proposal → partial deliver → drop the rest, Changes filters, History compare, add a person, wiki create + edit, Brain Keeper Run now, Automations Run now, Connections, a one-pager document, theme switch |
| `roles.spec.ts` | Emma (child): device approval by a parent in Settings → Family, no Memory/Automations, parents-only people hidden, cannot deliver; Sara cannot open Anna's ids, cannot switch into her graph, and a cross-site write is refused |
| `language.spec.ts` | switch to Danish in Settings, then every main page in Family and Work: no English in the app's own words, no raw keys |
| `a11y.spec.ts` | axe (WCAG 2.1 A/AA) on the main pages and sign-in, light and dark; fails on serious or critical issues |

Known and accepted:
- axe's experimental `label-content-name-mismatch` is off. It still flags the people circles (aria-label is the full
  description, the visible text is the first name), timeline clusters (`<g>` with a count) and library cards (the
  thumbnail shows an excerpt).
- There is no guest in the seed, so guests aren't covered.
- Slow on a busy dev server: the first visit to a route compiles it (10–60 s). Chat, highlights, upload and documents
  wait on mux (up to a few minutes).
