import { h, mount, enc } from "../dom.js";
import { api, keyLabels } from "../api.js";
import { banner, pageHead, loadInto, tag, emptyState } from "../components.js";
import { greeting, hhmm, describeJob, eventText, plural } from "../format.js";

export function render(view, _params, ctx) {
  const body = h("div");
  mount(view, body);
  const load = () => loadInto(body, async () => {
    const state = await api("/admin/state");
    const [labels, laptop] = await Promise.all([
      keyLabels().catch(() => new Map()),
      state.daemon.connected ? null : api("/admin/laptop").catch(() => null),
    ]);
    return { state, labels, laptop };
  }, (d) => draw(body, d, ctx, load));
  load();
}

function draw(body, { state, labels, laptop }, ctx, reload) {
  const { daemon, counts, needs_you: needs, latest_events: events } = state;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const flash = ctx.takeFlash();
  const sub = !daemon.connected ? "Laptop is out to lunch."
    : needs.length ? `${plural(needs.length, "parcel")} ${needs.length === 1 ? "needs" : "need"} you. Everything else is calm.`
    : "The mailroom is open and quiet.";
  body.append(pageHead(greeting(), sub));
  if (flash) body.append(banner(flash.kind, flash.text));

  if (!daemon.connected) {
    body.append(banner("warn bar",
      h("span", null, h("b", null, "Laptop is out to lunch."), ` Last seen ${hhmm(daemon.last_seen)}. New parcels queue up and run in order when it is back.`),
      h("a", { class: "btn", href: "#/laptop" }, "See the queue")));
  }

  if (total === 0 && !events.length && !needs.length) {
    body.append(emptyState("No parcels yet", "Nobody has knocked. Hand out a key and the first parcel shows up here.",
      h("a", { class: "btn", href: "#/keys/new" }, "Hand out a key")));
    return;
  }

  const left = h("div", { class: "f17" });
  if (needs.length) {
    const act = async (id, btn) => {
      btn.disabled = true;
      try { await api(`/admin/jobs/${enc(id)}/approve`, { method: "POST" }); ctx.flash("", `Decision recorded. ${id} is on its way.`); ctx.refresh(); reload(); }
      catch (e) { btn.disabled = false; ctx.flash("err", e.status === 409 ? `${id} is no longer waiting.` : e.message); reload(); }
    };
    left.append(h("div", { class: "card" },
      h("div", { class: "ch" }, h("h2", null, "Needs you ", tag(needs.length, "ac")), h("a", { class: "m", href: "#/approvals" }, "All approvals →")),
      needs.map((j) => {
        const d = describeJob(j);
        const approve = h("button", { class: "btn p", type: "button", onclick: (e) => act(j.id, e.currentTarget) }, "Approve");
        return h("div", { class: "ask" },
          h("div", null,
            h("span", { class: "mono" }, j.id), " ", tag(j.task, "wa"),
            h("div", { class: "what" }, `${labels.get(j.key_id) || j.key_id} wants to ${d.verb} `, h("span", { class: "mono" }, d.target)),
            h("div", { class: "f tn" }, `${d.meta ? d.meta + " · " : ""}asked ${hhmm(j.created_at)}`)),
          h("div", { class: "btns", style: "white-space:nowrap;align-self:flex-start" }, approve,
            h("a", { class: "btn", href: "#/approvals/" + enc(j.id) }, "Review")));
      })));
  }
  if (!daemon.connected && laptop && laptop.queue.length) {
    left.append(h("div", { class: "card" },
      h("div", { class: "ch" }, h("h2", null, "Waiting for the laptop ", tag(laptop.queue.length, "wa")), h("a", { class: "m", href: "#/parcels" }, "All parcels →")),
      h("div", { class: "tblwrap" }, h("table", null, laptop.queue.map((j) => h("tr", null,
        h("td", null, h("a", { class: "mono", href: "#/parcels/" + enc(j.id) }, j.id)), h("td", null, j.task),
        h("td", { class: "f" }, labels.get(j.key_id) || j.key_id), h("td", { class: "f r tn" }, `queued ${hhmm(j.created_at)}`)))))));
  }
  left.append(h("div", { class: "card" },
    h("div", { class: "ch" }, h("h2", null, "Latest events"), h("a", { class: "m", href: "#/events" }, "All events →")),
    events.length ? h("table", null, events.map((e) => h("tr", null, h("td", { class: "mono f tn", style: "width:70px" }, hhmm(e.ts)), h("td", null, eventText(e)))))
      : h("div", { class: "cb m" }, "Quiet so far.")));

  const right = h("div", { class: "f1" },
    h("a", { class: "card", href: "#/laptop", style: "display:block" },
      h("div", { class: "ch" }, h("h2", null, "Laptop"), tag(daemon.connected ? "connected" : "away", daemon.connected ? "ok" : "wa")),
      h("div", { class: "cb" }, daemon.connected ? "Connected" : "Out to lunch", h("div", { class: "f" }, `seen ${daemon.connected ? "just now" : hhmm(daemon.last_seen)}`))),
    h("div", { class: "card" },
      h("div", { class: "ch" }, h("h2", null, "Today"), h("a", { class: "m", href: "#/parcels" }, "Parcels →")),
      h("table", { class: "tn" }, [["done", "Done"], ["running", "Running"], ["queued", "Queued"], ["refused", "Refused"], ["failed", "Failed"]].map(([k, label]) =>
        h("tr", { class: "go", onclick: () => ctx.go("#/parcels") }, h("td", null, label), h("td", { class: "r" + (counts[k] ? "" : " f") }, counts[k] ?? 0))))));

  body.append(h("div", { class: "row" }, left, right));
}
