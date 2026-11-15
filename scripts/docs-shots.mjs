// Captures the screenshots used by the docs (ui/docs/img/*.jpg) from the REAL app, against its own throwaway Worker.
//   PLAYWRIGHT_CORE=/path/to/playwright-core [SHOTS_OUT=dir] node scripts/docs-shots.mjs
// Starts `wrangler dev` on port 8807 (own process group, killed at the end), seeds believable data through the API,
// signs in as the owner with a cookie, and saves 1280-wide JPEGs. Nothing here is a real secret: the keys and tokens
// shown are throwaway values in a temporary database that is deleted afterwards.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = new URL("..", import.meta.url).pathname;
const PORT = 8807;
const BASE = `http://localhost:${PORT}`;
const out = process.env.SHOTS_OUT || join(root, "ui/docs/img");
mkdirSync(out, { recursive: true });
if (!process.env.PLAYWRIGHT_CORE) { console.log("Set PLAYWRIGHT_CORE to a playwright-core directory."); process.exit(2); }
const { chromium } = await import(pathToFileURL(join(process.env.PLAYWRIGHT_CORE, "index.mjs")).href);
const pass = readFileSync(join(root, ".dev.vars"), "utf8").match(/^OWNER_PASSWORD=(.*)$/m)[1];
const tmp = mkdtempSync(join(tmpdir(), "mr-shots-"));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const killGroup = p => { try { process.kill(-p.pid, "SIGKILL"); } catch { try { p.kill("SIGKILL"); } catch {} } };
let proc, ctx, browser;
const cleanup = async () => { try { await ctx?.close(); } catch {} try { await browser?.close(); } catch {} if (proc) killGroup(proc); try { rmSync(tmp, { recursive: true, force: true }); } catch {} };
process.on("exit", () => { if (proc) killGroup(proc); });
process.on("SIGINT", () => { cleanup().then(() => process.exit(130)); });

proc = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--inspector-port", String(PORT + 1000), "--persist-to", join(tmp, "state")], { cwd: root, stdio: "ignore", detached: true });
for (let i = 0; ; i++) {
  try { if ((await fetch(BASE + "/admin/state")).status === 401) break; } catch {}
  if (i > 120) { console.log("FAIL the Worker did not start"); await cleanup(); process.exit(1); }
  await sleep(500);
}

// ---- seed through the API
let cookie = "";
const owner = async (m, p, b) => {
  const r = await fetch(BASE + p, { method: m, headers: { cookie, "content-type": "application/json", origin: BASE }, body: b === undefined ? undefined : JSON.stringify(b) });
  const t = await r.text();
  return { s: r.status, h: r.headers, j: t ? JSON.parse(t) : null };
};
try {
  const login = await owner("POST", "/admin/login", { password: pass });
  cookie = login.h.get("set-cookie").split(";")[0];
  const [cname, ...cval] = cookie.split("=");

  await owner("POST", "/admin/tokens", { label: "Claude Code on the laptop", scopes: ["read"] });
  await owner("POST", "/admin/tokens", { label: "Release helper", scopes: ["read", "write"] });
  const old = await owner("POST", "/admin/tokens", { label: "Old experiment", scopes: ["read", "approve"] });
  await owner("POST", `/admin/tokens/${old.j.id}/revoke`);


  const notes = (await owner("POST", "/admin/contracts", { name: "Notes writer", folders: ["~/Hobby/dunder/notes"], tasks: ["echo", "read_file", "write_file"], dailyLimit: 50, expires: null, approval: ["write_file"] })).j;
  const scratch = (await owner("POST", "/admin/contracts", { name: "Scratch", folders: ["~/Scratch"], tasks: ["echo", "claude"], dailyLimit: 20, expires: null, approval: [] })).j;
  const key = (await owner("POST", "/admin/keys", { label: "Dunder Miffbot (prod)", contract_id: notes.id })).j.key;
  const send = async (task, args) => {
    const r = await fetch(BASE + "/api/jobs", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ task, args }) });
    return (await r.json()).id;
  };
  const refused = await send("read_file", { path: "~/Documents/taxes-2025.pdf" });
  await send("write_file", { path: "~/Hobby/dunder/notes/standup.md", content: "# Standup\n\n- Shipped the invoice export\n- Fixing the retry bug today\n" });
  await send("write_file", { path: "~/Hobby/dunder/notes/ideas.md", content: "# Ideas\n\n- A weekly summary email\n- Tag notes by project\n" });
  await send("echo", { text: "hello from the nightly job" });
  // ---- the browser
  browser = await chromium.launch({ channel: "chromium", headless: true });
  ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, colorScheme: "dark" });
  await ctx.addCookies([{ name: cname, value: cval.join("="), url: BASE }]);
  await ctx.addInitScript(() => { try { localStorage.setItem("mr-theme", "dark"); } catch {} });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));

  // Fit the window to the content (between minH and maxH) and save a JPEG of the whole window.
  async function shot(name, { minH = 600, maxH = 900, ready } = {}) {
    await page.setViewportSize({ width: 1280, height: 900 });
    if (ready) await page.waitForSelector(ready, { timeout: 10000 });
    await page.waitForTimeout(700);
    // The app greets the owner by name; keep the docs generic.
    await page.evaluate(() => { const h1 = document.querySelector("main h1"); if (h1 && /^Good (morning|afternoon|evening), /.test(h1.textContent)) h1.textContent = h1.textContent.replace(/, .*$/, "."); });
    const h = await page.evaluate(() => Math.ceil(document.querySelector("#main").firstElementChild.getBoundingClientRect().bottom + window.scrollY) + 40);
    const height = Math.max(minH, Math.min(maxH, h));
    await page.setViewportSize({ width: 1280, height });
    await page.waitForTimeout(300);
    const file = join(out, name + ".jpg");
    await page.screenshot({ path: file, type: "jpeg", quality: 80, clip: { x: 0, y: 0, width: 1280, height } });
    console.log(`  ${name}.jpg  1280x${height}  ${Math.round(statSync(file).size / 1024)} KB`);
  }
  const go = async hash => { await page.goto(`${BASE}/#/${hash}`); await page.reload(); };

  console.log("capturing");
  await go("overview");
  await shot("app-overview", { ready: ".ask" });
  await go("approvals");
  await shot("app-approvals", { ready: ".diff" });
  await go(`parcels/${refused}`);
  await shot("app-parcel-refused", { ready: ".cmp" });
  await go(`contracts/${notes.id}`);
  await shot("app-contract-editor", { ready: ".plain" });
  await go("laptop");
  await shot("app-laptop", { minH: 600, ready: "text=In the queue" });
  await go("tokens");
  await shot("app-tokens", { minH: 600, ready: "table" });
  await go("events");
  await page.waitForSelector("tbody tr");
  await page.waitForSelector(".live:not(.off)", { timeout: 8000 }).catch(async () => { await page.click("text=Catch up").catch(() => {}); await page.waitForSelector(".live:not(.off)", { timeout: 8000 }).catch(() => {}); });
  console.log("  events status:", (await page.textContent(".live").catch(() => "?")).trim());
  await shot("app-events", { ready: "tbody tr" });
  if (errors.length) console.log("page errors:", errors.slice(0, 3).join(" | "));

  // ---- the extension popup (a throwaway profile, the real extension folder; localhost access granted up front)
  console.log("extension popup");
  const extDir = join(tmp, "extension");
  cpSync(join(root, "extension"), extDir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(extDir, "manifest.json"), "utf8"));
  manifest.host_permissions = ["http://localhost/*"];
  writeFileSync(join(extDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  const ectx = await chromium.launchPersistentContext(join(tmp, "profile"), {
    channel: "chromium", headless: true, colorScheme: "dark", viewport: { width: 420, height: 700 },
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  try {
    await ectx.addCookies([{ name: cname, value: cval.join("="), url: BASE }]);
    const sw = ectx.serviceWorkers()[0] ?? (await ectx.waitForEvent("serviceworker", { timeout: 15000 }));
    const extId = new URL(sw.url()).host;
    await sw.evaluate(h => chrome.storage.sync.set({ hub: h }), BASE);
    const pop = await ectx.newPage();
    await pop.emulateMedia({ colorScheme: "dark" });
    await pop.goto(`chrome-extension://${extId}/popup.html`);
    await pop.waitForSelector(".parcel", { timeout: 10000 });
    await pop.waitForTimeout(600);
    await pop.setViewportSize({ width: 340, height: 100 });
    await pop.waitForTimeout(300);
    const box = await pop.evaluate(() => { const b = document.body.getBoundingClientRect(); return { w: Math.ceil(b.width), h: Math.ceil(Math.max(b.height, document.documentElement.scrollHeight)) }; });
    await pop.setViewportSize({ width: 340, height: box.h });
    await pop.waitForTimeout(300);
    const file = join(out, "ext-popup.jpg");
    await pop.screenshot({ path: file, type: "jpeg", quality: 82, clip: { x: 0, y: 0, width: 340, height: box.h } });
    console.log(`  ext-popup.jpg  340x${box.h}  ${Math.round(statSync(file).size / 1024)} KB`);
  } finally { await ectx.close(); }
  // the shown-once slip: create a throwaway key on the Scratch contract
  await go("keys/new");
  await page.waitForSelector("#label");
  await page.fill("#label", "Release notes bot");
  await page.locator(`input[name="contract"][value="${scratch.id}"]`).check();
  await page.click("text=Create key");
  await page.waitForSelector(".keybox");
  await shot("app-keys-new", { minH: 600, ready: ".keybox" });
  await cleanup();
  console.log("done");
  process.exit(0);
} catch (e) {
  console.log("FAILED:", e && e.stack ? e.stack : e);
  await cleanup();
  process.exit(1);
}
