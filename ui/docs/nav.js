// The docs map. Order here is the sidebar order and the previous/next order.
// Each page lives in ui/docs/<slug>.html and is served at /docs/<slug> (index at /docs/).
export const NAV = [
  { group: "Start here", pages: [
    { slug: "", title: "Welcome", summary: "What the Mailroom is, in one page." },
    { slug: "concepts", title: "The big picture", summary: "The mailroom idea and the few words you need." },
    { slug: "quickstart", title: "Set it up in 10 minutes", summary: "Run it, connect your laptop, send a first parcel." },
  ] },
  { group: "How it works", pages: [
    { slug: "how-it-works", title: "How a parcel travels", summary: "The parts, and one parcel's journey end to end." },
    { slug: "keys-contracts", title: "Keys and contracts", summary: "Who may send what, and how a parcel is checked." },
    { slug: "parcels", title: "Parcels and approvals", summary: "The life of a parcel, and when it waits for you." },
    { slug: "laptop", title: "The laptop and the daemon", summary: "How your Mac does the work, and stays safe." },
  ] },
  { group: "Using it", pages: [
    { slug: "admin-ui", title: "The admin app", summary: "A tour of every page." },
    { slug: "extension", title: "The browser extension", summary: "See what needs you, from your toolbar." },
    { slug: "mcp", title: "Claude and other apps (MCP)", summary: "Tokens, scopes and the plugin." },
  ] },
  { group: "Reference", pages: [
    { slug: "security", title: "Security model", summary: "What protects what, and the honest limits." },
    { slug: "cli", title: "The mailroom command", summary: "Every command and what it does." },
    { slug: "api", title: "HTTP API", summary: "Routes for clients, the owner and the daemon." },
    { slug: "events", title: "Events", summary: "The log of everything that happens." },
    { slug: "troubleshooting", title: "Troubleshooting", summary: "When something looks wrong." },
    { slug: "glossary", title: "Glossary", summary: "Every word, in plain language." },
  ] },
];
export const FLAT = NAV.flatMap(g => g.pages.map(p => ({ ...p, group: g.group })));
export const href = slug => (slug ? `/docs/${slug}` : "/docs/");
