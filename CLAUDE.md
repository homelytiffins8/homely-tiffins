# Homely Tiffins — Project Context

Homely Tiffins (homelytiffins.com): a Next.js/Supabase tiffin-delivery app for a Noida gated society (towers N-1 to N-28), owned and operated by Shaurya. Shaurya is a non-coder managing the app via GitHub's browser web UI + Vercel auto-deploy (no CLI access). Claude is the primary dev partner.

## Stack
- Next.js (App Router) + React; single-file architecture in `components/App.jsx` (~6,400+ lines)
- Supabase (Mumbai region) for backend/realtime; deployed on Vercel
- Images are base64-embedded as constants directly in the JSX
- Supabase JS client handles load/save with realtime `postgres_changes` sync

## Environments
- Production Supabase project: `locesmksvetbdhsvgqip` (main branch)
- Staging Supabase project: `ktwaesobvvqzzhadrdoa` (Staging branch)
- Credentials are hardcoded in `App.jsx` — promotion to main requires a manual credential swap (not a branch merge) to avoid overwriting production credentials with staging ones

## Brand
- Colors: cream (#F6EFE1), orange (#E0731A), brown (#3B2A1A)
- Fonts: Playfair Display, Dancing Script, Nunito

## Menu
- Homely Gold Large: ₹275 (300ml container)
- Homely Gold Medium: ₹199 (disposable thalis)
- Homely Standard: ₹120 (rice / 2-extra-chapati swap option)
- Homely Mini: ₹80 (chapati / rice swap option)
- Gold Large price = `gold` base + `goldLargeSurcharge`

## Production-specific config (intentional, not bugs)
- `goldLargeSurcharge` = ₹76 in both production and staging (Gold Large = ₹275)
- Referral program disabled in production
- Promo codes inactive in production

## Current state (as of Sept 2026)
- Staging → Production promotion completed: Supabase credentials swapped from Staging to Production in `App.jsx`; full schema migration to relational tables (from old single-blob `app_data`); RLS policies, indexes, realtime publication, `place_order` RPC all migrated
- All legacy blob data migrated: customers, orders history, credit ledger, contact messages, poll responses
- 69 missing credit ledger debit entries backfilled (tagged `extra.backfilled = true`); rule: every delivered order must have a debit entry before payment is accepted
- Pre-existing customer aggregate drift (old async race condition bug) corrected
- New relational architecture live in production; old race condition bug (building ledger entry data inside a React state updater) confirmed fixed
- `place_order` RPC is `SECURITY DEFINER`; handles all anonymous customer-facing order writes, server-side price computation, promo/referral validation, customer upserts
- Credit ledger uses deterministic IDs (`"dlv:" + order.id`) to prevent duplicates
- Security overhaul live: owner login via real Supabase Auth (`signInWithPassword`, ginney456@gmail.com); all transactional data in relational tables with RLS; four customer-facing RPC functions for anonymous writes; full server-side price/discount/promo/referral validation in `place_order` (client-sent totals ignored)
- PWA live: manifest, service worker (no data caching), icons (5 variants), owner session persistence via localStorage (24-hour expiry), realtime websocket reconnection on mobile tab suspension via `visibilitychange`/`online`/`focus` listeners with catch-up sync

## On the horizon
- Bottom navigation bar (removed during homepage redesign) needs re-adding: Home / Menu / Orders / Profile; Profile tab semantics TBD
- Payment gateway: Razorpay selected over Cashfree; sequence is Udyam registration → Razorpay signup → sandbox keys, before any code is written
- Deferred payment decision: whether online-paid orders appear within Khata view or a separate history (Claude's prior preference: unified history, Khata reserved for outstanding credit only)
- Phase 3 analytics: capture payment mode (Cash / UPI / Khata) at checkout — next step after Excel report overhaul
- PWA push notifications deferred (Shaurya interested for future update)
- "Today's Menu" homepage section deferred — needs live Supabase data, not static

## Pending reminders
- Ask Shaurya whether printing the customer's phone number on the KOT (reaches the customer physically) has caused problems
- Open bug (Staging, unfixed): "Now starts at ₹199" badge on Gold homepage banner is hardcoded rather than derived from `planConfig.prices.gold` — fix before/when promoting to main

## Standing workflow rules
- **Before implementing any change, always ask Shaurya whether to implement it in Staging (sandbox) or directly in main.**
- Shaurya strongly prefers seeing UI mockups/previews before any code changes — design before code
- Keep changes minimal and scoped; no unrequested features or embellishments
- Communication style: short, direct, no formatting narration; Shaurya gives iterative single-line feedback

## Delivery process
- Shaurya uploads files via GitHub's web UI — text files via pencil/edit, PNGs via "Add file → Upload files" drag-drop; Vercel auto-builds on push
- Deliverables are always `App.jsx` + `App.zip` (plus any additional assets in correct folder structure)
- esbuild validation runs before every delivery; bundle-size warnings expected (base64 images), not errors
- Promotion process is a credential swap, never a Staging→main branch merge (merge would overwrite production Supabase credentials): fetch production `App.jsx` from main, swap only `SUPABASE_URL` and `SUPABASE_KEY`, validate, deliver

## Key technical learnings
- Production-specific config differences must be preserved on promotion (`goldLargeSurcharge`, referral disabled, promo codes inactive)
- Status regression prevention: `STATUS_RANK` + `mergeOrders` enforces forward-only status progression at every write point (fetch → merge → write) — critical for multi-device use
- Credit ledger idempotency: auto-debit entries use deterministic IDs (`"dlv:" + orderId`); referral credits similarly keyed
- Realtime + mobile: Supabase websocket must be torn down/recreated after mobile OS tab suspension; `realtimeTick` state forces teardown/recreation; `catchUpSync` re-fetches and merges state (skipping null results to avoid wiping live data)
- Use `apply_migration`, not `execute_sql`, for the Supabase MCP connector — `execute_sql` is read-only
- For large `app_data` rows with base64 photo data, use `(value - 'photos')` in SELECT to avoid response flooding
- Running multiple SQL statements in the Supabase SQL editor only returns the final statement's result — run diagnostic queries one at a time

## Tools & resources
- GitHub repo: `homelytiffins8/homely-tiffins`; raw file fetch via `raw.githubusercontent.com/homelytiffins8/homely-tiffins/[branch]/components/App.jsx`
- esbuild: `--loader:.jsx=jsx --bundle=false`
- Image processing: Python PIL — resize to 840px wide JPEG quality 82, base64-encode, inject as data URI into JSX constants
- Supabase MCP connector can access both Staging and Production under the same org; always specify the project ID explicitly
- Vercel auto-deploys on push; staging preview at `homely-tiffins-git-staging-homelytiffins.vercel.app`
- Twilio reminder call system live (paid account, Trust Hub compliance profile approved, caller ID +19472107224); cron-job.org pings the endpoint every minute
- `reminder-cron` route reads pending orders from `orders` table using `SUPABASE_SERVICE_ROLE_KEY` env var (orders RLS restricts access to `authenticated` role); reminder progress tracked per-order in `extra.reminderStages` jsonb field
- SheetJS loaded on-demand from CDN for `.xlsx` export
