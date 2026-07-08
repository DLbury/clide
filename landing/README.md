# Landing Page

Static marketing site for Clide, deployable to GitHub Pages. Optimized for SEO (search engines) and GEO (international / Chinese audience).

## Structure

```
landing/
├── index.html          # English homepage
├── zh/index.html       # Chinese homepage (zh-CN)
├── css/style.css       # Shared styles
├── sitemap.xml         # Search engine sitemap
├── robots.txt          # Crawler rules
└── .nojekyll           # Disable Jekyll processing
```

## Deploy to GitHub Pages

1. Go to repo **Settings → Pages**
2. **Source:** Deploy from a branch
3. **Branch:** `main`, folder: **`/landing`**
4. Save

The site will be available at:

- English: `https://dlbury.github.io/clide/`
- 中文: `https://dlbury.github.io/clide/zh/`

## SEO & GEO Features

- **Semantic HTML** — proper heading hierarchy, `<main>`, `<article>`, `<nav>`, ARIA labels
- **Meta tags** — title, description, keywords covering SSH terminal, SFTP, DevOps, SRE, AI ops, and general terminal terms (not just "AI term")
- **Open Graph & Twitter Cards** — social sharing previews
- **hreflang** — `en`, `zh-CN`, and `x-default` for international SEO
- **JSON-LD structured data** — `SoftwareApplication`, `WebSite`, `Organization`, `FAQPage`
- **sitemap.xml** — with hreflang alternates
- **robots.txt** — allows indexing, points to sitemap
- **Footer keyword block** — long-tail terminal / ops terms for crawlers
- **FAQ section** — targets common search queries (rich results eligible)

## Local Preview

Open `index.html` or `zh/index.html` in a browser. For correct asset paths on GitHub Pages, serve locally:

```bash
cd landing
python -m http.server 8080
```

Or use any static file server pointed at the `landing/` folder.

## Custom Domain (optional)

If you add a custom domain (e.g. `clide.dev`):

1. Add a `CNAME` file in `landing/` with your domain
2. Update canonical URLs, `sitemap.xml`, and `og:url` in both HTML files
3. Configure DNS `CNAME` → `dlbury.github.io`
