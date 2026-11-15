import { h, mount, enc } from "../dom.js";
import { api, keyLabels } from "../api.js";
import { banner, pageHead, loadInto, tag, kv, modal, secretBox } from "../components.js";
import { hhmm, dayMonth, ago, plural } from "../format.js";

export function render(view, _p, ctx) {
  const body = h("div");
  mount(view, body);
  const load = () => loadInto(body, async () => ({ l: await api("/admin/laptop"), labels: await keyLabels().catch(() => new Map()) }), ({ l, labels }) => draw(l, labels));

  function draw(l, labels) {
    const hint = l.credential_hint ? "mrd_•••••••••" + l.credential_hint.slice(-4) : "none yet";
    body.append(pageHead("Laptop", "The daemon that does the actual work."));
    if (!l.connected) body.append(banner("warn", h("span", null, h("b", null, "Laptop is out to lunch."), ` Last seen ${hhmm(l.last_seen)}${l.last_seen ? ", " + ago(l.last_seen) : ""}. Parcels wait their turn and run in order when it is back.`)));
    const status = h("div", { class: "card f1" }, h("div", { class: "ch" }, h("h2", null, "Status"), tag(l.connected ? "connected" : "away", l.connected ? "ok" : "wa")),
      h("div", { class: "cb" }, kv("Last seen", l.connected ? "just now" : l.last_seen ? ago(l.last_seen) : "never"), kv("Last event seen", h("span", { class: "mono" }, l.last_seq != null ? "#" + l.last_seq : "none"))));
    const cred = h("div", { class: "card f1" }, h("div", { class: "ch" }, h("h2", null, "Daemon credential")),
      h("div", { class: "cb" }, h("p", { class: "m", style: "margin:0 0 14px" }, "The laptop proves itself with this, separate from any client key. Rotating it disconnects the laptop until the new one is pasted in."),
        h("div", { class: "kv", style: "margin-bottom:16px" }, h("span", { class: "mono" }, hint), h("span", { class: "f" }, l.rotated_at ? `rotated ${dayMonth(l.rotated_at)}` : "never rotated")),
        h("button", { class: "btn", type: "button", onclick: () => confirmRotate() }, "Rotate credential…")));
    body.append(h("div", { class: "row" }, status, cred));
    if (l.queue.length || !l.connected) {
      body.append(h("div", { class: "card", style: "max-width:640px" }, h("div", { class: "ch" }, h("h2", null, "In the queue"), tag(plural(l.queue.length, "parcel"))),
        l.queue.length ? h("table", null, l.queue.map((j) => h("tr", null, h("td", null, h("a", { class: "mono", href: "#/parcels/" + enc(j.id) }, j.id)), h("td", null, j.task), h("td", { class: "f" }, labels.get(j.key_id) || j.key_id))))
          : h("div", { class: "cb m" }, "Nothing queued.")));
    }
  }

  function confirmRotate() {
    const yes = h("button", { class: "btn d", type: "button", "data-first": "" }, "Yes, rotate and disconnect");
    const m = modal("Rotate the daemon credential?",
      h("ul", { class: "imp" }, h("li", null, "The old credential stops working ", h("b", null, "at once"), "."),
        h("li", null, "The laptop disconnects and parcels queue until you paste the new credential into the daemon."),
        h("li", { class: "m" }, "You will see the new credential once.")),
      h("div", { class: "btns" }, yes, h("button", { class: "btn", type: "button", onclick: () => m.close() }, "Cancel")));
    yes.onclick = async () => {
      yes.disabled = true;
      try { const r = await api("/admin/laptop/rotate", { method: "POST" }); m.close(); ctx.refresh(); shown(r.credential); }
      catch (e) { m.close(); mount(body, banner("err", e.message), h("button", { class: "btn", type: "button", onclick: load }, "Back to laptop")); }
    };
  }

  function shown(cred) {
    const back = h("button", { class: "btn", type: "button", disabled: true, onclick: load }, "Done, back to laptop");
    const box = secretBox(cred, () => { back.disabled = false; back.className = "btn p"; });
    mount(body, h("h1", null, "New daemon credential"), h("p", { class: "sub" }, "The old one is already dead."),
      h("div", { class: "slip" }, h("div", { class: "bn warn", role: "status" }, h("b", null, "Copy it now."), " It is shown once, then only a hash is kept."), box,
        h("ol", { class: "steps2" }, h("li", null, "Copy the credential above."), h("li", null, "On the laptop run ", h("code", null, "mailroom login"), " and paste it."), h("li", null, "The laptop reconnects and queued parcels run.")), back));
  }
  load();
}
