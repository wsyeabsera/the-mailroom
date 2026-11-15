// Loads the real extension into a throwaway Chromium profile and checks it against a real Worker.
// Needs playwright-core and a Playwright Chromium (no browser is downloaded by this script):
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core node scripts/extension-e2e.mjs
// One deliberate difference from the shipped manifest: host access to http://localhost is granted up front,
// because Chromium's runtime permission prompt (chrome.permissions.request) cannot be clicked in automation.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PORT = 8802;
const BASE = `http://localhost:${PORT}`;
const root = new URL("..", import.meta.url).pathname;
const shots = process.env.SHOTS_DIR || join(tmpdir(), "mailroom-ext-shots");
mkdirSync(shots, { recursive: true });
const pwPath = process.env.PLAYWRIGHT_CORE;
if (!pwPath) { console.log("Set PLAYWRIGHT_CORE to a playwright-core directory."); process.exit(2); }
const { chromium } = await import(pathToFileURL(join(pwPath, "index.mjs")).href);

const pass = readFileSync(join(root, ".dev.vars"), "utf8").match(/^OWNER_PASSWORD=(.*)$/m)[1];
const tmp = mkdtempSync(join(tmpdir(), "mr-ext-"));
const procs = [];
let failed = 0;
const ok = (c, m) => { if (c) console.log(`  ok   ${m}`); else { failed++; console.log(`  FAIL ${m}`); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const killGroup = p => { try { process.kill(-p.pid, "SIGKILL"); } catch { try { p.kill("SIGKILL"); } catch {} } };
let ctx;
const cleanup = async () => { try { await ctx?.close(); } catch {} for (const p of procs) killGroup(p); try { rmSync(tmp, { recursive: true, force: true }); } catch {} };
process.on("exit", () => { for (const p of procs) killGroup(p); });
async function until(fn, ms = 20000) { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(250); } return null; }

console.log("starting the Worker ...");
const w = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--inspector-port", "9353", "--persist-to", join(tmp, "state")], { cwd: root, stdio: "ignore", detached: true });
procs.push(w);
if (!(await until(async () => { try { return (await fetch(BASE + "/admin/state")).status === 401; } catch { return false; } }, 60000))) { console.log("FAIL the Worker did not start"); process.exit(1); }

// Seed through the API (owner cookie for admin calls, client key for jobs).
let cookie = "";
const owner = async (m, p, b) => { const r = await fetch(BASE + p, { method: m, headers: { cookie, "content-type": "application/json", origin: BASE }, body: b === undefined ? undefined : JSON.stringify(b) }); const t = await r.text(); return { s: r.status, j: t ? JSON.parse(t) : null, h: r.headers }; };
let r = await owner("POST", "/admin/login", { password: pass });
cookie = r.h.get("set-cookie").split(";")[0];
const contract = (await owner("POST", "/admin/contracts", { name: "Notes writer", folders: ["~/Hobby/dunder/notes"], tasks: ["echo", "write_file"], dailyLimit: 50, expires: null, approval: ["write_file"] })).j;
const key = (await owner("POST", "/admin/keys", { label: "Dunder Miffbot (prod)", contract_id: contract.id })).j.key;
const addJob = async name => (await (await fetch(BASE + "/api/jobs", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ task: "write_file", args: { path: `~/Hobby/dunder/notes/${name}`, content: "x" } }) })).json()).id;
const first = await addJob("standup.md");
await addJob("ideas.md");

// A test copy of the extension with localhost host access granted up front.
const extDir = join(tmp, "extension");
cpSync(join(root, "extension"), extDir, { recursive: true });
const manifest = JSON.parse(readFileSync(join(extDir, "manifest.json"), "utf8"));
manifest.host_permissions = ["http://localhost/*"];
writeFileSync(join(extDir, "manifest.json"), JSON.stringify(manifest, null, 2));

ctx = await chromium.launchPersistentContext(join(tmp, "profile"), {
  channel: "chromium",
  headless: true,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
const extId = new URL(sw.url()).host;
console.log(`extension loaded (service worker up, id ${extId.slice(0, 8)}...)`);
ok(/^[a-p]{32}$/.test(extId), "the service worker started and has an extension id");

const consoleErrors = [];
const track = p => { p.on("console", m => { if (m.type() === "error") consoleErrors.push(m.text()); }); p.on("pageerror", e => consoleErrors.push(String(e))); };

console.log("signed out, not configured");
const popup = await ctx.newPage();
track(popup);
await popup.goto(`chrome-extension://${extId}/popup.html`);
await popup.waitForTimeout(800);
let text = await popup.innerText("body");
ok(/not set up|settings|hub url|configure/i.test(text), "the popup says it is not configured");
await popup.screenshot({ path: join(shots, "popup-unconfigured.png") });

console.log("signs in on the Hub, then configure");
const login = await ctx.newPage();
await login.goto(`${BASE}/login`);
await login.fill('input[type="password"]', pass);
await login.keyboard.press("Enter");
await login.waitForURL(/#\/|\/$/, { timeout: 10000 }).catch(() => {});
await login.waitForTimeout(800);
ok((await ctx.cookies(BASE)).some(c => c.name === "mr_session"), "the session cookie is in the profile (SameSite=Strict)");

await sw.evaluate(() => { globalThis.__notes = []; const o = chrome.notifications.create.bind(chrome.notifications); chrome.notifications.create = (id, opts, cb) => { globalThis.__notes.push(id); return o(id, opts, cb); }; });
await sw.evaluate(h => chrome.storage.sync.set({ hub: h }), BASE);
const badge = await until(async () => { const t = await sw.evaluate(() => chrome.action.getBadgeText({})); return t === "2" ? t : null; }, 15000);
ok(badge === "2", "the toolbar badge shows 2 approvals waiting (the extension's cookie request was authenticated)");
ok((await sw.evaluate(() => chrome.action.getTitle({}))).includes("out to lunch"), "its tooltip says the laptop is away");
ok((await sw.evaluate(() => globalThis.__notes.length)) === 0, "no notifications on the first poll");

console.log("a new parcel notifies once");
const third = await addJob("plans.md");
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "poll" }));
const n1 = await until(async () => { const n = await sw.evaluate(() => globalThis.__notes); return n.length ? n : null; }, 10000);
ok(n1 && n1.length === 1 && n1[0] === `parcel:${third}`, `one notification for the new parcel (${third})`);
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "poll" }));
await sleep(1500);
ok((await sw.evaluate(() => globalThis.__notes.length)) === 1, "polling again does not notify twice");
ok(await until(async () => (await sw.evaluate(() => chrome.action.getBadgeText({}))) === "3", 8000), "the badge now shows 3");

console.log("popup");
await popup.reload();
await popup.waitForSelector("text=Needs you", { timeout: 10000 }).catch(() => {});
await popup.waitForTimeout(1000);
text = await popup.innerText("body");
const needsSection = text.split(/LATEST/i)[0];
ok(needsSection.includes(first) && needsSection.includes("Dunder Miffbot (prod)"), "the popup's Needs you list shows each parcel with its key label");
ok(/out to lunch|away/i.test(text), "the popup shows the laptop is away");
await popup.emulateMedia({ colorScheme: "dark" });
await popup.waitForTimeout(300);
await popup.screenshot({ path: join(shots, "popup-dark.png") });
await popup.emulateMedia({ colorScheme: "light" });
await popup.waitForTimeout(300);
await popup.screenshot({ path: join(shots, "popup-light.png") });
ok(true, "popup screenshots saved (dark and light)");

console.log("Review opens the Hub");
const [tab] = await Promise.all([ctx.waitForEvent("page", { timeout: 8000 }).catch(() => null), popup.locator("text=Review").first().click().catch(() => {})]);
ok(tab && /#\/approvals/.test(tab.url()), "Review opens the Approvals page in the Hub");
await tab?.close();

console.log("side panel");
const side = await ctx.newPage();
track(side);
await side.goto(`chrome-extension://${extId}/sidepanel.html`);
await side.waitForTimeout(1500);
text = await side.innerText("body");
ok(text.includes(first), "the side panel shows the waiting parcels");
await side.screenshot({ path: join(shots, "sidepanel.png") });

console.log("options");
const opts = await ctx.newPage();
track(opts);
await opts.goto(`chrome-extension://${extId}/options.html`);
await opts.waitForTimeout(800);
ok((await opts.innerText("body")).length > 20, "the options page renders");
await opts.screenshot({ path: join(shots, "options.png") });

console.log("signed out");
await ctx.clearCookies();
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "poll" }));
const out = await until(async () => { const t = await sw.evaluate(() => chrome.action.getBadgeText({})); return t === "x" ? t : null; }, 8000);
ok(out === "x", `the badge says signed out ("${out ?? await sw.evaluate(() => chrome.action.getBadgeText({}))}")`);

ok(consoleErrors.filter(e => !/favicon|ERR_FAILED/.test(e)).length === 0, `no console errors in the extension pages${consoleErrors.length ? " (" + consoleErrors.slice(0, 2).join(" | ") + ")" : ""}`);

console.log(failed ? `\nEXTENSION E2E FAILED (${failed})` : `\nEXTENSION E2E PASSED  (screenshots: ${shots})`);
await cleanup();
process.exit(failed ? 1 : 0);
