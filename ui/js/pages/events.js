import { h, mount } from "../dom.js";
import { api } from "../api.js";
import { banner, pageHead, loadInto, tag } from "../components.js";
import { hhmm, eventText, eventTag, plural } from "../format.js";

export function render(view) {
  const body = h("div");
  mount(view, body);
  let es = null, timer = null, lastSeq = 0, gone = false;
  const seen = new Set();
  const status = h("span", { class: "live", role: "status" });
  const sub = h("p", { class: "sub" }, "Read-only. Everything that happens is written down here once.");
  const notice = h("div");
  const tbody = h("tbody");
  const empty = h("div", { class: "cb m", hidden: true }, "Quiet. Nothing has happened yet.");

  const live = (on) => { status.className = "live" + (on ? "" : " off"); mount(status, h("span", { class: "dot" + (on ? "" : " w") }), on ? "Live" : "Reconnecting…"); };
  const addRow = (e, top = true) => {
    if (seen.has(e.seq)) return;
    seen.add(e.seq); lastSeq = Math.max(lastSeq, e.seq);
    const [label, kind] = eventTag(e);
    const tr = h("tr", null, h("td", { class: "mono f tn", style: "width:70px;white-space:nowrap" }, "#" + e.seq), h("td", { class: "mono f tn", style: "width:70px" }, hhmm(e.ts)), h("td", { style: "width:110px" }, tag(label, kind)), h("td", null, eventText(e)));
    top ? tbody.prepend(tr) : tbody.append(tr);
    empty.hidden = true;
  };

  function connect() {
    if (gone) return;
    if (es) es.close();
    es = new EventSource(`/admin/events/stream?after=${lastSeq}`);
    es.onopen = () => { live(true); mount(notice); clearInterval(timer); };
    es.onmessage = (m) => { try { addRow(JSON.parse(m.data)); } catch { /* ignore a malformed frame */ } };
    es.onerror = () => {
      // The browser would retry on its own; we stop it and tell the owner instead, as designed.
      es.close(); es = null; live(false);
      showLost();
      clearInterval(timer);
      timer = setInterval(countMissed, 5000);
    };
  }
  let missed = null;
  async function countMissed() {
    try { const r = await api(`/admin/events?after=${lastSeq}&limit=500`); missed = r.events.length; showLost(); } catch { /* still down */ }
  }
  function showLost() {
    mount(notice, banner("warn bar",
      h("span", null, h("b", null, "Lost the line."), missed == null ? " You may have missed some events while disconnected." : missed === 0 ? " Nothing happened while you were away." : ` You missed ${plural(missed, "event")} while disconnected.`),
      h("button", { class: "btn", type: "button", onclick: catchUp }, "Catch up")));
  }
  async function catchUp() {
    try {
      const r = await api(`/admin/events?after=${lastSeq}&limit=500`);
      r.events.sort((a, b) => a.seq - b.seq).forEach((e) => addRow(e));
      missed = null; mount(notice); clearInterval(timer);
      connect();
    } catch { countMissed(); }
  }

  loadInto(body, () => api("/admin/events?limit=100"), (r) => {
    body.append(h("h1", null, "Events ", status), sub, notice,
      h("div", { class: "card tblwrap" }, h("table", null, tbody), empty));
    r.events.sort((a, b) => a.seq - b.seq).forEach((e) => addRow(e));
    lastSeq = Math.max(lastSeq, r.last_seq || 0);
    empty.hidden = tbody.children.length > 0;
    live(false); mount(status, h("span", { class: "dot w" }), "Connecting…");
    connect();
  });
  return () => { gone = true; if (es) es.close(); clearInterval(timer); };
}
