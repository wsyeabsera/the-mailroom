# Docs pages

Each page is `ui/docs/<slug>.html` and is served at `/docs/<slug>` (index at `/docs/`). The sidebar and previous/next order come from `nav.js`; `docs.js` wraps every page. No build step. Edit, reload.

Page skeleton (copy `index.html` or this):

```html
<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Page title · The Mailroom</title>
<meta name="robots" content="noindex">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/docs/docs.css">
<script src="/js/theme-init.js"></script>
</head>
<body data-slug="the-slug">
<main id="doc">
<h1>Title</h1>
<p class="lede">One sentence that says what the page is for.</p>
<div class="note"><p>The one-paragraph version.</p></div>
<h2>Section</h2> ...
</main>
<script type="module" src="/docs/docs.js"></script>
</body>
</html>
```

Components: `.note` (In short), `.tip` (Try it), `.warn` (Careful), `.danger` (Important); `ol.steps`; `details > summary` for "Under the hood"; `.cards`; `.pill` (+ `ok`/`warn`/`err`/`acc`); `figure.shot > img + figcaption`; tables; `<pre><code>`.

Diagrams: `<figure class="dg"><svg viewBox="0 0 760 H" role="img" aria-labelledby="id-t id-d"><title id="id-t">..</title><desc id="id-d">..</desc> ... </svg><figcaption>..</figcaption></figure>`. Use only the classes in `docs.css` (never hard-coded colours) so diagrams follow the theme: nodes `.n` (+ `acc`, `ok`, `warn`, `err`, `raised`), text `.t` (bold) `.s` (small) `.m` (mono) `.c` (centred), lines `.e` (+ `acc`, `ok`, `err`, `dash`), swim lanes `.lane`, lifelines `.life`, numbered badges `<g class="badge"><circle r="10"/><text>1</text></g>`.
