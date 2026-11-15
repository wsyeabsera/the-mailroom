import { h, mount, enc } from "../dom.js";
import { api } from "../api.js";
import { banner, pageHead, loadInto, tag, stateTag, kv, emptyState, modal, secretBox } from "../components.js";
import { ago, dayMonth, plural, joinWords, TASK_WORDS, expiryText } from "../format.js";

export function render(view, params, ctx) {
  const body = h("div");
  mount(view, body);
  if (params[0] === "new") return newKey(body, ctx);
  return params[0] ? detail(body, params[0], ctx) : list(body, ctx);
}

const newBtn = () => h("a", { class: "btn", href: "#/keys/new" }, "New key");

function list(body, ctx) {
  loadInto(body, () => api("/admin/keys"), (keys) => {
    const flash = ctx.takeFlash();
    body.append(pageHead("Keys", "One key per client, each tied to a contract.", keys.length ? newBtn() : null));
    if (flash) body.append(banner(flash.kind, flash.text));
    if (!keys.length) { body.append(emptyState("No keys yet", "Nobody can knock until you hand out a key.", h("a", { class: "btn", href: "#/keys/new" }, "Hand out a key"))); return; }
    const sorted = [...keys].sort((a, b) => b.created_at - a.created_at);
    body.append(h("div", { class: "card tblwrap" }, h("table", null,
      h("thead", null, h("tr", null, ["Label", "Contract", "Last used", "Created", "Status"].map((t) => h("th", null, t)))),
      h("tbody", null, sorted.map((k) => {
        const revoked = !!k.revoked_at;
        const fresh = !revoked && !k.last_used_at && Date.now() - k.created_at < 3600e3;
        return h("tr", { class: "go" + (revoked ? " rv" : ""), onclick: (e) => { if (!e.target.closest("a")) location.hash = "#/keys/" + enc(k.id); } },
          h("td", null, h("a", { href: "#/keys/" + enc(k.id), class: revoked ? "nm" : "" }, k.label), fresh ? [" ", tag("new", "ac")] : null, h("div", { class: "mono f" }, k.prefix + "…")),
          h("td", { class: "m" }, k.contract ? k.contract.name : ""),
          h("td", { class: "f" }, k.last_used_at ? ago(k.last_used_at) : "never"),
          h("td", { class: "f" }, dayMonth(k.created_at)),
          h("td", null, revoked ? tag("revoked", "er") : tag("active", "ok")));
      })))));
  });
}

// "what this key can do", in plain words
export function contractSummary(c) {
  const tasks = (c.tasks || []).map((t) => TASK_WORDS[t] || t);
  return h("div", { class: "cb" },
    kv("Folders", h("span", { class: "mono" }, (c.folders || []).join(", "))),
    kv("Tasks", tasks.join(", ")),
    kv("Limit", `${plural(c.dailyLimit, "parcel")} a day`),
    kv("Expires", expiryText(c.expires)),
    kv("Needs approval", (c.approval || []).length ? c.approval.join(", ") : "nothing"));
}

function newKey(body, ctx) {
  loadInto(body, () => api("/admin/contracts"), (contracts) => {
    let chosen = contracts[0] ? contracts[0].id : null;
    const label = h("input", { class: "fld", id: "label", maxlength: "80", placeholder: "e.g. Dunder Miffbot", autocomplete: "off" });
    const err = h("div", { class: "et", id: "label-err", hidden: true });
    const summary = h("div", { class: "card f1", style: "align-self:flex-start" });
    const drawSummary = () => {
      const c = contracts.find((x) => x.id === chosen);
      mount(summary, h("div", { class: "ch" }, h("h2", null, "What this key can do")), c ? contractSummary(c) : h("div", { class: "cb m" }, "Pick a contract."));
    };
    const showErr = (msg) => {
      err.hidden = !msg; err.textContent = msg || "";
      label.classList.toggle("e", !!msg);
      label.setAttribute("aria-invalid", msg ? "true" : "false");
      label.setAttribute("aria-describedby", msg ? "label-err" : "");
      if (msg) label.focus();
    };
    const create = h("button", { class: "btn p", type: "submit" }, "Create key");
    const formEl = h("form", { class: "card f13", novalidate: true, onsubmit: async (e) => {
      e.preventDefault();
      const name = label.value.trim();
      if (!name) return showErr("Every key needs a label, or you will not remember who it is.");
      if (!chosen) return showErr("Pick a contract first, or write a new one.");
      showErr(""); create.disabled = true;
      try {
        const k = await api("/admin/keys", { method: "POST", body: { label: name, contract_id: chosen } });
        ctx.refresh();
        slip(body, k, contracts.find((c) => c.id === chosen), ctx);
      } catch (e2) {
        create.disabled = false;
        if (e2.status === 422 && e2.data.errors) showErr(e2.data.errors.label || e2.data.errors.contract_id || "That did not go through.");
        else showErr(e2.message);
      }
    } },
      h("div", { class: "cb" },
        h("label", { for: "label" }, "Label"), label, err,
        h("div", { class: "lbl", id: "cl" }, "Contract"),
        h("div", { role: "radiogroup", "aria-labelledby": "cl" }, contracts.map((c) => h("label", { class: "opt", style: "color:inherit;font-size:inherit;font-weight:inherit;margin-bottom:8px" },
          h("input", { type: "radio", name: "contract", value: c.id, checked: c.id === chosen, onchange: () => { chosen = c.id; drawSummary(); } }),
          h("b", null, c.name), h("span", { class: "m" }, `${(c.tasks || []).map((t) => TASK_WORDS[t] || t).join(", ")} · ${c.dailyLimit} a day${(c.approval || []).length ? " · needs approval" : ""}`)))),
        h("p", { style: "margin:4px 0 20px" }, h("a", { class: "m", href: "#/contracts/new", style: "text-decoration:underline" }, "+ Write a new contract instead")),
        h("div", { class: "btns" }, create, h("a", { class: "btn", href: "#/keys" }, "Cancel"))));
    body.append(pageHead("New key", "Name it after the client, then pick what it may do."), h("div", { class: "row" }, formEl, summary));
    drawSummary();
  });
}

function slip(body, k, contract, ctx) {
  const done = h("button", { class: "btn", type: "button", disabled: true, onclick: () => { ctx.flash("", `Key “${k.label}” is ready. Hand it to the client.`); ctx.go("#/keys"); } }, "Done, back to keys");
  const s1 = h("span", null, h("b", null, "1"), " Copy it");
  const s2 = h("span", null, "2 Store it somewhere safe");
  const box = secretBox(k.key, () => {
    done.disabled = false; done.className = "btn p";
    s1.textContent = "1 Copy it"; s2.replaceChildren(h("b", null, "2"), " Store it somewhere safe");
    note.replaceChildren(h("b", null, "This is the only time the key is shown."), " Once you leave this page it is gone for good.");
  });
  const note = h("div", { class: "bn warn" }, h("b", null, "This is the only time the key is shown."), " We keep a hash, not the key, so it cannot be shown again.");
  mount(body,
    h("h1", null, `Key for “${k.label}”`),
    h("p", { class: "sub" }, contract ? `Contract: ${contract.name} · ${(contract.tasks || []).join(", ")}, ${contract.dailyLimit} a day.` : ""),
    h("div", { class: "slip" }, h("div", { class: "steps" }, s1, s2, h("span", null, "3 Done")),
      h("div", { "aria-live": "polite" }, note), box, done));
}

function detail(body, id, ctx) {
  const load = () => loadInto(body, () => api("/admin/keys/" + enc(id)), (k) => draw(k));
  const draw = (k, flash) => {
    mount(body);
    const revoked = !!k.revoked_at;
    const c = k.contract || {};
    const jobs = k.recent_jobs || [];
    body.append(h("a", { class: "back", href: "#/keys" }, "← All keys"),
      h("div", { class: "hd" },
        h("div", null, h("h1", null, k.label, " ", revoked ? tag("revoked", "er") : tag("active", "ok")),
          h("p", { class: "sub" }, h("span", { class: "mono" }, k.prefix + "…"), revoked ? ` · revoked ${ago(k.revoked_at)}` : ` · created ${dayMonth(k.created_at)} · last used ${k.last_used_at ? ago(k.last_used_at) : "never"}`)),
        revoked ? null : h("button", { class: "btn d", type: "button", onclick: () => revoke(k) }, "Revoke key")));
    if (flash) body.append(flash);
    body.append(h("div", { class: "row" },
      h("div", { class: "card f1" }, h("div", { class: "ch" }, h("h2", null, "Contract: ", c.name || "")), contractSummary(c),
        h("p", { style: "margin:0 16px 16px" }, h("a", { class: "m", href: "#/contracts/" + enc(c.id || k.contract_id) }, "Edit contract →"))),
      h("div", { class: "card f1" }, h("div", { class: "ch" }, h("h2", null, "Recent parcels")),
        jobs.length ? h("table", null, jobs.map((j) => h("tr", null, h("td", null, h("a", { class: "mono", href: "#/parcels/" + enc(j.id) }, j.id)), h("td", null, j.task), h("td", { class: "r" }, stateTag(j.state)))))
          : h("div", { class: "cb m" }, revoked ? "No new parcels will be accepted from this key." : "Nobody has knocked."))));
    if (revoked) body.append(h("p", null, h("a", { class: "btn", href: "#/keys" }, "Back to keys")));
  };
  const revoke = (k) => {
    const pending = (k.recent_jobs || []).filter((j) => j.state === "queued" || j.state === "waiting_approval").length;
    const yes = h("button", { class: "btn d", type: "button", "data-first": "" }, "Yes, revoke key");
    const m = modal(`Revoke “${k.label}”?`,
      h("ul", { class: "imp" },
        h("li", null, "Stops working ", h("b", null, "immediately"), ". Its next request gets a 401."),
        h("li", null, pending ? `${plural(pending, "queued parcel")} will be cancelled.` : "Nothing is queued, so nothing is cancelled."),
        h("li", { class: "m" }, "This cannot be undone. You would hand out a new key.")),
      h("div", { class: "btns" }, yes, h("button", { class: "btn", type: "button", onclick: () => m.close() }, "Keep it")));
    yes.onclick = async () => {
      yes.disabled = true;
      try {
        const r = await api(`/admin/keys/${enc(k.id)}/revoke`, { method: "POST" });
        m.close(); ctx.refresh();
        const fresh = await api("/admin/keys/" + enc(k.id)).catch(() => ({ ...k, revoked_at: r.revoked_at }));
        draw(fresh, banner("", h("span", null, h("b", null, "Key revoked."), ` Its next request gets a 401, and ${plural(r.cancelled || 0, "queued parcel")} ${r.cancelled === 1 ? "was" : "were"} cancelled.`)));
      } catch (e) { yes.disabled = false; m.close(); draw(k, banner("err", e.message)); }
    };
  };
  load();
}
