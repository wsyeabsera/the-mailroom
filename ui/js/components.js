// Shared pieces: tags, banners, skeleton/error/empty states, modal, copy.
import { h, append } from "./dom.js";
import { STATE_KIND, stateLabel } from "./format.js";

export const tag = (text, kind = "") => h("span", { class: "tag " + kind }, text);
export const stateTag = (s) => tag(stateLabel(s), STATE_KIND[s] || "");

// kind: "" (success) | "warn" | "err". Errors announce assertively, the rest politely.
export function banner(kind, ...kids) {
  return h("div", { class: "bn " + kind, role: kind === "err" ? "alert" : "status" }, ...kids);
}

export function pageHead(title, sub, action) {
  const left = h("div", null, h("h1", null, title), sub != null ? h("p", { class: "sub" }, sub) : null);
  return action ? h("div", { class: "hd" }, left, action) : left;
}

export const skeleton = () =>
  h("div", { class: "card", "aria-busy": "true", "aria-label": "Loading" },
    ...[92, 78, 86, 64, 82, 70].map((w) => h("div", { class: "sk", style: `width:${w}%` })));

export function errorState(err, retry) {
  return h("div", { class: "card empty", role: "alert" },
    h("h2", null, "The post got lost on the way"),
    h("p", { class: "m" }, err && err.message ? err.message : "Something went wrong."),
    h("button", { class: "btn", type: "button", onclick: retry }, "Try again"));
}

export function emptyState(title, text, action) {
  return h("div", { class: "card empty" }, h("h2", null, title), h("p", { class: "m" }, text), action);
}

// Show a skeleton, then render(data) or an error with Retry.
export async function loadInto(el, fetcher, render) {
  el.replaceChildren(skeleton());
  try {
    const data = await fetcher();
    el.replaceChildren();
    render(data);
  } catch (err) {
    if (err.status === 401) return;
    el.replaceChildren(errorState(err, () => loadInto(el, fetcher, render)));
  }
}

export const kv = (label, value) => h("div", { class: "kv" }, h("span", { class: "m" }, label), value instanceof Node ? value : h("span", null, value));

// Modal with focus trap, Escape to close, focus restored. Returns { close, el }.
export function modal(title, ...body) {
  const opener = document.activeElement;
  const dlg = h("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "modal-title", tabindex: "-1" }, h("h2", { id: "modal-title" }, title));
  append(dlg, body);
  const scrim = h("div", { class: "scrim" }, dlg);
  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    scrim.remove();
    if (opener && opener.focus) opener.focus();
  };
  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key !== "Tab") return;
    const f = [...dlg.querySelectorAll("button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])")];
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (!dlg.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  scrim.addEventListener("mousedown", (e) => { if (e.target === scrim) close(); });
  document.addEventListener("keydown", onKey, true);
  document.body.append(scrim);
  (dlg.querySelector("[data-first]") || dlg).focus();
  return { close, el: dlg };
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* fall through to the textarea trick (non-secure context, denied permission) */ }
  const ta = h("textarea", { class: "sr", "aria-hidden": "true", readonly: true });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { /* ignore */ }
  ta.remove();
  return ok;
}

// A shown-once secret: the key box with a Copy button. onCopied() fires after the first successful copy
// (also when the user copies the text by hand).
export function secretBox(secret, onCopied) {
  const text = h("span", { class: "mono", "data-secret": "" }, secret);
  const status = h("span", { class: "tag", role: "status" });
  const btn = h("button", { class: "btn p", type: "button", "data-first": "" }, "Copy");
  let done = false;
  const mark = () => { if (done) return; done = true; btn.replaceWith(status); status.textContent = "Copied"; onCopied(); };
  btn.addEventListener("click", async () => {
    if (await copyText(secret)) mark();
    else { const r = document.createRange(); r.selectNodeContents(text); const s = getSelection(); s.removeAllRanges(); s.addRange(r); btn.textContent = "Press Ctrl+C"; }
  });
  text.addEventListener("copy", mark);
  return h("div", { class: "keybox" }, text, btn);
}
