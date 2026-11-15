// Checks the docs site in a real browser: every page in both themes and at phone width.
//   PLAYWRIGHT_CORE=/path/to/playwright-core [DOCS_PORT=8806] [SHOTS_DIR=dir] node scripts/docs-check.mjs [slug ...]
// With no slugs it checks every page in ui/docs/nav.js. Starts its own Worker (nothing else needs to run).
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = new URL("..", import.meta.url).pathname;
const PORT = Number(process.env.DOCS_PORT || 8806);
const BASE = `http://localhost:${PORT}`;
const shots = process.env.SHOTS_DIR || join(tmpdir(), "mailroom-docs-shots");
mkdirSync(shots, { recursive: true });
if (!process.env.PLAYWRIGHT_CORE) { console.log("Set PLAYWRIGHT_CORE to a playwright-core directory."); process.exit(2); }
const { chromium } = await import(pathToFileURL(join(process.env.PLAYWRIGHT_CORE, "index.mjs")).href);
const { FLAT } = await import(pathToFileURL(join(root, "ui/docs/nav.js")).href);
const only = process.argv.slice(2);
const pages = FLAT.filter(p => !only.length || only.includes(p.slug || "index")).map(p => ({ ...p, path: p.slug ? `/docs/${p.slug}` : "/docs/" }));
const pass = readFileSync(join(root, ".dev.vars"), "utf8").match(/^OWNER_PASSWORD=(.*)$/m)[1];
const tmp = mkdtempSync(join(tmpdir(), "mr-docs-"));
let proc, failed = 0, notes = 0;
const bad = (page, msg) => { failed++; console.log(`  FAIL ${page}: ${msg}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const killGroup = p => { try { process.kill(-p.pid, "SIGKILL"); } catch { try { p.kill("SIGKILL"); } catch {} } };
process.on("exit", () => { if (proc) killGroup(proc); try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

proc = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--inspector-port", String(PORT + 1000), "--persist-to", join(tmp, "state")], { cwd: root, stdio: "ignore", detached: true });
for (let i = 0; i < 120; i++) { try { if ((await fetch(BASE + "/admin/state")).status === 401) break; } catch {} await sleep(500); if (i === 119) { console.log("FAIL the Worker did not start"); process.exit(1); } }
const login = await fetch(BASE + "/admin/login", { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ password: pass }) });
const cookie = login.headers.get("set-cookie").split(";")[0].split("=");

const browser = await chromium.launch({ channel: "chromium", headless: true });
const ids = new Map(); // path -> Set(ids)
const links = []; // {from, href}
for (const theme of ["dark", "light"]) {
  for (const [label, viewport] of [["wide", { width: 1280, height: 900 }], ["phone", { width: 390, height: 800 }]]) {
    if (theme === "light" && label === "phone") continue; // dark phone + both wide themes is enough
    const ctx = await browser.newContext({ viewport, colorScheme: theme });
    await ctx.addCookies([{ name: cookie[0], value: cookie.slice(1).join("="), url: BASE }]);
    await ctx.addInitScript(t => { try { localStorage.setItem("mr-theme", t); } catch {} }, theme);
    console.log(`${theme} / ${label}`);
    for (const p of pages) {
      const page = await ctx.newPage();
      const errs = [], failedReqs = [];
      page.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
      page.on("pageerror", e => errs.push(String(e)));
      page.on("response", r => { if (r.url().startsWith(BASE) && r.status() >= 400) failedReqs.push(`${r.status()} ${r.url().replace(BASE, "")}`); });
      const res = await page.goto(BASE + p.path, { waitUntil: "load" });
      await page.waitForSelector(".dx-main", { timeout: 8000 }).catch(() => {});
      const name = p.slug || "index";
      if (res.status() !== 200) { bad(name, `HTTP ${res.status()}`); await page.close(); continue; }
      const info = await page.evaluate(() => ({
        h1: document.querySelectorAll("main h1, .dx-main h1").length,
        h2: document.querySelectorAll(".dx-main h2").length,
        title: document.title,
        current: document.querySelector('.dx-side a[aria-current="page"]')?.textContent ?? null,
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        svgNoText: [...document.querySelectorAll(".dx-main svg")].filter(s => !s.querySelector("title") || !s.querySelector("desc")).length,
        svgs: document.querySelectorAll(".dx-main svg").length,
        brokenImgs: [...document.querySelectorAll(".dx-main img")].filter(i => !i.complete || i.naturalWidth === 0).map(i => i.getAttribute("src")),
        ids: [...document.querySelectorAll(".dx-main [id]")].map(e => e.id),
        hrefs: [...document.querySelectorAll(".dx-main a[href]")].map(a => a.getAttribute("href")),
        hardColours: [...document.querySelectorAll(".dx-main svg [fill], .dx-main svg [stroke]")].filter(e => /#[0-9a-f]{3,6}\b|rgb\(/i.test((e.getAttribute("fill") || "") + (e.getAttribute("stroke") || ""))).length,
        emptyHeading: [...document.querySelectorAll(".dx-main h2, .dx-main h3")].filter(h => !h.firstChild?.textContent.trim()).length,
      }));
      if (info.h1 !== 1) bad(name, `${info.h1} h1 elements (want 1)`);
      if (name !== "index" && info.h2 < 2) bad(name, `only ${info.h2} sections`);
      if (!info.current) bad(name, "no current page in the sidebar");
      if (errs.length) bad(name, `console errors: ${errs.slice(0, 2).join(" | ")}`);
      if (failedReqs.length) bad(name, `failed requests: ${failedReqs.slice(0, 3).join(", ")}`);
      if (info.overflow > 1) bad(name, `page scrolls sideways by ${info.overflow}px at ${viewport.width}px`);
      if (info.svgNoText) bad(name, `${info.svgNoText} diagram(s) without <title> and <desc>`);
      if (info.hardColours) bad(name, `${info.hardColours} diagram element(s) with a hard-coded colour (use the classes)`);
      if (info.brokenImgs.length) bad(name, `broken images: ${info.brokenImgs.join(", ")}`);
      if (info.emptyHeading) bad(name, "an empty heading");
      if (theme === "dark" && label === "wide") { ids.set(p.path, new Set(info.ids)); for (const h of info.hrefs) links.push({ from: name, path: p.path, href: h }); console.log(`  ${name}: ${info.h2} sections, ${info.svgs} diagram(s)`); }
      await page.screenshot({ path: join(shots, `${name}-${theme}-${label}.png`), fullPage: true });
      await page.close();
    }
    await ctx.close();
  }
}
// links: internal pages exist and anchors exist; no placeholder text
console.log("links");
const ctx = await browser.newContext();
await ctx.addCookies([{ name: cookie[0], value: cookie.slice(1).join("="), url: BASE }]);
const checked = new Map();
for (const { from, path, href } of links) {
  if (/^(https?:|mailto:)/.test(href)) { notes++; continue; }
  const u = new URL(href, BASE + path);
  if (u.origin !== BASE) continue;
  const key = u.pathname.replace(/\/$/, "") || "/";
  const target = u.pathname === "/docs" ? "/docs/" : u.pathname;
  if (!checked.has(target)) { const r = await ctx.request.get(BASE + target, { maxRedirects: 0 }).catch(() => null); checked.set(target, r ? r.status() : 0); }
  const st = checked.get(target);
  if (!(st === 200 || (st >= 300 && st < 400)) && !u.pathname.startsWith("/#") && u.pathname !== "/") bad(from, `link ${href} -> ${st}`);
  if (u.hash && ids.has(target) && !ids.get(target).has(decodeURIComponent(u.hash.slice(1)))) bad(from, `link ${href}: no such section`);
  if (u.hash && !ids.has(target) && pages.length === FLAT.length && target.startsWith("/docs")) bad(from, `link ${href}: page not checked`);
}
await ctx.close();
await browser.close();
console.log(failed ? `\nDOCS CHECK FAILED (${failed})` : `\nDOCS CHECK PASSED (${pages.length} page(s); screenshots in ${shots}; ${notes} external link(s) not followed)`);
process.exit(failed ? 1 : 0);
