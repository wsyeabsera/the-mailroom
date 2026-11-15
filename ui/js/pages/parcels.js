import { h, mount, enc } from "../dom.js";
import { api, keyLabels } from "../api.js";
import { banner, pageHead, loadInto, tag, stateTag, kv, emptyState } from "../components.js";
import { hhmm, hhmmss, stateLabel } from "../format.js";

export function render(view, params, ctx) {
  const body = h("div");
  mount(view, body);
  return params[0] ? detail(body, params[0], ctx) : list(body);
}

const TABS = [["all", "All"], ["waiting_approval", "Waiting for you"], ["queued", "Queued"], ["running", "Running"], ["done", "Done"], ["refused", "Refused"], ["failed", "Failed"]];

function list(body) {
  let filter = "all";
  const load = () => loadInto(body, async () => ({ jobs: await api("/admin/jobs?limit=200"), labels: await keyLabels().catch(() => new Map()) }), ({ jobs, labels }) => {
    const head = pageHead("Parcels", "Every job a client has sent, newest first.");
    const tabs = h("div", { class: "tabs", role: "group", "aria-label": "Filter by state" });
    const results = h("div");
    const count = (k) => (k === "all" ? jobs.length : jobs.filter((j) => j.state === k).length);
    const draw = () => {
      mount(tabs, TABS.filter(([k]) => k === "all" || k === filter || count(k) > 0 || k === "waiting_approval" || k === "refused").map(([k, label]) =>
        h("button", { type: "button", "aria-pressed": String(filter === k), onclick: () => { filter = k; draw(); } }, `${label} · ${count(k)}`)));
      const rows = filter === "all" ? jobs : jobs.filter((j) => j.state === filter);
      mount(results, !jobs.length
        ? emptyState("No parcels yet", "Nobody has knocked. Hand out a key and the first parcel shows up here.", h("a", { class: "btn", href: "#/keys/new" }, "Hand out a key"))
        : !rows.length ? emptyState("Nothing here", "No parcels in this state.")
        : h("div", { class: "card tblwrap" }, h("table", null,
          h("thead", null, h("tr", null, ["Parcel", "Task", "Key", "State"].map((t) => h("th", null, t)), h("th", { class: "r" }, "Sent"))),
          h("tbody", null, rows.map((j) => h("tr", { class: "go", onclick: (e) => { if (!e.target.closest("a")) location.hash = "#/parcels/" + enc(j.id); } },
            h("td", null, h("a", { class: "mono", href: "#/parcels/" + enc(j.id) }, j.id)), h("td", null, j.task),
            h("td", { class: "m" }, labels.get(j.key_id) || j.key_id), h("td", null, stateTag(j.state)), h("td", { class: "f tn r" }, hhmm(j.created_at))))))));
    };
    body.append(head, tabs, results);
    draw();
  });
  load();
}

function timeline(job, check) {
  const items = [["", "Received", `${hhmmss(job.created_at)} · gateway`]];
  for (const e of job.timeline || []) {
    const p = e.payload || {};
    const t = hhmmss(e.ts);
    switch (e.kind) {
      case "job.queued": items.push(["", "Contract check passed", `${t} · ${job.task} allowed`]); break;
      case "job.waiting_approval": items.push(["wait", "Waiting for your approval", `${t} · nothing has run yet`]); break;
      case "job.refused": items.push(["bad", "Contract check failed", `${t} · ${p.reason || job.reason || "refused"}`], ["bad", "Refused", `${t} · nothing reached the laptop`]); break;
      case "job.approved": items.push(["", "Approved", `${t} · by you`]); break;
      case "job.declined": items.push(["bad", "Declined", `${t} · by you`]); break;
      case "job.running": items.push(["", "Delivered to laptop", t]); break;
      case "job.done": items.push(["", "Done", t]); break;
      case "job.failed": items.push(["bad", "Failed", `${t} · ${p.reason || job.reason || ""}`]); break;
      case "job.cancelled": items.push(["bad", "Cancelled", `${t} · its key was revoked`]); break;
      default: break;
    }
  }
  return h("div", { class: "tl" }, items.map(([cls, title, sub]) => h("div", { class: cls }, h("b", null, title), h("div", { class: "f" }, sub))));
}

function detail(body, id, ctx) {
  loadInto(body, async () => {
    const job = await api("/admin/jobs/" + enc(id));
    const contract = await api("/admin/contracts/" + enc(job.contract_id)).catch(() => null);
    return { job, contract };
  }, ({ job, contract }) => {
    const check = job.contract_check || {};
    const key = job.key || {};
    const asked = job.args && (job.args.path || job.args.cwd);
    body.append(
      h("a", { class: "back", href: "#/parcels" }, "← All parcels"),
      h("h1", null, h("span", { class: "mono", style: "font-size:24px" }, job.id), " ", stateTag(job.state)),
      h("p", { class: "sub" }, `${job.task} · sent ${hhmm(job.created_at)} by `, h("a", { href: "#/keys/" + enc(key.id || job.key_id), style: "text-decoration:underline" }, key.label || job.key_id)));
    const right = h("div", { class: "f1" });
    if (job.state === "refused") {
      const allowed = contract && contract.folders ? contract.folders : [];
      const declined = job.reason === "declined by owner";
      right.append(h("div", { class: "card", style: "flex:1.2" },
        h("div", { class: "ch" }, h("h2", null, declined ? "Why it was declined" : "Why it was refused")),
        h("div", { class: "cb" },
          tag(declined ? "declined" : /folder|outside|path/i.test(job.reason || "") ? "outside contract" : "refused", "er"),
          h("p", { class: "m" }, job.reason || "No reason recorded."),
          asked && !declined ? h("div", { class: "cmp" },
            h("div", null, h("span", { class: "f" }, `Asked to ${job.task === "write_file" ? "write" : job.task === "read_file" ? "read" : "use"}`), h("br"), h("span", { class: "mono" }, String(asked))),
            h("div", null, h("span", { class: "f" }, `Contract “${contract ? contract.name : job.contract_id}” allows`), h("br"),
              allowed.length ? allowed.map((f) => h("div", { class: "mono" }, f)) : h("span", { class: "mono" }, "nothing listed"))) : null,
          h("div", { class: "btns" },
            declined ? null : h("a", { class: "btn p", href: "#/contracts/" + enc(job.contract_id) }, "Widen the contract"),
            h("a", { class: "btn", href: "#/parcels" }, declined ? "Back to parcels" : "Leave it refused")))));
    } else {
      right.append(h("div", { class: "card" },
        h("div", { class: "ch" }, h("h2", null, "Contract check")),
        h("div", { class: "cb" }, tag(check.verdict === "refuse" ? "failed" : check.verdict === "approve" ? "needs approval" : "passed", check.verdict === "refuse" ? "er" : check.verdict === "approve" ? "wa" : "ok"),
          h("p", { class: "m", style: "margin:8px 0 0" }, check.reason || `Contract “${contract ? contract.name : job.contract_id}” allows ${job.task}.`))));
      if (job.state === "waiting_approval") right.append(h("div", { class: "card" }, h("div", { class: "cb" }, h("a", { class: "btn p", href: "#/approvals/" + enc(job.id) }, "Review and decide"))));
      if (job.result !== undefined && job.result !== null) right.append(h("div", { class: "card" }, h("div", { class: "ch" }, h("h2", null, "Result")), h("div", { class: "cb" }, h("div", { class: "res", style: "margin-top:0" }, JSON.stringify(job.result, null, 2)))));
      if (job.state === "failed") right.append(h("div", { class: "card" }, h("div", { class: "ch" }, h("h2", null, "Error")), h("div", { class: "cb" }, h("div", { class: "res", style: "margin-top:0" }, job.reason || "No reason recorded."))));
    }
    right.append(h("div", { class: "card" }, h("div", { class: "ch" }, h("h2", null, "What was asked")), h("div", { class: "cb" }, h("div", { class: "res", style: "margin-top:0" }, JSON.stringify(job.args, null, 2)))));
    body.append(h("div", { class: "row" }, h("div", { class: "card f1" }, h("div", { class: "ch" }, h("h2", null, "Tracking")), h("div", { class: "cb" }, timeline(job, check))), right));
  });
}
