// Dark | Light | System switch. Preference lives in localStorage; the resolved theme is data-theme on <html>.
import { h } from "./dom.js";

const KEY = "mr-theme";
const mq = window.matchMedia("(prefers-color-scheme: dark)");

export function getPref() {
  try { return localStorage.getItem(KEY) || "system"; } catch { return "system"; }
}
function apply(pref) {
  const t = pref === "light" || pref === "dark" ? pref : mq.matches ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", t);
}
export function setPref(pref) {
  try { localStorage.setItem(KEY, pref); } catch { /* private mode: still works for this page view */ }
  apply(pref);
}
mq.addEventListener("change", () => { if (getPref() === "system") apply("system"); });

export function themeSwitch() {
  const box = h("span", { class: "seg", role: "radiogroup", "aria-label": "Theme" });
  const draw = () => {
    box.replaceChildren(
      ...[["dark", "Dark"], ["light", "Light"], ["system", "System"]].map(([v, label]) =>
        h("button", { type: "button", role: "radio", "aria-checked": String(getPref() === v), onclick: () => { setPref(v); draw(); } }, label)));
  };
  draw();
  return box;
}
