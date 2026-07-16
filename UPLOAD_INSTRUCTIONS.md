# Homely Tiffins — Complete Project Upload

Your repo is empty, so this zip contains **the whole project**, not just the changed files.
Upload all of it in one go.

## What's in here

    app/page.js          <- tells Next.js what to show at "/"  (the file that went missing)
    app/layout.js        <- page title + Google Fonts + favicon
    components/App.jsx   <- the entire app (new homepage + all existing features)
    public/logo.png      <- Sharma aunty logo (also used as the favicon)
    package.json         <- dependency list
    next.config.js       <- Next.js config
    .gitignore           <- optional; keeps junk out of the repo

---

## Upload steps

1. **Unzip** this file on your computer.

2. Open the unzipped folder. You should see exactly this:

       app
       components
       public
       package.json
       next.config.js
       .gitignore
       UPLOAD_INSTRUCTIONS.md

3. Go to https://github.com/homelytiffins8/homely-tiffins

4. Click **Add file** → **Upload files**
   (On a fresh empty repo you may instead see a link that says
   **"uploading an existing file"** — click that.)

5. **Select everything INSIDE the unzipped folder** and drag it into the upload box.

   > **Important:** drag the *contents* — `app`, `components`, `public`,
   > `package.json`, `next.config.js`. Do **not** drag the outer folder itself,
   > or you'll end up with `homely-tiffins-new/app/page.js` instead of
   > `app/page.js`, and the site won't build.
   >
   > On Windows: open the folder, press **Ctrl+A**, then drag the selection in.

   You don't need to upload `UPLOAD_INSTRUCTIONS.md`. `.gitignore` is optional —
   Windows may hide it, which is fine.

6. Wait for all files to finish uploading. You should see `app/page.js`,
   `app/layout.js`, `components/App.jsx`, `public/logo.png`, `package.json`,
   `next.config.js` listed.

7. Commit message: `Full project with new homepage`

8. Keep **"Commit directly to the main branch"** selected → **Commit changes**

---

## Then check GitHub looks right

Your repo file list should show:

    app/          <- click in: should contain BOTH page.js and layout.js
    components/   <- App.jsx
    public/       <- logo.png
    next.config.js
    package.json

**If `app/` only has `layout.js`, the site will 404.** `page.js` must be there too.

---

## Then check Vercel

Vercel auto-deploys when you commit. Give it 1–2 minutes.

- Go to https://vercel.com/homelytiffins/homely-tiffins → **Deployments**
- The newest one should go **Building** → **Ready**
- If nothing starts, open the latest deployment → **⋯** → **Redeploy**

Then hard-refresh https://homelytiffins.com (**Ctrl+Shift+R**).

---

## What you should see

- [ ] Sharma aunty logo at the top, thin brown ring around it
- [ ] "HOMELY / TIFFINS" in the serif font with orange arrows either side
- [ ] "Ghar jaisa. Better." in the handwritten script font
- [ ] "Today's Menu is Ready!" card (or Kitchen Closed / Menu Not Published)
- [ ] Track Your Order box
- [ ] Orange wave at the bottom with four icons

Everything else — ordering, owner dashboard, kitchen prep panel, khata ledger,
analytics, ratings, polls, order alerts — is unchanged and included.

---

## Troubleshooting

**404 "This page could not be found"**
`app/page.js` is missing. Add file → Create new file → name it `app/page.js` → paste:

```js
"use client";

import dynamic from "next/dynamic";

const App = dynamic(() => import("../components/App"), { ssr: false });

export default function Page() {
  return <App />;
}
```

**Fonts look plain**
`app/layout.js` didn't upload.

**Logo is a broken image**
`logo.png` must be at `public/logo.png` — not inside `app/` or `components/`.

**Vercel build fails**
Check `package.json` is at the repo root (not inside a subfolder).

---

## Note for future uploads

When you drag a **folder** into GitHub's uploader, that folder's contents *replace*
the whole folder in the repo — anything not in what you dragged gets deleted.
That's what removed `page.js` last time.

Safest habit: drag individual **files**, or use the pencil (Edit) icon per file.
