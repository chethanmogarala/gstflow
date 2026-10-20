# GSTFlow (test version)

Purchase reconciliation for CA firms: import a client's purchase register and GSTR-2B, match them, review exceptions, and export IMS actions, ITC risks and supplier follow-ups.

- **Frontend:** React + TypeScript (Vite), hosted on GitHub Pages
- **Backend:** Supabase (Postgres + login), with row-level security so each firm sees only its own data
- **Matching engine:** `src/engine/` (same rules as `../engine/reconcile.py`), tested in `src/engine/reconcile.test.ts`

Use anonymized client data while testing. Never enter GST portal passwords or OTPs.

## One-time setup

### 1. Supabase project

1. Create a free account at [supabase.com](https://supabase.com) and a **New project**. Pick region **Mumbai (ap-south-1)**.
2. Open **SQL Editor → New query**, paste all of [`supabase/schema.sql`](supabase/schema.sql), and click **Run**.
3. Open **Authentication → URL Configuration** and set **Site URL** to the GitHub Pages address (for example `https://<github-user>.github.io/gstflow/`).
4. Optional for faster testing: **Authentication → Sign In / Providers → Email**, turn off **Confirm email**.
5. Open **Project Settings → API** and copy the **Project URL** and the **anon public** key.

### 2. GitHub Pages

1. In the repository, **Settings → Pages → Source: GitHub Actions**.
2. **Settings → Secrets and variables → Actions → Variables**, add `SUPABASE_URL` and `SUPABASE_ANON_KEY`. Or run:

   ```bash
   gh variable set SUPABASE_URL --body "https://xxxx.supabase.co"
   ```

   ```bash
   gh variable set SUPABASE_ANON_KEY --body "eyJ..."
   ```

3. Push to `main` (or run the workflow from the **Actions** tab). The site deploys in about two minutes.

### 3. First use

1. Open the site, **Create an account**, then create your firm. You become its admin.
2. **Team and settings → Invite by email** to add colleagues. They join when they sign up with that email.
3. **Add client → Open period → Import files**. Sample files are linked on the import screen.

## Local development

Create `.env.local` with the two values above (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`), then:

```bash
npm install
```

```bash
npm run dev
```

Try the app without a database (demo mode keeps everything in the browser tab; click **Try it with sample data**):

```bash
npm run dev -- --mode demo
```

Run the tests:

```bash
npx vitest run
```

## What this version does not do yet

Credit and debit notes in 2B, amendments, OCR invoice capture, Tally posting, GST portal APIs, and email or WhatsApp sending. See the product proposal for the roadmap.
