# Code lists bundled with My Graph

Used by the clinical workspace (`src/lib/clinical/codes.ts`) to check the codes the assistant suggests: a code must
exist in the list, the official title is shown next to it, and a suggestion whose wording doesn't match the title is
flagged for the clinician. Nothing here is sent anywhere; the files are read on the server.

Format: `{ system, version, fetchedAt, columns: ["en", "da"], codes: { "<code>": [english | null, danish | null] } }`.

## icd10.json — ICD-10 (12,667 codes: categories and 4-character subcategories)

| Column | Source | Licence |
| --- | --- | --- |
| `en` | WHO ICD-10 Version 2019, English, read from WHO's public browser (`https://icd.who.int/browse10/2019/en`, `JsonGetRootConcepts` / `JsonGetChildrenConcepts`). | © World Health Organization. WHO allows ICD-10 to be used for health information purposes; reproducing it in a product that is distributed or sold needs WHO's permission (`https://www.who.int/about/policies/publishing/copyright`). |
| `da` | SKS — Sundhedsvæsenets Klassifikations System, diagnosis rows (`dia`, the Danish ICD-10 "SKS-D") from `https://filer.sundhedsdata.dk/sks/data/skscomplete/SKScomplete.txt`, rows still in force (valid to 2500-01-01). `DF321` → `F32.1`; Danish-only deeper levels (`DF3200`) are left out. | Sundhedsdatastyrelsen publishes SKS free of charge for use in Danish health care and IT systems. |

Codes that exist only in SKS (Danish additions at the 3–4 character level) have `en: null`.

## icpc2.json — ICPC-2 (686 codes, chapters A–Z, components 1–7; process codes −30…−69 left out)

| Column | Source | Licence |
| --- | --- | --- |
| `en` | ICPC-2e v7.0 (`ICPC-2e-v7.0-Title-csv.txt`), published by the Norwegian Directorate of Health on behalf of WONCA: `https://www.helsedirektoratet.no/digitalisering-og-e-helse/helsefaglige-kodeverk/icpc/icpc-2e--english-version`. | © WONCA International Classification Committee (WICC). Free for non-commercial use in primary care; commercial use (selling software that contains it) needs a licence from WONCA. |
| `da` | "ICPC-2 Danish / Dansk" (WICC), the Danish PDF on the same page, titles as printed. | © WONCA; Danish translation by DSAM / KiAP. Same terms. The official ICPC-2-DK used in Danish general practice is maintained by KiAP (`https://kiap.dk`); ask KiAP for the current file before production use. |

## Updating

The builder lives outside the app (it is a one-off): download the four sources above, then for ICD-10 crawl the WHO
browser chapters → blocks → categories → subcategories and join with the SKS `dia` rows; for ICPC-2 parse the English
CSV and the Danish PDF's text lines `^[A-Z]\d\d <title>`. Keep the same JSON shape.

Fetched: 2026-11-04.
