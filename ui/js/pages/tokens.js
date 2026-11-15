import { h, mount, enc } from "../dom.js";
import { api } from "../api.js";
import { banner, pageHead, loadInto, tag, kv, emptyState, modal, secretBox, copyText } from "../components.js";
import { ago, dayMonth } from "../format.js";

export function render(view, params, ctx) {
  const body = h("div");
  mount(view, body);
  if (params[0] === "new") return newToken(body, ctx);
  return params[0] ? detail(body, params[0], ctx) : list(body, ctx);
}

const newBtn = () => h("a", { class: "btn", href: "#/tokens/new" }, "New token");

// read and write plain, approve amber: the dangerous one stands out
const SCOPE_KIND = { read: "", write: "", approve: "wa" };
const scopeChips = (scopes) => (scopes || []).map((s, i) => [i ? " " : null, tag(s, SCOPE_KIND[s] || "")]);

function list(body, ctx) {
  loadInto(body, () => api("/admin/tokens"), (tokens) => {
    const flash = ctx.takeFlash();
    body.append(pageHead("Tokens", "How other apps and Claude sessions administer the mailroom from outside.", tokens.length ? newBtn() : null));
    if (flash) body.append(banner(flash.kind, flash.text));
    if (!tokens.length) { body.append(emptyState("No tokens yet", "Nothing is administering the mailroom from outside.", h("a", { class: "btn", href: "#/tokens/new" }, "Create a token"))); return; }
    const sorted = [...tokens].sort((a, b) => b.created_at - a.created_at);
    body.append(h("div", { class: "card tblwrap" }, h("table", null,
      h("thead", null, h("tr", null, ["Label", "Scopes", "Last used", "Created", "Status"].map((t) => h("th", null, t)))),
      h("tbody", null, sorted.map((k) => {
        const revoked = !!k.revoked_at;
        return h("tr", { class: "go" + (revoked ? " rv" : ""), onclick: (e) => { if (!e.target.closest("a")) location.hash = "#/tokens/" + enc(k.id); } },
          h("td", null, h("a", { href: "#/tokens/" + enc(k.id), class: revoked ? "nm" : "" }, k.label), h("div", { class: "mono f" }, k.prefix + "…")),
          h("td", null, scopeChips(k.scopes)),
          h("td", { class: "f" }, k.last_used_at ? ago(k.last_used_at) : "never"),
          h("td", { class: "f" }, dayMonth(k.created_at)),
          h("td", null, revoked ? tag("revoked", "er") : tag("active", "ok")));
      })))));
  });
}

function newToken(body, ctx) {
  const label = h("input", { class: "fld", id: "label", maxlength: "60", placeholder: "e.g. Claude Code on the laptop", autocomplete: "off" });
  const err = h("div", { class: "et", id: "label-err", hidden: true });
  const serr = h("div", { class: "et", id: "scopes-err", hidden: true });
  const chosen = new Set(["read"]);
  const showErr = (msg) => {
    err.hidden = !msg; err.textContent = msg || "";
    label.classList.toggle("e", !!msg);
    label.setAttribute("aria-invalid", msg ? "true" : "false");
    label.setAttribute("aria-describedby", msg ? "label-err" : "");
    if (msg) label.focus();
  };
  const showScopeErr = (msg) => { serr.hidden = !msg; serr.textContent = msg || ""; };
  const opt = (name, text, note, locked) => h("label", { class: "opt", style: "color:inherit;font-size:inherit;font-weight:inherit;margin-bottom:8px" },
    h("input", { type: "checkbox", name: "scope", value: name, checked: locked || chosen.has(name), disabled: locked,
      onchange: (e) => { if (e.target.checked) chosen.add(name); else chosen.delete(name); } }),
    h("span", null, h("b", null, name), " ", h("span", { class: "m" }, text)), note ? h("span", { class: "f" }, note) : null);
  const create = h("button", { class: "btn p", type: "submit" }, "Create token");
  const formEl = h("form", { class: "card", style: "max-width:640px", novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    const name = label.value.trim();
    if (!name) return showErr("Every token needs a label, or you will not remember what it is.");
    showErr(""); showScopeErr(""); create.disabled = true;
    try {
      const t = await api("/admin/tokens", { method: "POST", body: { label: name, scopes: ["read", ...["write", "approve"].filter((s) => chosen.has(s))] } });
      ctx.refresh();
      slip(body, t, ctx);
    } catch (e2) {
      create.disabled = false;
      if (e2.status === 422 && e2.data.errors) {
        if (e2.data.errors.scopes) showScopeErr(e2.data.errors.scopes);
        if (e2.data.errors.label || !e2.data.errors.scopes) showErr(e2.data.errors.label || "That did not go through.");
      } else showErr(e2.message);
    }
  } },
    h("div", { class: "cb" },
      h("label", { for: "label" }, "Label"), label, err,
      h("div", { class: "lbl", id: "sc" }, "What it may do"),
      h("div", { role: "group", "aria-labelledby": "sc" },
        opt("read", "look at parcels, keys, contracts and events", "always on", true),
        opt("write", "create and revoke keys, create and edit contracts"),
        opt("approve", "approve or decline waiting parcels")),
      h("div", { class: "bn warn", style: "margin:12px 0 4px" }, h("b", null, "About approve. "), "Whoever holds this token can release a risky step without you reading it, including a Claude session that is itself asking for it."),
      serr,
      h("div", { class: "btns", style: "margin-top:20px" }, create, h("a", { class: "btn", href: "#/tokens" }, "Cancel"))));
  body.append(pageHead("New token", "Name it after whatever will hold it. Read is the default; add more only if you must."), formEl);
}

// One snippet with its own Copy button. onCopied fires after a successful copy.
function snippet(title, lines, onCopied) {
  const text = lines.join("\n");
  const status = h("span", { class: "tag", role: "status" });
  const btn = h("button", { class: "btn", type: "button", onclick: async () => {
    if (await copyText(text)) { btn.replaceWith(status); status.textContent = "Copied"; onCopied(); }
    else btn.textContent = "Select and copy by hand";
  } }, "Copy");
  return h("div", { class: "snip" }, h("div", { class: "lbl" }, title),
    h("div", { class: "keybox" }, h("pre", { class: "mono" }, text), btn));
}

function slip(body, t, ctx) {
  const done = h("button", { class: "btn", type: "button", disabled: true, onclick: () => { ctx.flash("", `Token “${t.label}” is ready. Put it where it will be used.`); ctx.go("#/tokens"); } }, "Done, back to tokens");
  const s1 = h("span", null, h("b", null, "1"), " Copy it");
  const s2 = h("span", null, "2 Store it somewhere safe");
  const copied = () => {
    done.disabled = false; done.className = "btn p";
    s2.replaceChildren(h("b", null, "2"), " Store it somewhere safe");
    note.replaceChildren(h("b", null, "This is the only time the token is shown."), " Once you leave this page it is gone for good.");
  };
  const box = secretBox(t.token, copied);
  const note = h("div", { class: "bn warn" }, h("b", null, "This is the only time the token is shown."), " We keep a hash, not the token, so it cannot be shown again.");
  const origin = location.origin;
  mount(body,
    h("h1", null, `Token for “${t.label}”`),
    h("p", { class: "sub" }, `Scopes: ${(t.scopes || []).join(", ")}.`),
    h("div", { class: "slip" }, h("div", { class: "steps" }, s1, s2, h("span", null, "3 Done")),
      h("div", { "aria-live": "polite" }, note), box,
      h("h2", { style: "margin:4px 0 12px" }, "Ready to paste"),
      snippet("Claude Code", [`claude mcp add --transport http mailroom ${origin}/mcp --header "Authorization: Bearer ${t.token}"`], copied),
      snippet("Claude Code plugin, environment variables", [`export MAILROOM_URL=${origin}`, `export MAILROOM_TOKEN=${t.token}`], copied),
      done));
}

function detail(body, id, ctx) {
  const fetchOne = async () => {
    const t = (await api("/admin/tokens")).find((x) => x.id === id);
    if (!t) throw new Error("No such token. Perhaps it never existed.");
    return t;
  };
  const load = () => loadInto(body, fetchOne, (t) => draw(t));
  const draw = (t, flash) => {
    mount(body);
    const revoked = !!t.revoked_at;
    body.append(h("a", { class: "back", href: "#/tokens" }, "← All tokens"),
      h("div", { class: "hd" },
        h("div", null, h("h1", null, t.label, " ", revoked ? tag("revoked", "er") : tag("active", "ok")),
          h("p", { class: "sub" }, h("span", { class: "mono" }, t.prefix + "…"), revoked ? ` · revoked ${ago(t.revoked_at)}` : ` · created ${dayMonth(t.created_at)} · last used ${t.last_used_at ? ago(t.last_used_at) : "never"}`)),
        revoked ? null : h("button", { class: "btn d", type: "button", onclick: () => revoke(t) }, "Revoke token")));
    if (flash) body.append(flash);
    body.append(h("div", { class: "card", style: "max-width:640px" }, h("div", { class: "ch" }, h("h2", null, "Token")),
      h("div", { class: "cb" },
        kv("Label", t.label),
        kv("Prefix", h("span", { class: "mono" }, t.prefix + "…")),
        kv("Scopes", h("span", null, scopeChips(t.scopes))),
        kv("Created", dayMonth(t.created_at)),
        kv("Last used", t.last_used_at ? ago(t.last_used_at) : "never"),
        revoked ? kv("Revoked", ago(t.revoked_at)) : null)));
    if (revoked) body.append(h("p", null, h("a", { class: "btn", href: "#/tokens" }, "Back to tokens")));
  };
  const revoke = (t) => {
    const yes = h("button", { class: "btn d", type: "button", "data-first": "" }, "Yes, revoke token");
    const m = modal(`Revoke “${t.label}”?`,
      h("ul", { class: "imp" },
        h("li", null, "Stops working on its ", h("b", null, "next request"), ". Anything using it gets a 401."),
        h("li", { class: "m" }, "This cannot be undone: you would create a new token.")),
      h("div", { class: "btns" }, yes, h("button", { class: "btn", type: "button", onclick: () => m.close() }, "Keep it")));
    yes.onclick = async () => {
      yes.disabled = true;
      try {
        const r = await api(`/admin/tokens/${enc(t.id)}/revoke`, { method: "POST" });
        m.close(); ctx.refresh();
        draw({ ...t, revoked_at: r.revoked_at }, banner("", h("span", null, h("b", null, "Token revoked."), " Its next request gets a 401.")));
      } catch (e) { yes.disabled = false; m.close(); draw(t, banner("err", e.message)); }
    };
  };
  load();
}
