import { h, mount, enc } from "../dom.js";
import { api, keyLabels } from "../api.js";
import { banner, pageHead, loadInto, tag, kv, emptyState } from "../components.js";
import { hhmm, describeJob, plural, bytes } from "../format.js";

export function render(view, params, ctx) {
  const body = h("div");
  mount(view, body);
  return params[0] ? detail(body, params[0], ctx) : list(body, ctx);
}

async function decide(id, verdict) {
  await api(`/admin/jobs/${enc(id)}/${verdict}`, { method: "POST" });
  ctx_refresh();
}
let ctx_refresh = () => {};

function list(body, ctx) {
  ctx_refresh = ctx.refresh;
  let banners = ctx.takeFlash();
  const load = () => loadInto(body, async () => ({ jobs: await api("/admin/jobs?state=waiting_approval&limit=100"), proposals: await api("/admin/proposals?state=pending"), labels: await keyLabels().catch(() => new Map()) }), ({ jobs, proposals, labels }) => {
    const sub = jobs.length || proposals.length ? [jobs.length ? `${plural(jobs.length, "parcel")} ${jobs.length === 1 ? "is" : "are"} holding at the counter until you say so.` : "", proposals.length ? `${plural(proposals.length, "contract change")} ${proposals.length === 1 ? "is" : "are"} waiting for your answer.` : ""].filter(Boolean).join(" ") : "The counter is clear.";
    body.append(pageHead("Approvals", sub));
    if (banners) { body.append(banner(banners.kind, h("span", null, h("b", null, banners.title || "Decision recorded."), " ", banners.text))); banners = null; }
    for (const p of proposals) body.append(proposalCard(p, async (verdict, btn) => {
      btn.disabled = true;
      try {
        await api(`/admin/proposals/${enc(p.id)}/${verdict}`, { method: "POST" });
        banners = { kind: "", text: verdict === "apply" ? `The contract ${p.contract_name || p.contract_id} was changed.` : "The proposal was declined; the contract is unchanged." };
      } catch (e) { banners = { kind: "err", title: "Not recorded.", text: e.status === 409 ? (e.data && e.data.message) || `${p.id} is no longer waiting.` : e.message }; }
      ctx_refresh(); mount(body); load();
    }));
    if (!jobs.length && !proposals.length) { body.append(emptyState("Nothing waiting for you", "When a contract needs your say-so, the parcel holds here.", h("a", { class: "btn", href: "#/parcels" }, "See all parcels"))); return; }
    for (const j of [...jobs].reverse()) {
      const d = describeJob(j);
      const act = async (verdict, btn) => {
        btn.disabled = true;
        try {
          await decide(j.id, verdict);
          banners = { kind: "", text: verdict === "approve" ? "The client has been told and the parcel is on its way." : "The parcel was refused and the client has been told." };
        } catch (e) { banners = { kind: "err", title: "Not recorded.", text: e.status === 409 ? `${j.id} is no longer waiting.` : e.message }; }
        mount(body); load();
      };
      body.append(h("div", { class: "card" }, h("div", { class: "ask" },
        h("div", { style: "flex:1;min-width:0" },
          h("span", { class: "mono" }, j.id), " ", tag(j.task),
          h("div", { class: "what", style: "margin:6px 0 0" }, `${labels.get(j.key_id) || j.key_id} wants to ${d.verb} `, h("span", { class: "mono" }, d.target)),
          h("div", { class: "f" }, `asked ${hhmm(j.created_at)}${d.meta ? " · " + d.meta : ""}`),
          h("div", { class: "diff mono" }, d.change)),
        h("div", { class: "btns", style: "white-space:nowrap;align-self:flex-start" },
          h("button", { class: "btn p", type: "button", onclick: (e) => act("approve", e.currentTarget) }, "Approve"),
          h("a", { class: "btn", href: "#/approvals/" + enc(j.id) }, "Review"),
          h("button", { class: "btn", type: "button", onclick: (e) => act("decline", e.currentTarget) }, "Decline")))));
    }
  });
  load();
}

function detail(body, id, ctx) {
  ctx_refresh = ctx.refresh;
  loadInto(body, async () => ({ job: await api("/admin/jobs/" + enc(id)), labels: await keyLabels().catch(() => new Map()) }), ({ job, labels }) => {
    const d = describeJob(job);
    const who = (job.key && job.key.label) || labels.get(job.key_id) || job.key_id;
    const waiting = job.state === "waiting_approval";
    const a = job.args || {};
    const msg = h("div", { "aria-live": "polite" });
    const go = async (verdict, btns) => {
      btns.forEach((b) => (b.disabled = true));
      try {
        await decide(job.id, verdict);
        ctx.flash("", verdict === "approve" ? "The client has been told and the parcel is on its way." : "The parcel was refused and the client has been told.");
        ctx.go("#/approvals");
      } catch (e) { btns.forEach((b) => (b.disabled = false)); mount(msg, banner("err", e.status === 409 ? "This parcel is no longer waiting." : e.message)); }
    };
    const approve = h("button", { class: "btn p", type: "button" }, "Approve");
    const decline = h("button", { class: "btn", type: "button" }, "Decline");
    approve.onclick = () => go("approve", [approve, decline]);
    decline.onclick = () => go("decline", [approve, decline]);
    body.append(
      h("a", { class: "back", href: "#/approvals" }, "← All approvals"),
      h("h1", null, h("span", { class: "mono", style: "font-size:24px" }, job.id), " ", tag(waiting ? "waiting approval" : job.state, waiting ? "wa" : "")),
      h("p", { class: "sub" }, `From ${who} at ${hhmm(job.created_at)}. ${waiting ? "Nothing has run yet." : "This one is no longer waiting."}`),
      msg,
      h("div", { class: "row" },
        h("div", { class: "card f13" }, h("div", { class: "ch" }, h("h2", null, "What it will do")), h("div", { class: "cb" },
          kv("Task", job.task),
          a.path ? kv("Path", h("span", { class: "mono" }, a.path)) : null,
          a.cwd ? kv("Folder", h("span", { class: "mono" }, a.cwd)) : null,
          kv("Effect", job.task === "write_file" ? `Writes ${plural(bytes(a.content), "byte")}` : job.task === "claude" ? "Runs claude on your laptop" : job.task === "read_file" ? "Reads a file" : "Echoes text back"),
          h("div", { class: "res" }, typeof a.content === "string" ? a.content : typeof a.prompt === "string" ? a.prompt : JSON.stringify(a, null, 2)))),
        h("div", { class: "card f1" }, h("div", { class: "ch" }, h("h2", null, "Why you are being asked")), h("div", { class: "cb" },
          h("p", { style: "margin:0 0 16px" }, "Contract ", h("a", { href: "#/contracts/" + enc(job.contract_id), style: "text-decoration:underline" }, (job.contract && job.contract.name) || job.contract_id), ` says ${job.task} needs your approval. `, (job.contract_check || {}).verdict === "approve" ? "The folder check passed." : ""),
          waiting ? h("div", { class: "btns" }, approve, decline) : h("a", { class: "btn", href: "#/approvals" }, "Back to approvals")))));
  });
}

// A contract change someone asked for. Plain-words changes, widening ones in amber; nothing has changed until Apply.
function proposalCard(p, act) {
  return h("div", { class: "card proposal", "data-proposal": p.id }, h("div", { class: "ask" },
    h("div", { style: "flex:1;min-width:0" },
      h("span", { class: "mono" }, p.id), " ", tag("contract change"), p.widening ? [" ", tag("widens", "wa")] : null,
      h("div", { class: "what", style: "margin:6px 0 0" }, "Change contract ", h("a", { href: "#/contracts/" + enc(p.contract_id), style: "text-decoration:underline" }, p.contract_name || p.contract_id)),
      h("div", { class: "f" }, `asked ${hhmm(p.created_at)}${p.note ? " · " + p.note : ""}`),
      h("ul", { class: "diff", style: "margin:8px 0 0;padding-left:18px" }, p.changes.map((c) => h("li", null, c.text, c.widening ? [" ", tag("widens", "wa")] : null))),
      h("div", { class: "f", style: "margin-top:6px" }, "Nothing has changed yet.")),
    h("div", { class: "btns", style: "white-space:nowrap;align-self:flex-start" },
      h("button", { class: "btn p", type: "button", onclick: (e) => act("apply", e.currentTarget) }, "Apply"),
      h("button", { class: "btn", type: "button", onclick: (e) => act("decline", e.currentTarget) }, "Decline"))));
}
