# CLAUDE.md: GiveMeMyMoneyBack

This file gives Claude Code the standing context for this project. Read it at the start of every session. The full build spec lives in `BUILD_PROMPT.md`; progress lives in `PROGRESS.md`.

## Project
GiveMeMyMoneyBack checks a patient's hospital bill against their insurer's explanation of benefits (EOB), finds errors with deterministic rules, shows the evidence and math side by side, explains confusing terms, writes the dispute letter, tracks the dispute, and lets the patient practice the billing phone call.

Built solo for **OwlHacks 2026** (Temple University). Submission deadline: about **9am Sunday, Sept 27, 2026**. Everything must run for free.

**Tracks:** Health & Wellness (main), AI & Agents, HCI.
**Prizes targeted:** Best Use of Gemini API, Best Use of ElevenLabs, GoDaddy domain.

## Rules that never change
1. **Code decides what's an error, never the AI.** Gemini may only extract JSON from images, rewrite already-computed findings, explain terms from the documents and verified findings, and play the billing rep without inventing facts. Every flag comes from `src/rules.js` with evidence and arithmetic.
2. **Verify AI text.** Whenever Gemini rewrites anything containing numbers, dates or codes, check they all match the deterministic version. If not, use the deterministic version.
3. **No API keys required.** Every feature has a deterministic fallback. Gemini and ElevenLabs are optional layers with timeouts (20s Gemini, 15s ElevenLabs).
4. **Uploaded files are never stored.** Only confirmed numbers + rules results may be saved to a signed-in user's account (rule 6). The 3 example bills offered to people (case-01, case-11, case-02; `EXAMPLES` in public/app.js) are fictional and labeled so; the UI never calls the product a demo. Privacy wording everywhere: "Uploaded files are not permanently stored. Confirmed structured analysis/results may be saved to your account."
5. **Money is never invented.** Potential savings (detected) and confirmed savings (after resolution) are always separate. Only resolved disputes count as saved.
6. **Stack:** Node 18+, Express, plain HTML/CSS/JS in `public/`, no framework, no build step. **Accounts (user decision, 2026-09-26):** name-only sign-in (Supabase anonymous auth) and Supabase Postgres for each signed-in user's analyses and disputes (`src/accounts.js`, `db/schema.sql`). Rows are written with the user's own token so row-level security applies; the service role key is never used. Uploaded files are never stored (no Supabase Storage); only confirmed numbers + rules results. Demo guests and `/classic/` stay in memory and are never saved. Without `SUPABASE_URL`/`SUPABASE_ANON_KEY` the app still runs (the demo works; sign-in says it isn't set up).
7. **Depth over breadth.** Don't add features that aren't in `BUILD_PROMPT.md`. If a phase's check fails, fix it before moving on.

## Commands
- `npm run generate`: build the 18 test cases and the answer key in `data/`
- `npm run score`: run the rules on both test sets (generated + hand-written), print both scoreboards, write `data/scoreboard.json` and `public/demo-data.js`
- `npm run render`: render every case as a realistic bill + EOB (PNG + PDF, 3 layouts) into `data/rendered/`
- `npm run score:extraction`: needs `GEMINI_API_KEY`; read rendered documents (and `data/photos/`) with Gemini and score field, header and end-to-end accuracy into `data/extraction-scoreboard.json`
- `npm start`: start the server on http://localhost:3000 (`/` is the start page with the name sign-in; `/app.html` is the dashboard; `/app.html?guest=1` is "Try an example", no account)
- Deploy: Vercel, per `vercel.json` (static `public/`, Express as one function in `api/index.js`, `npm ci --omit=dev`). Request bodies are capped at 4.5 MB there, so upload-ui.js resizes big photos and caps PDFs at 3 MB.

## Key files
- `src/rules.js`: rules engine (pure functions). The heart of the project; keep it tested.
- `src/letter.js`: dispute letter, follow-up letter, call script (templates)
- `src/explain.js`: glossary and finding explanations
- `src/disputes.js`: dispute store and status changes (in memory, scoped by owner; `src/accounts.js` saves signed-in users' disputes to Supabase)
- `src/accounts.js`: who is asking (token / guest id / public), saved analyses, dispute persistence
- `public/index.html` + `landing.js` + `landing.css`: start page; `public/auth.js`: name-only sign-in; `public/account-ui.js`: name, Sign out, My analyses
- `src/callpractice.js`: scripted rep, optional Gemini rep, deterministic checklist
- `src/extract.js`: the one extraction pipeline (`readDocument` + `finish`), used by live uploads and the extraction scoreboard
- `src/validate.js`: "do the extracted numbers add up" checks for the review step; runs on the server and is served to the browser as `/validate.js`
- `src/gemini.js`, `src/tts.js`: external API layers with fallbacks; `GEMINI_MODEL` picks the model, never switched silently
- `data/handwritten/`: hand-written edge cases + answer key (not generated)
- `scripts/render.js`, `scripts/score-extraction.js`: sample documents and the extraction scoreboard
- `public/upload-ui.js`: upload (PDF, Word .docx, PNG, JPG/JPEG, drag-and-drop) and the editable review screen. Word files are turned into plain text in memory by `src/docx.js` (no packages) and sent to Gemini as text through the same `src/extract.js` pipeline
- `data/generate.js`, `scripts/score.js`: test data and scoreboard
- `public/`: the single-page app

## Hero case (must always work)
Maya, ER visit for a sprained ankle. The bill says **$1,240**; she likely owes **$250**.
- Flags: `duplicate_charge` $380 (ankle X-ray billed twice) and `missing_insurance_payment` $610.
- Math: $1,240 − $380 − $610 = $250.
- Resolving the dispute at $250 shows **"Saved $990"**.

## Data model additions (Phase 8)
- `units` on every bill line and EOB line, default 1. A line's charge/billed is the total for all its units. Rules group lines by `date|code` and compare total units: extra billed units → `duplicate_charge` (extra units × per-unit charge); the same total split differently → no flag.
- Optional `bill.previous_balance`: included in `amount_due`, set aside by the rules ("not checked here"), reported as `summary.previous_balance`. `likely_owe` is this visit's share only.
- Expected contractual adjustment = Σ(billed − insurer_paid − patient_resp) over matched EOB lines, so a denied line (allowed 0, patient owes all) expects no write-off.

## Error types (exact strings)
`duplicate_charge`, `missing_insurance_payment`, `not_submitted_to_insurance`, `adjustment_missing`, `charge_mismatch`, `surprise_bill_nsa`, plus `unexplained_difference` from the rules engine when the math doesn't reconcile.

## Working style
- After finishing each phase, update `PROGRESS.md`: check off items, note what's working, what's broken, and any decisions made.
- Run `npm run score` after any change to `src/rules.js`. **Both** deterministic scoreboards (generated set and hand-written edge cases) must stay at 100%. If a hand-written case fails, fix the rules, not the case, unless the case is wrong (and say why in `PROGRESS.md`).
- Live uploads and the extraction scoreboard must go through the same pipeline (`src/extract.js`). Improve extraction problems on the extraction side (prompt, schema, validation, review step), never by changing the rules.
- Never cache or save real user uploads to disk. `data/extraction-cache/` is for rendered sample documents only.
- Don't claim extraction or phone-photo accuracy until it has actually been measured with a real Gemini key.
- Before ending a session, make sure `npm start` still runs and the hero case still works.
- Plain-English UI copy at about a 6th-grade reading level. Status is never shown by color alone.
