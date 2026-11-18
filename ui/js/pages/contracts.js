import { h, mount, enc } from "../dom.js";
import { api } from "../api.js";
import { banner, pageHead, loadInto, tag, emptyState } from "../components.js";
import { plural, joinWords, TASK_WORDS, expiryText } from "../format.js";

const ALL_TASKS = ["echo", "read_file", "write_file", "claude", "run"];

export function render(view, params, ctx) {
  const body = h("div");
  mount(view, body);
  return params[0] ? editor(body, params[0], ctx) : list(body, ctx);
}

function list(body, ctx) {
  loadInto(body, () => api("/admin/contracts"), (cs) => {
    const flash = ctx.takeFlash();
    body.append(pageHead("Contracts", "What a key may do. Edits apply to the next parcel, and queued ones are checked again just before they are sent.", h("a", { class: "btn", href: "#/contracts/new" }, "New contract")));
    if (flash) body.append(banner(flash.kind, flash.text));
    if (!cs.length) { body.append(emptyState("No contracts yet", "A contract says what a key may do. Write one, then hand out a key.", h("a", { class: "btn", href: "#/contracts/new" }, "New contract"))); return; }
    body.append(h("div", { class: "card tblwrap" }, h("table", null,
      h("thead", null, h("tr", null, ["Name", "Folders", "Tasks", "Limit", "Expires", "Used by"].map((t) => h("th", null, t)))),
      h("tbody", null, cs.map((c) => h("tr", { class: "go", onclick: (e) => { if (!e.target.closest("a")) location.hash = "#/contracts/" + enc(c.id); } },
        h("td", null, h("a", { href: "#/contracts/" + enc(c.id) }, c.name)),
        h("td", { class: "mono" }, (c.folders || []).map((f) => h("div", null, f))),
        h("td", null, (c.tasks || []).map((t) => [tag(TASK_WORDS[t] || t), " "])),
        h("td", { class: "tn" }, `${c.dailyLimit} / day`), h("td", { class: "f" }, expiryText(c.expires)),
        h("td", { class: "m" }, plural(c.used_by || 0, "key"))))))));
  });
}

// "In plain words": the same sentence the owner will be agreeing to.
function plainWords(c) {
  const out = [];
  const folders = c.folders.filter(Boolean);
  if (!c.tasks.length) return [h("span", { class: "f" }, "Nothing is allowed yet. Pick at least one task.")];
  const tasks = c.tasks.map((t) => TASK_WORDS[t] || t);
  const where = folders.length ? [" inside ", ...folders.flatMap((f, i) => [i ? (i === folders.length - 1 ? " and " : ", ") : "", h("span", { class: "mono" }, f)])] : [" nowhere yet (add a folder)"];
  out.push("Keys on this contract can ", h("b", null, joinWords(tasks)), where, ", up to ",
    h("b", null, `${Number.isFinite(c.limit) ? plural(c.limit, "parcel") : "an unknown number of parcels"} a day`), ", ",
    c.expires ? ["expiring ", h("b", null, c.expires)] : "with no expiry", ".");
  out.push(h("br"));
  if (c.approval.length) out.push("Every ", h("b", null, joinWords(c.approval)), c.approval.length > 1 ? " waits" : " waits", " for your approval first.");
  else out.push("Nothing waits for your approval.");
  out.push(h("br"), h("span", { class: "f" }, "Nothing else is allowed."));
  return out;
}

function editor(body, id, ctx) {
  const isNew = id === "new";
  loadInto(body, async () => isNew ? { name: "", folders: [], tasks: ["echo"], dailyLimit: 50, expires: null, approval: [], commands: [], claudeTools: ["Read", "Glob", "Grep"], claudeMaxTurns: 10, used_by: 0 } : api("/admin/contracts/" + enc(id)), (c) => {
    const f = { name: c.name, folders: (c.folders || []).join("\n"), tasks: new Set(c.tasks), limit: String(c.dailyLimit), expires: c.expires ? (c.expires.endsWith("T00:00:00.000Z") ? c.expires.slice(0, 10) : c.expires) : "", approval: new Set(c.approval), commands: (c.commands || []).join("\n"), claudeTools: (c.claudeTools || ["Read", "Glob", "Grep"]).join("\n"), claudeMaxTurns: String(c.claudeMaxTurns != null ? c.claudeMaxTurns : 10) };
    const errBox = h("div");
    const errs = {};
    const field = (key, node) => { const e = h("div", { class: "et", id: "e-" + key, hidden: true }); errs[key] = { e, node }; return [node, e]; };
    const name = h("input", { class: "fld", id: "f-name", value: f.name, maxlength: "60", oninput: () => { f.name = name.value; } });
    const folders = h("textarea", { class: "fld", id: "f-folders", rows: "3", placeholder: "~/Hobby/notes", oninput: () => { f.folders = folders.value; sync(); } }); folders.value = f.folders;
    const commands = h("textarea", { class: "fld", id: "f-commands", rows: "2", placeholder: "deploy-notes", oninput: () => { f.commands = commands.value; } }); commands.value = f.commands;
    const claudeTools = h("textarea", { class: "fld", id: "f-claudeTools", rows: "2", placeholder: "Read", oninput: () => { f.claudeTools = claudeTools.value; } }); claudeTools.value = f.claudeTools;
    const claudeMaxTurns = h("input", { class: "fld", id: "f-claudeMaxTurns", value: f.claudeMaxTurns, inputmode: "numeric", oninput: () => { f.claudeMaxTurns = claudeMaxTurns.value; } });
    const limit = h("input", { class: "fld", id: "f-dailyLimit", value: f.limit, inputmode: "numeric", oninput: () => { f.limit = limit.value; sync(); } });
    const expires = h("input", { class: "fld", id: "f-expires", value: f.expires, placeholder: "Never (or 2026-12-31)", oninput: () => { f.expires = expires.value; sync(); } });
    const chips = (set, source, key) => h("div", { id: "f-" + key, role: "group" }, source().map((t) => {
      const cb = h("input", { type: "checkbox", checked: set.has(t), disabled: key === "approval" && !f.tasks.has(t), onchange: () => { cb.checked ? set.add(t) : set.delete(t); if (key === "tasks") { for (const a of [...f.approval]) if (!f.tasks.has(a)) f.approval.delete(a); drawChips(); } sync(); } });
      return h("label", { class: "chip", style: "font-size:inherit;margin-bottom:16px" }, cb, h("span", null, t));
    }));
    const tasksBox = h("div"), apprBox = h("div");
    const drawChips = () => { mount(tasksBox, chips(f.tasks, () => ALL_TASKS, "tasks")); mount(apprBox, chips(f.approval, () => ALL_TASKS, "approval")); };
    const plain = h("div", { class: "cb plain", "aria-live": "polite" });
    const sync = () => {
      const lines = f.folders.split("\n").map((s) => s.trim()).filter(Boolean);
      mount(plain, plainWords({ folders: lines, tasks: ALL_TASKS.filter((t) => f.tasks.has(t)), limit: /^\d+$/.test(f.limit.trim()) ? Number(f.limit) : NaN, expires: f.expires.trim(), approval: ALL_TASKS.filter((t) => f.approval.has(t) && f.tasks.has(t)) }));
    };
    const save = h("button", { class: "btn p", type: "submit" }, "Save contract");
    const showErrors = (errors) => {
      const keys = Object.keys(errors || {});
      for (const [k, { e, node }] of Object.entries(errs)) { const m = errors && errors[k]; e.hidden = !m; e.textContent = m || ""; node.classList.toggle?.("e", !!m); }
      mount(errBox, keys.length ? banner("err", h("span", null, h("b", null, "Not saved."), ` Fix ${plural(keys.length, "thing")} below.`)) : null);
      const first = keys.map((k) => document.getElementById("f-" + k)).find(Boolean);
      if (first) (first.querySelector ? first.querySelector("input") || first : first).focus();
    };
    const form = h("form", { class: "card f13", novalidate: true, onsubmit: async (ev) => {
      ev.preventDefault();
      const raw = f.limit.trim();
      const payload = { name: f.name, folders: f.folders.split("\n").map((s) => s.trim()).filter(Boolean), tasks: ALL_TASKS.filter((t) => f.tasks.has(t)), dailyLimit: /^\d+$/.test(raw) ? Number(raw) : raw, expires: f.expires.trim() || null, approval: ALL_TASKS.filter((t) => f.approval.has(t)), commands: f.commands.split("\n").map((s) => s.trim()).filter(Boolean), claudeTools: f.claudeTools.split("\n").map((s) => s.trim()).filter(Boolean), claudeMaxTurns: /^\d+$/.test(f.claudeMaxTurns.trim()) ? Number(f.claudeMaxTurns) : f.claudeMaxTurns.trim() };
      save.disabled = true;
      try {
        const saved = isNew ? await api("/admin/contracts", { method: "POST", body: payload }) : await api("/admin/contracts/" + enc(id), { method: "PUT", body: payload });
        ctx.flash("", `Contract “${(saved && saved.name) || payload.name}” saved.`);
        ctx.go("#/contracts");
      } catch (e) {
        save.disabled = false;
        if (e.status === 422 && e.data.errors) showErrors(e.data.errors);
        else mount(errBox, banner("err", h("span", null, h("b", null, "Not saved."), " " + e.message)));
      }
    } },
      h("div", { class: "cb" },
        h("label", { for: "f-name" }, "Name"), field("name", name),
        h("label", { for: "f-folders" }, "Allowed folders (one per line)"), field("folders", folders),
        h("div", { class: "lbl" }, "Allowed tasks"), tasksBox, ...field("tasks", h("span")),
        h("div", { class: "row" }, h("div", { class: "f1" }, h("label", { for: "f-dailyLimit" }, "Daily limit (parcels)"), field("dailyLimit", limit)), h("div", { class: "f1" }, h("label", { for: "f-expires" }, "Expires"), field("expires", expires))),
        h("label", { for: "f-commands" }, "Allowed commands for the run task (one name per line; the laptop's commands.json decides what each does)"), field("commands", commands),
        h("label", { for: "f-claudeTools" }, "Tools the claude task may use (one per line, exact names; a job with none listed gets all of these)"), field("claudeTools", claudeTools),
        h("label", { for: "f-claudeMaxTurns" }, "Most turns a claude job may take (1 to 50)"), field("claudeMaxTurns", claudeMaxTurns),
        h("div", { class: "lbl" }, "Needs your approval"), apprBox, ...field("approval", h("span")),
        h("div", { class: "btns" }, save, h("a", { class: "btn", href: "#/contracts" }, "Cancel"))));
    drawChips(); sync();
    body.append(
      pageHead(isNew ? "New contract" : c.name, isNew ? "Say what a key may do." : [c.used_by ? h("a", { href: "#/keys", style: "text-decoration:underline" }, plural(c.used_by, "key")) : "No keys", ` use${c.used_by === 1 ? "s" : ""} this contract. Changes apply to the next parcel and to queued ones at once.`]),
      errBox,
      h("div", { class: "row" }, form, h("div", { class: "card f1", style: "align-self:flex-start" }, h("div", { class: "ch" }, h("h2", null, "In plain words")), plain)));
  });
}
