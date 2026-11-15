import { h, mount } from "./dom.js";
import { themeSwitch } from "./theme.js";

const root = document.getElementById("root");
document.getElementById("themebox").append(themeSwitch());
const mark = () => h("div", { class: "mark", "aria-hidden": "true" }, "M");
let timer = null;

function form(error) {
  clearInterval(timer);
  const pw = h("input", { class: "fld" + (error ? " e" : ""), type: "password", id: "pw", name: "password", autocomplete: "current-password", required: true, "aria-describedby": error ? "err" : null, "aria-invalid": error ? "true" : null });
  const btn = h("button", { class: "btn p", type: "submit" }, error ? "Try again" : "Sign in");
  const f = h("form", { class: "card", onsubmit: submit },
    h("h1", null, "Owner entrance"),
    h("p", { class: "sub" }, "One door, one key. Nobody else signs in."),
    h("label", { for: "pw" }, "Password"), pw,
    h("div", { id: "err", class: "et", role: "alert" }, error || ""),
    btn);
  async function submit(e) {
    e.preventDefault();
    btn.disabled = true;
    try {
      const res = await fetch("/admin/login", { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ password: pw.value }) });
      if (res.ok) { location.replace("/"); return; }
      const data = await res.json().catch(() => ({}));
      if (res.status === 429) { locked(Number(data.retry_after || res.headers.get("retry-after")) || 60); return; }
      if (res.status === 401) {
        const n = data.tries_left;
        form(n === 0 ? "That is not the password. The door locks on the next wrong try."
          : `That is not the password.${typeof n === "number" ? ` ${n} ${n === 1 ? "try" : "tries"} left before the door locks.` : ""}`);
        return;
      }
      form("The door is stuck. Try again in a moment.");
    } catch {
      form("Could not reach the mailroom. Try again in a moment.");
    }
  }
  mount(root, mark(), f);
  pw.focus();
}

function locked(seconds) {
  const end = Date.now() + seconds * 1000;
  const t = h("span", { class: "t" });
  const back = h("button", { class: "btn", type: "button", onclick: () => form() }, "Back to sign in");
  const tick = () => {
    const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
    t.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
    if (left === 0) { clearInterval(timer); form(); }
  };
  mount(root, mark(), h("div", { class: "card" },
    h("h1", null, "Door is locked"),
    h("p", { class: "sub" }, "Too many wrong passwords."),
    h("div", { class: "bn warn", role: "status", style: "display:block" }, "Try again in", t),
    back));
  tick();
  clearInterval(timer);
  timer = setInterval(tick, 1000);
}

form();
