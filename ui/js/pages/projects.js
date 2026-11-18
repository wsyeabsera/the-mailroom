// Projects: a card per project (plus the built-in Unassigned), and a tabbed page for one project.
// A project is a label. It grants nothing: contracts and the laptop's policy stay the only gates.
import { h, mount, enc } from "../dom.js";
import { api } from "../api.js";
import { banner, pageHead, loadInto, tag, stateTag, kv, emptyState, modal } from "../components.js";
import { ago, plural, hhmm, eventText, eventTag } from "../format.js";

export const UNASSIGNED = "unassigned";
export const TABS = [["overview", "Overview"], ["parcels", "Parcels"], ["keys", "Keys"], ["commands", "Commands"], ["events", "Events"], ["settings", "Settings"]];
const PRESETS = ["#f2703a", "#4cc38a", "#e5a84b", "#5b8def", "#b07cf0", "#e0557f", "#2fb8c4", "#8a8f98"];

export function render(view, params, ctx) {
  const body = h("div");
  mount(view, body);
  if (!params[0]) return home(body, ctx);
  const tab = TABS.some(([k]) => k === params[1]) ? params[1] : "overview";
  return detail(body, params[0], tab, ctx);
}

const swatch = (color) => (color ? h("span", { class: "sw", style: `background:${color}`, "aria-hidden": "true" }) : h("span", { class: "sw", "aria-hidden": "true" }));
const projectHref = (id, tab) => `#/projects/${enc(id)}${tab && tab !== "overview" ? "/" + tab : ""}`;

// "Running now" with a progress bar when the job reports a percentage.
function runningLine(running) {
  if (!running) return h("span", { class: "m" }, "nothing running");
  const p = running.progress;
  return h("div", null,
    h("div", null, h("b", null, running.task), " ", h("a", { class: "mono f", href: "#/parcels/" + enc(running.job_id) }, running.job_id)),
    p && typeof p.pct === "number" ? h("progress", { class: "pr", max: "100", value: String(p.pct), "aria-label": `Progress ${p.pct} percent` }) : null,
    h("div", { class: "f" }, p ? `${p.text}${typeof p.pct === "number" ? " · " + p.pct + "%" : ""}` : "no progress reported yet"));
}

const todayText = (t) => `${t.done} done · ${t.failed} failed · ${t.refused} refused`;
const lastRunText = (l) => (l ? [stateTag(l.state), " ", h("span", { class: "f" }, ago(l.at))] : h("span", { class: "m" }, "none yet"));

// ---------------------------------------------------------------- home
function home(body, ctx) {
  const load = () => loadInto(body, async () => ({ list: await api("/admin/projects"), state: await api("/admin/state").catch(() => null) }), ({ list, state }) => {
    const flash = ctx.takeFlash();
    body.append(pageHead("Projects", "One card per project. A project is a label that groups keys; it never grants anything.", h("button", { class: "btn p", type: "button", onclick: () => createProject(ctx) }, "New project")));
    if (flash) body.append(banner(flash.kind, flash.text));
    const live = list.filter((p) => !p.archived_at);
    const archived = list.filter((p) => p.archived_at);
    const away = state && !state.daemon.connected;
    const card = (p) => {
      const un = p.id === UNASSIGNED;
      return h("div", { class: "card pcard" },
        h("div", { class: "ch" }, h("h2", null, swatch(p.color), h("a", { href: projectHref(p.id) }, p.name)), un ? tag("built in") : p.archived_at ? tag("archived") : null),
        h("div", { class: "cb" },
          p.folder ? h("div", { class: "mono f" }, p.folder) : null,
          un ? h("div", { class: "m" }, "Keys that belong to no project yet.") : null,
          state ? kv("Laptop", h("span", null, h("span", { class: "dot" + (away ? " w" : "") }), away ? "away" : "connected")) : null,
          kv("Running now", runningLine(p.running)),
          kv("Queued", String(p.queued)),
          kv("Last run", lastRunText(p.last_run)),
          kv("Today", todayText(p.today)),
          kv("Active keys", h("a", { href: projectHref(p.id, "keys") }, String(p.key_count)))));
    };
    if (!live.filter((p) => p.id !== UNASSIGNED).length) {
      body.append(emptyState("No projects yet", "Create a project for each app that sends parcels, then move its keys in. Until then everything sits under Unassigned.", h("button", { class: "btn p", type: "button", onclick: () => createProject(ctx) }, "Create your first project")));
    }
    body.append(h("div", { class: "pgrid" }, live.map(card)));
    if (archived.length) {
      body.append(h("details", { class: "card" }, h("summary", { class: "ch", style: "cursor:pointer" }, h("h2", null, `Archived projects · ${archived.length}`)),
        h("div", { class: "pgrid cb" }, archived.map(card))));
    }
  });
  load();
}

// ---------------------------------------------------------------- forms
function colourField(current) {
  const opts = [...PRESETS];
  if (current && !opts.includes(current.toLowerCase())) opts.push(current);
  let value = current || "";
  const name = "pcolor" + Math.random().toString(36).slice(2, 6);
  const radio = (v, label, color) => h("label", { class: "chip" },
    h("input", { type: "radio", name, value: v, checked: v === value, onchange: () => { value = v; } }),
    h("span", null, color ? swatch(color) : null, label));
  const el = h("div", { role: "radiogroup", "aria-labelledby": name + "l" },
    h("div", { class: "lbl", id: name + "l" }, "Colour"),
    h("div", { class: "swatches" }, radio("", "none"), opts.map((c, i) => radio(c, c === current ? c : `Colour ${i + 1}`, c))));
  return { el, value: () => value || null };
}

function projectForm(p, onSaved, { submitLabel, extra }) {
  const f = (id, label, node, hint) => [h("label", { for: id }, label), node, h("div", { class: "et", id: id + "-err", hidden: true }), hint ? h("div", { class: "f", style: "margin:-10px 0 16px" }, hint) : null];
  const name = h("input", { class: "fld", id: "pj-name", maxlength: "60", value: p.name || "", autocomplete: "off", placeholder: "e.g. Dunder Miffbot" });
  const folder = h("input", { class: "fld", id: "pj-folder", value: p.folder || "", autocomplete: "off", placeholder: "~/Hobby/dunder (optional)" });
  const notes = h("textarea", { class: "fld", id: "pj-notes", maxlength: "2000", rows: "3" });
  notes.value = p.notes || "";
  const colour = colourField(p.color);
  const fields = { name, folder, notes };
  const submit = h("button", { class: "btn p", type: "submit" }, submitLabel);
  const status = h("div", { role: "status", class: "m", style: "margin-top:12px" });
  const showErrors = (errors) => {
    let first = null;
    for (const [k, el] of Object.entries(fields)) {
      const e = errors[k];
      const box = document.getElementById("pj-" + k + "-err");
      if (box) { box.hidden = !e; box.textContent = e || ""; }
      el.classList.toggle("e", !!e);
      el.setAttribute("aria-invalid", e ? "true" : "false");
      if (e) { el.setAttribute("aria-describedby", "pj-" + k + "-err"); first = first || el; } else el.removeAttribute("aria-describedby");
    }
    if (errors.color) status.textContent = errors.color;
    if (first) first.focus();
  };
  const el = h("form", { novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    status.textContent = "";
    showErrors({});
    submit.disabled = true;
    try {
      await onSaved({ name: name.value.trim(), folder: folder.value.trim() || null, notes: notes.value, color: colour.value() });
    } catch (err) {
      if (err.status === 422 && err.data.errors) showErrors(err.data.errors);
      else status.textContent = err.message;
    }
    submit.disabled = false;
  } },
  f("pj-name", "Name", name), f("pj-folder", "Folder", folder, "The project's folder on the laptop. Informational; contracts decide what a key may touch."), f("pj-notes", "Notes", notes), colour.el,
  h("div", { class: "btns" }, submit, extra), status);
  return el;
}

function createProject(ctx) {
  const cancel = h("button", { class: "btn", type: "button" }, "Cancel");
  const form = projectForm({}, async (data) => {
    const p = await api("/admin/projects", { method: "POST", body: data });
    m.close();
    ctx.flash("", `Project “${p.name}” created. Move a key in, or hand out a new one.`);
    ctx.go(projectHref(p.id));
  }, { submitLabel: "Create project", extra: cancel });
  const m = modal("New project", form);
  cancel.onclick = () => m.close();
  form.querySelector("input").setAttribute("data-first", "");
  form.querySelector("input").focus();
}

// ---------------------------------------------------------------- one project
function detail(body, id, tab, ctx) {
  let projects = [];
  const load = () => loadInto(body, async () => ({ d: await api("/admin/projects/" + enc(id)), all: await api("/admin/projects") }), ({ d, all }) => { projects = all; draw(d); });
  const names = () => new Map(projects.map((p) => [p.id, p.name]));
  const reload = () => load();

  function draw(d) {
    const un = d.id === UNASSIGNED;
    const flash = ctx.takeFlash();
    body.append(h("a", { class: "back", href: "#/projects" }, "← All projects"),
      h("div", { class: "hd" }, h("div", null,
        h("h1", null, swatch(d.color), d.name, " ", d.archived_at ? tag("archived") : null),
        h("p", { class: "sub" }, un ? "Keys that belong to no project yet." : d.folder ? h("span", { class: "mono" }, d.folder) : "No folder set."))),
      h("nav", { class: "tabs", "aria-label": "Project sections" }, TABS.map(([k, label]) => h("a", { href: projectHref(d.id, k), "aria-current": k === tab ? "page" : null }, label))));
    if (flash) body.append(banner(flash.kind, flash.text));
    const panel = h("div", { id: "panel" });
    body.append(panel);
    ({ overview, parcels, keys, commands, events, settings })[tab](panel, d);
  }

  const keyLabelMap = (d) => new Map(d.keys.map((k) => [k.id, k.label]));

  function overview(el, d) {
    el.append(h("div", { class: "row" },
      h("div", { class: "card f1" }, h("div", { class: "ch" }, h("h2", null, "Right now")),
        h("div", { class: "cb" }, kv("Running now", runningLine(d.running)), kv("Queued", String(d.queued)), kv("Last run", lastRunText(d.last_run)), kv("Today", todayText(d.today)), kv("Active keys", h("a", { href: projectHref(d.id, "keys") }, String(d.key_count))))),
      h("div", { class: "card f1" }, h("div", { class: "ch" }, h("h2", null, "Notes")),
        h("div", { class: "cb", style: "white-space:pre-wrap" }, d.notes ? d.notes : h("span", { class: "m" }, un(d) ? "Unassigned has no notes." : "No notes. Add some under Settings.")))));
    if (!d.keys.length) {
      el.append(emptyState("No keys in this project", un(d) ? "Every key already belongs to a project." : "Move an existing key in from its Keys tab, or hand out a new key for this project.", un(d) ? null : h("a", { class: "btn", href: "#/keys/new/" + enc(d.id) }, "Hand out a key")));
    } else jobsCard(el, d, "Recent parcels");
  }
  const un = (d) => d.id === UNASSIGNED;

  function jobsCard(el, d, title) {
    const labels = keyLabelMap(d);
    el.append(h("div", { class: "card tblwrap" }, h("div", { class: "ch" }, h("h2", null, title), tag(plural(d.recent_jobs.length, "parcel"))),
      d.recent_jobs.length ? h("table", null,
        h("thead", null, h("tr", null, ["Parcel", "Task", "Key", "State"].map((t) => h("th", null, t)), h("th", { class: "r" }, "Sent"))),
        h("tbody", null, d.recent_jobs.map((j) => h("tr", null,
          h("td", null, h("a", { class: "mono", href: "#/parcels/" + enc(j.id) }, j.id)), h("td", null, j.task), h("td", { class: "m" }, labels.get(j.key_id) || j.key_id), h("td", null, stateTag(j.state)), h("td", { class: "f tn r" }, hhmm(j.created_at))))))
        : h("div", { class: "cb m" }, "No parcels yet. Once a key in this project knocks, its parcels show up here.")));
  }

  function parcels(el, d) {
    jobsCard(el, d, "Latest parcels");
    el.append(h("p", { class: "m" }, "The latest 20 parcels sent with this project's keys. ", h("a", { href: "#/parcels", style: "text-decoration:underline" }, "See every parcel")));
  }

  function keys(el, d) {
    el.append(h("div", { class: "hd", style: "margin-bottom:12px" }, h("p", { class: "m", style: "margin:0" }, "Moving a key changes where its parcels are counted. It does not change what the key may do."),
      un(d) || d.archived_at ? null : h("a", { class: "btn", href: "#/keys/new/" + enc(d.id) }, "New key in this project")));
    if (!d.keys.length) { el.append(emptyState("No keys here", un(d) ? "Every key belongs to a project." : "Hand out a new key, or move one in from another project.", un(d) || d.archived_at ? null : h("a", { class: "btn", href: "#/keys/new/" + enc(d.id) }, "Hand out a key"))); return; }
    el.append(h("div", { class: "card tblwrap" }, h("table", null,
      h("thead", null, h("tr", null, ["Label", "Contract", "Last used", "Status"].map((t) => h("th", null, t)), h("th", { class: "r" }, "Move"))),
      h("tbody", null, d.keys.map((k) => {
        const revoked = !!k.revoked_at;
        return h("tr", { class: revoked ? "rv" : "" },
          h("td", null, h("a", { href: "#/keys/" + enc(k.id), class: revoked ? "nm" : "" }, k.label), h("div", { class: "mono f" }, k.prefix + "…")),
          h("td", { class: "m" }, k.contract ? k.contract.name : ""), h("td", { class: "f" }, k.last_used_at ? ago(k.last_used_at) : "never"),
          h("td", null, revoked ? tag("revoked", "er") : tag("active", "ok")),
          h("td", { class: "r" }, revoked ? null : h("button", { class: "btn", type: "button", "aria-label": `Move key ${k.label}`, onclick: () => moveKey(k, d) }, "Move…")));
      })))));
  }

  function moveKey(k, d) {
    const sel = h("select", { class: "fld", id: "mv-to", "data-first": "" },
      h("option", { value: "" }, "Unassigned"),
      projects.filter((p) => p.id !== UNASSIGNED && !p.archived_at).map((p) => h("option", { value: p.id, selected: p.id === k.project_id }, p.name)));
    const status = h("div", { role: "alert", class: "et", hidden: true });
    const go = h("button", { class: "btn p", type: "button" }, "Move key");
    const m = modal(`Move “${k.label}”`, h("label", { for: "mv-to" }, "To project"), sel, status,
      h("div", { class: "btns" }, go, h("button", { class: "btn", type: "button", onclick: () => m.close() }, "Cancel")));
    go.onclick = async () => {
      go.disabled = true;
      try {
        await api("/admin/keys/" + enc(k.id), { method: "PATCH", body: { project_id: sel.value || null } });
        m.close();
        ctx.flash("", `Moved “${k.label}” to ${sel.selectedOptions[0].textContent}.`);
        ctx.refresh();
        mount(body); reload();
      } catch (e) { status.hidden = false; status.textContent = (e.data && e.data.errors && e.data.errors.project_id) || e.message; go.disabled = false; }
    };
  }

  const MISMATCH = {
    "other-project": "Tagged to another project on the laptop",
    "unknown-project": "Tagged to a project that is missing or archived",
    "not-on-laptop": "Allowed by a key's contract, but not on the laptop",
  };
  function commands(el, d) {
    const c = d.commands;
    if (!c.reported) el.append(banner("warn", h("span", null, h("b", null, "The laptop has not reported commands."), " Start the daemon (or restart it) and it sends its command list. Until then nothing can be checked against it.")));
    if (!c.rows.length) { el.append(emptyState("No commands here", un(d) ? "Commands show here when a key's contract allows them. Tag a command on the laptop with a project to list it under that project." : "Tag a command on the laptop with this project's id, or put it in the contract of one of this project's keys.")); return; }
    const pn = names();
    const labels = keyLabelMap(d);
    el.append(h("div", { class: "card tblwrap" }, h("table", null,
      h("thead", null, h("tr", null, ["Command", "On the laptop", "Tagged to", "Allowed via", "Check"].map((t) => h("th", null, t)))),
      h("tbody", null, c.rows.map((r) => h("tr", null,
        h("td", null, h("span", { class: "mono" }, r.name)),
        h("td", null, c.reported ? (r.onLaptop ? tag("yes", "ok") : tag("no", "wa")) : h("span", { class: "f" }, "unknown")),
        h("td", { class: "m" }, r.taggedTo ? pn.get(r.taggedTo) || r.taggedTo : "no project"),
        h("td", { class: "m" }, r.viaKeys.length ? r.viaKeys.map((id) => labels.get(id) || id).join(", ") : "no key"),
        h("td", null, r.mismatch ? tag(MISMATCH[r.mismatch], r.mismatch === "not-on-laptop" ? "wa" : "er") : tag("ok", "ok"))))))));
  }

  function events(el, d) {
    const keyIds = new Set(d.keys.map((k) => k.id));
    const jobIds = new Set(d.recent_jobs.map((j) => j.id));
    const box = h("div");
    el.append(box);
    loadInto(box, () => api("/admin/events?limit=500&tail=1"), (r) => {
      const mine = r.events.filter((e) => { const p = e.payload || {}; return p.project_id === d.id || p.from === d.id || p.to === d.id || (p.key_id && keyIds.has(p.key_id)) || (p.job_id && jobIds.has(p.job_id)); }).sort((a, b) => b.seq - a.seq);
      box.append(mine.length ? h("div", { class: "card tblwrap" }, h("table", null, h("tbody", null, mine.map((e) => {
        const [label, kind] = eventTag(e);
        return h("tr", null, h("td", { class: "mono f tn", style: "width:70px" }, "#" + e.seq), h("td", { class: "mono f tn", style: "width:70px" }, hhmm(e.ts)), h("td", { style: "width:110px" }, tag(label, kind)), h("td", null, eventText(e)));
      }))))
        : emptyState("Quiet", "Nothing has happened in this project lately. Events appear when its keys send parcels or when it is edited."));
      box.append(h("p", { class: "m" }, "Showing this project's events from the latest 500. ", h("a", { href: "#/events", style: "text-decoration:underline" }, "See every event")));
    });
  }

  function settings(el, d) {
    if (un(d)) { el.append(emptyState("Unassigned cannot be edited", "It is built in: it holds every key that has no project. Move a key out of it from the Keys tab, or choose a project when you create the key.")); return; }
    const result = h("div");
    const form = projectForm(d, async (data) => {
      await api("/admin/projects/" + enc(d.id), { method: "PATCH", body: data });
      ctx.flash("", "Saved.");
      mount(body); reload();
    }, { submitLabel: "Save changes" });
    el.append(h("div", { class: "card", style: "max-width:640px" }, h("div", { class: "ch" }, h("h2", null, "Project details")), h("div", { class: "cb" }, form)));
    const act = d.archived_at
      ? h("button", { class: "btn", type: "button", onclick: () => archive(d, "unarchive", result) }, "Unarchive project")
      : h("button", { class: "btn d", type: "button", onclick: () => archive(d, "archive", result) }, "Archive project");
    el.append(h("div", { class: "card", style: "max-width:640px" }, h("div", { class: "ch" }, h("h2", null, "Archive")),
      h("div", { class: "cb" }, h("p", { class: "m", style: "margin-top:0" }, d.archived_at ? "This project is archived: it is hidden from the home page and new keys cannot join it. Its history stays." : "Archiving hides the project from the home page and keeps its history. A project with active keys cannot be archived: move or revoke the keys first."),
        act, result)));
  }

  async function archive(d, what, result) {
    mount(result);
    try {
      await api(`/admin/projects/${enc(d.id)}/${what}`, { method: "POST" });
      ctx.flash("", what === "archive" ? `“${d.name}” is archived.` : `“${d.name}” is back.`);
      ctx.refresh();
      mount(body); reload();
    } catch (e) {
      const keysLink = e.data && e.data.error === "has_active_keys" ? [" ", h("a", { href: projectHref(d.id, "keys"), style: "text-decoration:underline" }, "Go to its keys")] : null;
      mount(result, h("div", { style: "margin-top:16px" }, banner("err", e.message, keysLink)));
    }
  }

  load();
}
