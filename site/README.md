# site/

Static landing page deployed to GitHub Pages on every push to `main` that
touches `site/**` (see `.github/workflows/pages.yml`).

The PWA itself lives at [`apps/pwa`](../apps/pwa) and is hosted at
[localhost](http://localhost:5173). This is a separate, marketing-only
page and intentionally has no build step.

## Local preview

Any static server works:

```bash
cd site
python3 -m http.server 8000
# or: npx serve .
```

Then open <http://localhost:8000>.

## Stack

- Plain HTML, no build pipeline
- Tailwind via the CDN script (`cdn.tailwindcss.com`) so authoring stays
  inline; if the page grows beyond ~3 routes, switch to a Vite MPA build
  and keep the deployed artifact path the same
- Inter / JetBrains Mono via Google Fonts

## Adding a page

Drop another `.html` next to `index.html` and link to it from the nav.
GitHub Pages will serve it directly — no workflow change needed.
