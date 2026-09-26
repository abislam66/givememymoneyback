# SecondLook

**Check your medical bill against your insurance.**

SecondLook compares a hospital bill with the insurer's explanation of benefits (EOB). It lines up every charge and finds errors: duplicate charges, insurance payments that were never applied, missing in-network discounts, and more. It shows the evidence and the math side by side, explains confusing terms, writes the dispute letter, tracks the dispute, and lets you practice the billing phone call.

Built solo for **OwlHacks 2026** at Temple University. Tracks: Health & Wellness, AI & Agents, HCI.

> All bills in this demo are made up. Nothing you upload is stored.

## Run it

Needs Node 18 or newer.

```bash
npm install
npm run generate   # build the 18 made-up test bills and the answer key in data/
npm run score      # run the rules on both test sets, print both scoreboards
npm start          # http://localhost:3000
```

Optional, for testing document reading:

```bash
npm run render             # draw every test case as a realistic bill + EOB (PNG and PDF) in data/rendered/
npm run score:extraction   # needs GEMINI_API_KEY: read the rendered documents with Gemini and score them
```

`npm install` also installs Puppeteer (a dev dependency used only by `npm run render`), which downloads its own copy of Chromium.

It works with **no API keys**. Every AI feature has a fallback built from templates.

### Optional keys

Copy `.env.example` to `.env` and fill in what you have:

| Variable | What it turns on | Without it |
|---|---|---|
| `GEMINI_API_KEY` | Reading your own bill and EOB (PDF, PNG, JPG), friendlier wording, an AI billing rep for call practice | Test bills, typing numbers in by hand, glossary wording, scripted rep |
| `GEMINI_MODEL` | The model used for document extraction, rewording and the AI rep. Must be a currently available **multimodal** Gemini model (reads images and PDFs) that your key can use. Default `gemini-2.5-flash` | |
| `ELEVENLABS_API_KEY` | Natural voice for "Read results aloud", the call script and the practice rep | The browser's built-in voice |
| `ELEVENLABS_VOICE_ID` | Which ElevenLabs voice (default: a premade voice) | |

Gemini calls time out after 20 seconds and ElevenLabs after 15. If either fails, the app uses its fallback and keeps going.

**About `GEMINI_MODEL`:** model availability differs between API keys and changes over time, so SecondLook doesn't assume any model exists and never switches models silently. If the configured model is not found, not allowed for your key, or unavailable, uploads show a message that names the model and tells you to check `GEMINI_MODEL`. The server log at startup also prints the model in use. The API key is sent in a request header, never in a URL, and is scrubbed from logs.

## The demo in 60 seconds

1. The page opens on **Maya, ER visit for a sprained ankle**. The bill says **$1,240**. SecondLook says she likely owes **$250**.
2. **The math:** $1,240 − $380 (ankle X-ray billed twice) − $610 (insurance payment never applied) = $250, which matches her insurer's statement.
3. Press **Show evidence** on a problem to open the full bill & EOB comparison with the exact lines highlighted (**View the math** shows the arithmetic). Press **Why?** for an explanation that quotes those lines. Underlined words like *Contractual adjustment* open plain-English explanations.
4. Press **Break it (for judges)**. Duplicate a line, delete one, or change a charge. The rules run again and the findings update.
5. **Track this dispute** → **Mark as sent** → **Simulate 30 days passing**. SecondLook drafts the follow-up letter and shows the escalation path.
6. **Ask SecondLook** on the Results screen: tap a suggested question ("Why was this charge flagged?") or type one. Answers come only from the bill, the EOB and the rules' results, and each one can be read aloud (ElevenLabs or the browser voice, 0.75×–1.25×). **Alt + R** reads a short summary.
7. **Resolve dispute** at $250. The card shows **Saved $990**. Potential savings stay in their own box and never count as saved.

**Demo mode** (top right) loads Maya's bill from saved data and turns off every outside service, so wifi or rate limits can't break the demo.

The page is laid out in steps: **01 Upload → 02 Review → 03 Results → 04 Dispute**, then family costs and test results. A bar at the top shows where you are and jumps between steps. Detailed tables and math sit behind **View full bill & EOB comparison** and **View the math**; the letter opens with **Create dispute letter**. The previous look is kept at **/classic/** (linked in the footer).

### Checking a new document live

1. Press **Upload your own**. Choose or drag in the bill and the EOB. Supported formats: **PDF, PNG, JPG and JPEG**, up to 12 MB each.
2. Press **Read my documents**. Gemini reads each file into the same JSON the rules use. Nothing is saved.
3. The **Check what we read** screen shows every field and line, all editable. If the numbers don't add up the way a real bill should (line charges vs. the printed total, charges − adjustments − payments vs. amount due, EOB lines vs. EOB totals, paid + your share vs. allowed), it says **Please review these numbers** and highlights the fields to check. You can fix anything, add or remove lines, and see the checks update as you type.
4. Press **Confirm & Analyze**. Only now do the rules run, the same way they do on the test bills.

No Gemini key, or no wifi? Press **Type the numbers in myself** to open the same review screen blank, or switch to demo mode. The test bills always work.

## How it works

```
bill (PDF/photo) ─┐                        you review and    ┌─ findings + evidence + math
                  ├─ Gemini reads it ─►   correct numbers ─► │
EOB (PDF/photo) ──┘   (JSON only)        ("Please review")   │    src/rules.js  (code decides)
                                                             │
test bills ─────────────────────────────────────────────────►┘
                                           │
             ┌─────────────────────────────┼────────────────────────────┐
             ▼                             ▼                            ▼
   letter + call script            explanations                dispute tracker
   (templates)                     (glossary; Gemini may       + call practice
                                   reword, numbers checked)    (checklist scored by code)
```

**The rules decide. AI only reads and rewords.**

- `src/rules.js` finds every error with fixed rules. Each finding carries evidence (which bill line, which EOB line) and arithmetic. Gemini never decides what is an error.
- Gemini may only: turn a document into JSON, reword a finding or a glossary entry, and play the billing rep in practice.
- After Gemini reads a document, `src/validate.js` checks that its numbers add up and the person reviews them before any rule runs. The same checks run on the server and in the browser.
- Whenever Gemini rewrites text with numbers, dates or codes, the code checks that every one of them appears in the template version. If not, the template is used.
- The practice rep is limited to a fact sheet of verified findings, and its replies go through the same number check.
- The call checklist is scored by keyword and number matching, not by AI.
- Money is never invented. **Potential savings** (found by the checks) and **confirmed savings** (after a dispute is resolved) are always separate. Only resolved disputes count as saved.

### Error types

| Type | What it means |
|---|---|
| `duplicate_charge` | The bill has more **units** of a service (same date and code) than the EOB processed. Amount = extra units × that line's per-unit charge |
| `missing_insurance_payment` | The insurer paid more than the bill shows |
| `not_submitted_to_insurance` | A bill line isn't on the EOB at all. It should go to insurance first |
| `adjustment_missing` | In network, but the contractual discount (billed − what the insurer and patient pay) is missing or too small |
| `charge_mismatch` | A line costs more on the bill than the provider billed the insurer |
| `surprise_bill_nsa` | Out-of-network emergency care billed above in-network cost sharing (No Surprises Act) |
| `unexplained_difference` | After all the above, the math still doesn't match. Shown honestly instead of hidden |

### Units and previous balances

- **Units.** Every bill and EOB line has `units` (default 1), and a line's charge is the total for all its units. Lines are grouped by date and code, and the rules compare **total units**. One bill line of 97110 × 2 units matches two EOB lines of 1 unit each (and the other way around) with no flag. Billing 3 units when the insurer processed 2 is a `duplicate_charge` for the one extra unit, explained as "billed for 3 units, your insurer processed 2."
- **Previous balance.** A bill can carry `previous_balance` from an earlier statement, included in its amount due. The rules set it aside before checking this visit ("$75 carried over from an earlier bill; not checked here"). "You likely owe" is this visit's share, shown with the carried-over amount next to it.
- **Denied lines.** When the EOB shows a line as not covered (allowed $0, insurer paid $0, the patient owes the full charge), no contractual discount is expected on that line.

### Two test sets and their scoreboards

`npm run score` checks the rules against two independent sets and prints a scoreboard for each. Both must stay at 100%.

| Set | What it is | Result |
|---|---|---|
| Generated set (18 cases) | `npm run generate` builds them from a seeded generator: 4 clean bills and at least two of every error type | Caught 19 of 19 planted errors, 0 false alarms, 18 of 18 owed amounts correct |
| Hand-written edge cases (8 cases) | `data/handwritten/`, written by hand: same code on different dates, units split on either side, extra units, a denied line, a previous balance, cents and rounding, two errors on a 5-line bill | Caught 3 of 3 planted errors, 0 false alarms, 8 of 8 owed amounts correct |

A planted error only counts as caught if the type matches and the amount is within $0.50. The hand-written set found two gaps in the rules (denied lines and carried-over balances), which were fixed in the rules, not the cases.

### Extraction scoreboard

`npm run render` draws every case as a bill and an EOB in three different layout styles (different fonts, column orders, date formats and totals placement), with remark codes, page numbers, small print, and "SAMPLE: FICTIONAL DATA" on each page.

`npm run score:extraction` sends rendered documents through the **same extraction pipeline as live uploads** and compares Gemini's reading with the ground truth:

- line items, matched by date and code, exact on charge, units, billed, allowed, paid and patient share
- header fields: amount due, insurance payments, adjustments, network, type of care
- end to end: the rules run on what Gemini read, and the findings and owed amount are compared with the answer key

Defaults: 8 cases (the hero, 4 generated, 3 hand-written), PNG, one request every 6 seconds to stay within free-tier limits. Options: `--cases=case-01,hw-04` or `--cases=3`, `--delay=10`, `--format=pdf`, `--no-cache`. Answers are cached in `data/extraction-cache/` (sample documents only, never real uploads). Phone photos of printed documents go in `data/photos/<case_id>-bill.jpg` and `<case_id>-eob.jpg`; they're scored and reported separately as "Phone photos." Results go to `data/extraction-scoreboard.json` and appear on the page. Without a key the script says so and exits.

### Files

| Path | What it does |
|---|---|
| `server.js` | Express server and API routes |
| `src/rules.js` | Rules engine (pure functions) |
| `src/letter.js` | Dispute letter, follow-up letter, call script |
| `src/explain.js` | Glossary and finding explanations |
| `src/disputes.js` | In-memory dispute tracker |
| `src/callpractice.js` | Scripted or Gemini billing rep, checklist scoring |
| `src/extract.js` | Document extraction (prompt + response schema), shared by live uploads and the extraction scoreboard |
| `src/validate.js` | "Do these numbers add up?" checks for the review step (server and browser) |
| `src/gemini.js`, `src/tts.js` | Gemini and ElevenLabs layers with timeouts, fallbacks and clear model errors |
| `src/cpt.js` | Plain names for the CPT codes in the test data |
| `data/generate.js`, `scripts/score.js` | Generated test data and both deterministic scoreboards |
| `data/handwritten/` | Hand-written edge cases and their answer key |
| `scripts/render.js`, `scripts/score-extraction.js` | Realistic sample documents and the extraction scoreboard |
| `public/` | The web app (plain HTML, CSS and JavaScript); `upload-ui.js` is the upload and review screen, `steps-ui.js` the step bar; `public/classic/` is the previous look |

### API

`GET /api/cases`, `GET /api/cases/:id`, `POST /api/check`, `POST /api/explain`, `POST /api/extract`, `POST /api/tts`, `GET /api/scoreboard`, `GET /api/extraction-scoreboard`, `GET|POST /api/disputes`, `POST /api/disputes/:id/send|advance|resolve`, `POST /api/practice/start`, `POST /api/practice/:id/reply|finish`.

## Limits

- SecondLook checks the bill **against the insurer's statement**. It does not judge whether the medical care or the coding was correct, and it isn't legal or medical advice.
- Lines are matched by date and CPT code. Bills that use different codes than the EOB will show as "not on insurer statement."
- Everything lives in memory. Restarting the server clears disputes. Uploaded files are never saved; only the extracted numbers are kept, in memory, while you use the page.
- Extraction accuracy depends on the Gemini model and the document. The review step is there because reading can go wrong. Accuracy numbers appear only after `npm run score:extraction` has been run with a real key.
- Call practice is practice only. SecondLook never places real phone calls.
- Reading documents needs a Gemini key. Clear, flat photos or PDFs work best.
