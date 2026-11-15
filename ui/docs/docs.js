// Wraps a docs page: top bar, sidebar, "on this page", previous/next, copy buttons, theme switch.
// A page is plain HTML: <body data-slug="how-it-works"><main id="doc">...</main><script type="module" src="/docs/docs.js">
import { NAV, FLAT, href } from "/docs/nav.js";
import { themeSwitch } from "/js/theme.js";

const SVG = "http://www.w3.org/2000/svg";
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (v === false || v == null) continue; if (k === "class") n.className = v; else if (k.startsWith("on")) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v === true ? "" : v); }
  n.append(...kids.flat().filter(x => x != null));
  return n;
};

const slug = document.body.dataset.slug ?? "";
const here = FLAT.find(p => p.slug === slug) ?? FLAT[0];
const doc = document.getElementById("doc");
const content = [...doc.childNodes];

// ---- shared SVG defs (arrowheads) so every diagram can use marker-end via the .e classes
const defs = document.createElementNS(SVG, "svg");
defs.setAttribute("width", "0"); defs.setAttribute("height", "0"); defs.setAttribute("aria-hidden", "true"); defs.style.position = "absolute";
defs.innerHTML = ["", "-acc", "-ok", "-err"].map((s, i) => {
  const c = ["var(--muted)", "var(--accent)", "var(--ok)", "var(--err)"][i];
  return `<marker id="dg-arrow${s}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${c}"/></marker>`;
}).join("");

// ---- top bar
const menuBtn = el("button", { class: "dx-menu", type: "button", "aria-expanded": "false", "aria-controls": "dx-side", onclick: () => { const o = document.body.classList.toggle("menu-open"); menuBtn.setAttribute("aria-expanded", String(o)); } }, "Menu");
const top = el("header", { class: "dx-top" },
  el("a", { class: "dx-brand", href: "/docs/" }, el("span", { class: "mark", "aria-hidden": "true" }, "M"), "The Mailroom", el("small", {}, "Docs")),
  el("div", { class: "dx-top-r" }, el("a", { href: "/#/overview" }, "Open the app"), themeSwitch(), menuBtn));

// ---- sidebar with a tiny title filter
const filter = el("input", { class: "dx-search", type: "search", placeholder: "Filter pages", "aria-label": "Filter pages" });
const list = el("div", {});
function drawNav() {
  const q = filter.value.trim().toLowerCase();
  list.replaceChildren();
  let shown = 0;
  for (const g of NAV) {
    const pages = g.pages.filter(p => !q || `${p.title} ${p.summary}`.toLowerCase().includes(q));
    if (!pages.length) continue;
    shown += pages.length;
    list.append(el("div", { class: "dx-grp" }, g.group), ...pages.map(p => el("a", { href: href(p.slug), "aria-current": p.slug === here.slug ? "page" : false }, p.title)));
  }
  if (!shown) list.append(el("div", { class: "none" }, "No page matches."));
}
filter.addEventListener("input", drawNav);
drawNav();
const side = el("nav", { class: "dx-side", id: "dx-side", "aria-label": "Documentation" }, el("a", { class: "dx-app", href: "/#/overview" }, "\u2190 Open the app"), filter, list);

// ---- article
const main = el("article", { class: "dx-main", id: "main" });
if (here.group && slug) main.append(el("div", { class: "dx-crumb" }, `${here.group} / ${here.title}`));
main.append(...content);

// headings: ids and permalinks, then the on-this-page list
const used = new Set();
const toc = [];
for (const h of main.querySelectorAll("h2, h3")) {
  let id = h.id || h.textContent.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "section";
  while (used.has(id)) id += "-2";
  used.add(id); h.id = id;
  h.append(el("a", { class: "anchor", href: `#${id}`, "aria-label": `Link to ${h.textContent}` }, "#"));
  toc.push({ id, level: h.tagName === "H3" ? 3 : 2, text: h.firstChild.textContent });
}
const tocBox = el("aside", { class: "dx-toc", "aria-label": "On this page" });
if (toc.length > 1) tocBox.append(el("b", {}, "On this page"), ...toc.map(t => el("a", { href: `#${t.id}`, class: t.level === 3 ? "h3" : "" }, t.text)));

// previous / next
const i = FLAT.indexOf(here);
const pn = el("nav", { class: "dx-pn", "aria-label": "Previous and next page" },
  i > 0 ? el("a", { class: "prev", href: href(FLAT[i - 1].slug) }, el("small", {}, "Previous"), FLAT[i - 1].title) : null,
  i < FLAT.length - 1 ? el("a", { class: "next", href: href(FLAT[i + 1].slug) }, el("small", {}, "Next"), FLAT[i + 1].title) : null);
main.append(pn);

// copy buttons on code blocks
for (const pre of main.querySelectorAll("pre")) {
  const b = el("button", { class: "copy", type: "button", "aria-label": "Copy code" }, "Copy");
  b.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(pre.innerText.replace(/\nCopy$/, "")); b.textContent = "Copied"; } catch { b.textContent = "Press Ctrl+C"; }
    setTimeout(() => (b.textContent = "Copy"), 1500);
  });
  pre.append(b);
}

document.body.replaceChildren(
  el("a", { class: "skip", href: "#main" }, "Skip to content"), defs, top,
  el("div", { class: "dx-body" }, side, main, tocBox));
document.title = `${here.title}${slug ? "" : " · docs"} · The Mailroom`;

// highlight the section being read
if (toc.length > 1 && "IntersectionObserver" in window) {
  const links = new Map([...tocBox.querySelectorAll("a")].map(a => [a.getAttribute("href").slice(1), a]));
  const io = new IntersectionObserver(es => { for (const e of es) if (e.isIntersecting) { links.forEach(l => l.classList.remove("on")); links.get(e.target.id)?.classList.add("on"); } }, { rootMargin: "-72px 0px -70% 0px" });
  for (const t of toc) io.observe(document.getElementById(t.id));
}
if (location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
