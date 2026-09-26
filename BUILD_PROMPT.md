# SecondLook: build prompt for Claude Code (v2)

Paste everything below the line into Claude Code in an empty folder.

---

You are helping me build **SecondLook** for OwlHacks 2026 (Temple University hackathon). I'm solo, the deadline is roughly 9am tomorrow, and everything must run for free. Build it in the phases below, in order. At the end of each phase, run the checks listed, fix what fails, show me the result, and then continue. Don't skip ahead, and don't add features I didn't ask for. Depth beats breadth: one flow that works perfectly is worth more than many half-working features.

This folder already contains `CLAUDE.md` (standing rules; follow them) and `PROGRESS.md` (the checklist). Save this prompt as `BUILD_PROMPT.md` so future sessions can read it. After every phase, update `PROGRESS.md`: check off finished items, set the current phase and time, record the scoreboard result, and note decisions and known issues. If a session restarts, read `CLAUDE.md` and `PROGRESS.md` first and continue from the current phase.

## What SecondLook does

A patient uploads two documents: their **hospital bill** and their insurer's **explanation of benefits (EOB)**. SecondLook reads both, lines them up, and finds errors: duplicate charges, insurance payments that were never applied, a bill total higher than what the insurer says the patient owes, and similar problems.

It then:
- tells the patient in plain English what they likely owe, with the evidence and the math,
- explains confusing terms on the bill,
- writes a dispute letter and tracks the dispute,
- lets the patient practice the billing phone call with an AI billing representative.

Hackathon goals shape the design:
- **Health & Wellness track:** a practical tool for a real problem. 43% of US adults say they've received a medical bill they believed was wrong (KFF).
- **AI & Agents track:** Gemini reads the documents and explains them; the dispute agent tracks, follows up and escalates; the AI rep runs call practice.
- **HCI track:** the side-by-side reconciliation view and accessible, plain-language design are the core of the product, not decoration.
- **Prizes:** Best Use of Gemini API, Best Use of ElevenLabs.

## Non-negotiable design rules
1. **Code decides what's an error, never the AI.** Gemini only (a) extracts line items from images into JSON, (b) rewrites already-computed findings in friendlier language, (c) explains terms using only the documents and verified findings, and (d) plays the billing rep in call practice without inventing facts about the claim. Every flag comes from deterministic rules with evidence (which bill line, which EOB line) and arithmetic.
2. **Made-up data only.** All test documents are fictional; say so in the UI. Never store uploaded files. Keep only extracted JSON, in memory.
3. **Works without API keys.** Test cases, the rules engine, the UI, the explainer, the letter, the dispute agent and call practice all work with no keys set, using deterministic fallbacks. Gemini and ElevenLabs are optional layers.
4. **Keep it simple:** Node 18+ with Express, plain HTML/CSS/JS frontend (no framework, no build step), no database. Everything that persists lives in memory on the server.
5. **Money is never invented.** Potential savings (detected but unresolved) and confirmed savings (after a dispute is resolved) are always shown separately. Only resolved disputes count as saved.

## File layout
```
secondlook/
  package.json            (scripts: start, generate, score)
  server.js               (Express app)
  src/rules.js            (rules engine, pure functions, no I/O)
  src/letter.js           (dispute letter, follow-up letter, call script: deterministic templates)
  src/explain.js          (term/finding explanations: deterministic glossary + optional Gemini)
  src/disputes.js         (in-memory dispute store and state changes)
  src/callpractice.js     (scripted rep + optional Gemini rep + deterministic checklist scoring)
  src/extract.js          (Gemini extraction)
  src/gemini.js           (shared Gemini REST helper with timeout)
  src/tts.js              (ElevenLabs text-to-speech)
  data/generate.js        (builds test cases + answer key)
  data/cases/*.json       (generated)
  data/answer_key.json    (generated)
  scripts/score.js        (runs rules on every case, prints scoreboard)
  public/index.html, public/app.js, public/styles.css
  .env.example            (GEMINI_API_KEY, GEMINI_MODEL, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID)
  README.md
```

## Data model (use exactly this shape; extraction must output it too)
```js
// Bill
{ id, provider: { name, address }, patient: { name }, account_number, statement_date,
  lines: [ { line_no, date: "YYYY-MM-DD", code, description, charge } ],
  adjustments: [ { description, amount } ],          // e.g. "Contractual adjustment"
  insurance_payments: [ { date, payer, amount } ],
  patient_payments: [ { date, amount } ],
  amount_due }                                        // what the bill says the patient owes

// EOB
{ id, insurer, member: { name, id }, claim_number, provider_name,
  network: "in-network" | "out-of-network",
  service_type: "emergency" | "office" | "imaging" | "lab" | "therapy",
  lines: [ { date, code, description, billed, allowed, insurer_paid, patient_resp } ],
  totals: { billed, allowed, insurer_paid, patient_resp } }
```
Each test case also carries `profile: { id, name, relation }` (e.g. `{ id: "maya", name: "Maya Torres", relation: "self" }`), so the optional family feature in Phase 7 has data. Use 3–4 fictional family members across the 18 cases.

## PHASE 1: Test data (`npm run generate`)

Write `data/generate.js` with a seeded random generator so output is reproducible. It creates 18 cases, each `{ id, title, profile, bill, eob }`, plus `data/answer_key.json` in the form `{ [case_id]: { errors: [ { type, amount } ], expected_owe } }`.

Use real CPT codes with plain descriptions and **fictional** providers, insurers and patients. Avoid real brand names. Suggested codes: 99283–99285 (ER visit levels 3–5), 73610 (ankle X-ray, 3+ views), 29540 (ankle strapping), 93000 (ECG), 71046 (chest X-ray, 2 views), 80053 (comprehensive metabolic panel), 85025 (CBC), 36415 (blood draw), 12002 (wound repair 2.6–7.5 cm), 90715 (Tdap vaccine), 90471 (vaccine administration), 99213 (office visit), 80061 (lipid panel), 70450 (CT head without contrast), 96374 (IV push), 72148 (MRI lumbar spine), 97161 (PT evaluation), 97110 (therapeutic exercise), 84443 (TSH), 99070 (supplies).

Build each case correctly first, then plant errors:
- Correct EOB per line: `allowed` is 35–60% of `billed`; `patient_resp` is a copay or coinsurance share of `allowed`; `insurer_paid = allowed − patient_resp`.
- Correct bill: same lines and charges; one "Contractual adjustment" equal to Σ(billed − allowed); one insurance payment equal to Σ insurer_paid; `amount_due = Σcharge − Σadjustments − Σinsurance_payments − Σpatient_payments`.
- **Always recompute `amount_due` after planting errors.**

Error types (these exact strings):
- `duplicate_charge`: a non-visit line appears twice on the bill. Amount = that line's charge.
- `missing_insurance_payment`: an insurance payment is removed or reduced on the bill. Amount = the missing part.
- `not_submitted_to_insurance`: a bill line that doesn't appear on the EOB at all. Amount = its charge.
- `adjustment_missing`: in-network, but the contractual adjustment is missing or too small. Amount = the shortfall.
- `charge_mismatch`: a bill line's charge is higher than the EOB's billed amount for the same date and code. Amount = the difference.
- `surprise_bill_nsa`: out-of-network **emergency**. The EOB shows in-network cost sharing (as the No Surprises Act requires), but the bill has no contractual adjustment. Amount = the shortfall.

Case 1 must be exactly this **hero case** ("Maya, ER visit for a sprained ankle"):
- Bill lines on the same date: 99284 ER visit $1,100; 73610 ankle X-ray $380; 73610 ankle X-ray $380 (duplicate); 29540 ankle strapping $180. Total charges $2,040.
- Contractual adjustment $800. Insurance payments: none shown. Amount due **$1,240**.
- EOB (in-network, emergency), one X-ray only:
  - 99284: billed 1,100, allowed 560, paid 410, patient 150
  - 73610: billed 380, allowed 180, paid 110, patient 70
  - 29540: billed 180, allowed 120, paid 90, patient 30
  - Totals: allowed 860, insurer paid 610, patient 250.
- Answer key: `duplicate_charge` 380 and `missing_insurance_payment` 610, `expected_owe` **250**. The math must read $1,240 − $380 − $610 = $250.

The other 17 cases: 4 with no errors (one of them includes a prior patient payment), and the rest with 1–2 planted errors covering every error type at least twice. Include 2 out-of-network emergency cases for `surprise_bill_nsa`.

**Check:** run `npm run generate`. Print a table of case id, profile, title, planted errors and expected_owe. Verify for every case that `amount_due` matches its own lines and payments.

## PHASE 2: Rules engine and scoreboard (`npm run score`)

`src/rules.js` exports `check(bill, eob)` and returns:
```js
{ flags: [ { id, type, title, amount, explanation, what_to_ask, evidence: { bill_lines: [line_no], eob_lines: [index] } } ],
  matches: [ { bill_line_no, eob_index, status: "ok" | "charge_mismatch" } ],
  unmatched_bill_lines: [ { line_no, reason: "duplicate" | "not_on_eob" } ],
  summary: { amount_due, likely_owe, pending_amount, potential_savings },
  math: [ { label, amount } ],       // step-by-step from amount_due down to likely_owe
  notes: [ string ] }
```

Logic:
1. **Match lines** by key `date|code`. For each bill line, take the first unused EOB line with the same key → match; if the key exists on the EOB but all are used → `duplicate_charge`; if the key isn't on the EOB → `not_submitted_to_insurance`.
2. **Charge mismatch:** a matched line with bill charge > EOB billed (tolerance $0.50) → flag the difference.
3. **Missing payment:** EOB total insurer_paid − Σ bill insurance_payments > $0.50 → flag.
4. **Adjustment:** expected = Σ(billed − allowed) over matched lines. Shortfall = expected − Σ bill adjustments. If shortfall > $0.50:
   - out-of-network emergency → `surprise_bill_nsa`, and mention the No Surprises Act in plain words;
   - in-network → `adjustment_missing`;
   - out-of-network, not emergency → no flag, just a note that balance billing may be allowed and to ask for an itemized explanation.
5. **likely_owe** = Σ patient_resp over matched EOB lines − Σ patient_payments (never below 0). **pending_amount** = charges on `not_on_eob` lines, which should go to insurance first. **potential_savings** = amount_due − likely_owe − pending_amount (never below 0).
6. **Math:** start at amount_due, subtract each flag amount, and compare the result to likely_owe. If a leftover difference is more than $0.50, add an `unexplained_difference` flag. Be honest rather than hide it.
7. Explanations are plain English at about a 6th-grade reading level, e.g. "You were charged twice for the same ankle X-ray on March 3. Your insurer only has it once."

`scripts/score.js` runs `check` on every case and compares flag types (with counts) to the answer key. Print per case: planted, found, missed, false alarms, and whether likely_owe matches expected_owe. Then print totals: "Caught X of Y planted errors, Z false alarms, W of 18 owed amounts correct." Also write the results to `data/scoreboard.json` for the UI.

**Check:** the scoreboard must show 100% on this synthetic set. If not, fix the rules, not the data, unless the data is actually wrong. Add 3 unit-style assertions for the hero case directly in score.js.

## PHASE 3: Server, letters and explanations

`src/gemini.js`: one helper that calls the Gemini REST API (`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=...`) with a 20-second timeout. Returns `null` when no key is set, so callers fall back cleanly. Default `GEMINI_MODEL` to a current Flash model, configurable by env.

`src/letter.js`, all deterministic:
- `buildLetter(bill, eob, result)` → a dispute letter with placeholders for the patient's address, listing each flag with dates, codes, amounts and the EOB claim number, requesting a corrected itemized bill, and asking that the account not go to collections during the dispute.
- `buildFollowUpLetter(dispute)` → a follow-up referencing the original date sent and the same findings.
- `buildCallScript(result)` → "Hi, I'm calling about account [number]. I'm disputing line 3, a duplicate ankle X-ray on [date]…"

`src/explain.js`:
- `explainTerm(term, context)` with a deterministic glossary for at least: EOB, allowed amount, contractual adjustment, patient responsibility, deductible, coinsurance, copay, in-network, out-of-network, balance billing, CPT code, No Surprises Act, itemized bill. Also every CPT code used in the test data.
- `explainFinding(flag, bill, eob)` → deterministic explanation that quotes the exact bill line and EOB line.
- If Gemini is available, optionally rewrite the deterministic explanation to be friendlier. Pass only the glossary entry, the documents and the verified findings. **Verify every number in Gemini's text appears in the deterministic version; if not, use the deterministic version.**

`src/extract.js`: send the image as inline data with `responseMimeType: "application/json"` and a prompt containing the exact JSON shape above. Validate the output (numbers are numbers, required fields exist) and return clear errors. Cache results by image hash in memory.

`src/tts.js`: ElevenLabs text-to-speech REST call with `xi-api-key`, voice id from env, 15-second timeout.

`server.js` (Express, port 3000), loading `.env` with a tiny parser or dotenv:
- `GET /api/cases` → `[ { id, title, profile } ]`
- `GET /api/cases/:id` → `{ bill, eob, profile }`
- `POST /api/check` with `{ bill, eob }` → `check()` result plus `letter` and `call_script`
- `POST /api/explain` with `{ term }` or `{ flag_id, bill, eob }` → `{ text, source: "glossary" | "gemini" }`
- `POST /api/extract` with `{ image_base64, mime_type, doc_type: "bill" | "eob" }` → structured JSON. HTTP 501 with a clear message if no Gemini key.
- `POST /api/tts` with `{ text }` → audio/mpeg. HTTP 501 if no ElevenLabs key.
- `GET /api/scoreboard` → contents of `data/scoreboard.json`
- Serve `public/`.

**Check:** start the server. Curl `/api/cases`, `/api/check` with the hero case (print flags, summary, letter, call script), and `/api/explain` for "contractual adjustment" and for the hero duplicate flag. Everything works with no keys.

## PHASE 4A: Web app core (the HCI track, so make it genuinely good)

A single page, `public/index.html` + `app.js` + `styles.css`:
1. **Header:** "SecondLook: check your medical bill against your insurance." A visible note: "Demo uses made-up bills. Nothing you upload is stored."
2. **Input:** a dropdown of test cases (hero case selected by default) and an "Upload your own" option with two file inputs (bill, EOB) that call `/api/extract`, then `/api/check`. Show a friendly error if extraction isn't configured.
3. **Result hero card:** "The bill says **$1,240**. Based on your insurer's statement, you likely owe **$250**." Show potential savings (labeled "potential, not yet saved") and any pending amount.
4. **Reconciliation view (the key feature):** the bill table on the left, the EOB table on the right.
   - Draw SVG connector lines between matched rows; red for mismatches.
   - Show row status by label or icon, not color alone: Matched, Duplicate, Not on insurer statement, Price differs.
   - Under each table, show totals: adjustments, insurance payments, amount due vs. insurer paid and patient responsibility.
   - Redraw connectors on resize. On narrow screens, stack the tables and replace connectors with "matches EOB line 2" labels.
5. **Math steps:** $1,240 → minus duplicate X-ray $380 → minus insurance payment not applied $610 → **$250**, matching the insurer's statement.
6. **Findings list:** each flag shows its title, amount, plain explanation, "what to ask," and a "Show me" button that highlights its evidence rows in both tables.
7. **"Break it" mode (for judges):** a toggle that makes the bill table editable (charge, date, code), with buttons to duplicate or delete a row and edit the adjustment and insurance payment amounts. A "Re-check" button calls `/api/check`, and everything updates live.

**Check:** load the page and walk through the hero case. In break-it mode, add a new duplicate and confirm a new flag appears; delete the duplicate and confirm the flag disappears. Test at a 400px width. Fix anything broken before moving on.

## PHASE 4B: Explainer, letter, accessibility
8. **Document Explainer:** billing terms on the page (e.g. "Contractual adjustment," "Allowed," "Patient responsibility," each CPT code) are buttons. Clicking one opens a small panel with the `/api/explain` answer. Each finding has a "Why?" button that calls `/api/explain` with its flag and shows the answer quoting the exact lines. No open-ended chat.
9. **Letter and call script:** a textarea with the letter, a copy button (catch clipboard errors and fall back to selecting the text), and "Read results aloud" and "Play call script" buttons. Use `/api/tts`, and fall back to `speechSynthesis` on 501 or any error.
10. **Scoreboard:** a small section that loads `/api/scoreboard`: "Tested on 18 made-up bills: caught X of Y planted errors, Z false alarms."
11. **Accessibility:**
    - Use Atkinson Hyperlegible from Google Fonts (designed for low vision), with a system font fallback.
    - Meet WCAG AA contrast, label every input, support keyboard navigation with visible focus, use aria-live for result updates, and respect prefers-reduced-motion.
    - Add a "Larger text" toggle and support light and dark themes.

**Check:** click three terms and one "Why?" with no API keys and confirm sensible answers. Copy the letter, play read-aloud (the browser fallback is fine), and tab through the whole page with the keyboard only.

## PHASE 5: Dispute agent and AI call practice (AI & Agents)

**Dispute agent** (`src/disputes.js`, in memory):
- "Track this dispute" creates a record: case id, profile id, provider, account and claim numbers, verified flags with evidence, disputed amount, original amount_due, potential savings, status (`draft` → `sent` → `follow_up_due` → `resolved`), date sent, follow-up date (30 days after sending), and confirmed savings (0 until resolved).
- "Mark as sent" sets the date.
- "Simulate 30 days passing" sets the status to `follow_up_due`, auto-drafts the follow-up letter from verified findings only, and shows the escalation path: ask for a supervisor, file a complaint with the insurer, contact the state insurance department. Gemini may polish the wording; verify all numbers, dates and codes are unchanged, or fall back to the template.
- "Resolve dispute" takes the corrected amount the provider now says is owed. **Confirmed savings = original amount_due − resolved amount, never below 0.** Show it on the dispute card as "Saved $990" (for the hero case, if resolved at $250), clearly separate from potential savings.
- Routes: `POST /api/disputes`, `POST /api/disputes/:id/send`, `POST /api/disputes/:id/advance`, `POST /api/disputes/:id/resolve`, `GET /api/disputes`.

**AI call practice** (`src/callpractice.js`):
- "Practice my dispute call" starts a text role-play where the app plays a billing representative. Base the scenario only on the verified findings for the current case.
- **Without a Gemini key:** a scripted rep with 5 fixed turns (greeting and account check, "what are you disputing?", pushback like "our records show two X-rays," "is there anything else?", closing). Add small variations from the findings.
- **With a Gemini key:** Gemini plays the rep with a system prompt listing only the verified facts and forbidding new claims about the bill. Limit it to 6 turns.
- Speak the rep's lines with ElevenLabs when configured, otherwise `speechSynthesis`. The user types answers; voice input is optional and only if it's quick to add.
- **Score the checklist deterministically, never with the AI.** Check the user's messages for:
  1. each verified discrepancy, matched by code, date, amount or keyword like "duplicate" or "payment";
  2. the account or claim number;
  3. "itemized";
  4. "collections";
  5. a question about next steps or a timeline.
  Show a checklist with a check or cross for each and a one-line tip for anything missed.
- Routes: `POST /api/practice/start`, `POST /api/practice/:id/reply`, `POST /api/practice/:id/finish`.
- This is practice only. The app never places real phone calls; say so in the UI.

**Check:** with no keys, track the hero dispute, mark it sent, simulate 30 days, view the follow-up letter, run one full practice call and see the checklist, then resolve at $250 and confirm "Saved $990" appears while potential savings is labeled separately.

## PHASE 6: Demo polish
- `README.md`: setup, env vars, how to run, the architecture (rules decide, AI extracts and explains), and the limits (checks the bill against the insurer's statement; doesn't judge whether the medical coding was correct).
- A **demo mode** toggle that preloads the hero case with no network calls, so the demo can't be broken by rate limits or wifi.
- Every external call has a timeout and a fallback. The app never crashes on bad input or failed APIs; show friendly messages instead.

**Check:** run through the full demo path twice with no keys and once with keys (if available), start to finish.

## PHASE 7 (stretch; only if Phases 1–6 pass their checks, and skip if it's past 4am)
- **Family Bill Manager:** a profile selector using the `profile` field from the test data. Each profile shows its own claims and disputes, and the page always makes clear which family member and claim are being reviewed. No authentication, no database.
- **Cost History & Savings:** per profile and for the whole family, show original billed, insurer allowed, insurer paid, patient responsibility, patient payments, disputed amount, potential savings and confirmed savings. A running **Total Saved** counts only resolved disputes. Potential savings stays visually separate and is never added to Total Saved.

## Done means (Phases 1–6)
- `npm run generate && npm run score` shows a 100% scoreboard with the hero case correct.
- `npm start` works with **no API keys**: pick a case, see the reconciliation, flags, math, explainer, letter and call script, and break it live.
- A dispute can be tracked, followed up, practiced as a call with a deterministic checklist, and resolved, with confirmed savings separate from potential savings.
- With a Gemini key, uploading a photo of a printed test bill fills the same view.
- Nothing crashes on bad input or failed API calls.

Start with Phase 1 now.
