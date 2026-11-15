import test from "node:test";
import assert from "node:assert/strict";
import { buildPlist, servicePath, LABEL } from "../daemon/service.ts";

test("the plist runs the daemon with the user's bin dirs on PATH and holds no secret", () => {
  const xml = buildPlist({ program: ["/n/bin/node", "/r/daemon/cli.ts", "run"], home: "/Users/x" });
  assert.match(xml, new RegExp(`<key>Label</key><string>${LABEL}</string>`));
  assert.match(xml, /<string>\/n\/bin\/node<\/string>\s*<string>\/r\/daemon\/cli\.ts<\/string>\s*<string>run<\/string>/);
  assert.match(xml, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(xml, /<key>KeepAlive<\/key><true\/>/);
  assert.match(xml, /<key>ThrottleInterval<\/key><integer>30<\/integer>/);
  assert.match(xml, /\/Users\/x\/\.local\/bin/); // so the claude task finds `claude`
  assert.match(xml, /\/Users\/x\/Library\/Logs\/mailroom-daemon\.log/);
  assert.doesNotMatch(xml, /mrd_|credential/i);
});

test("paths are XML-escaped and PATH has no duplicates", () => {
  const xml = buildPlist({ program: ["/n/node", "/a&b/<c>/cli.ts", "run"], home: "/Users/x" });
  assert.match(xml, /\/a&amp;b\/&lt;c&gt;\/cli\.ts/);
  const p = servicePath("/usr/bin/node", "/Users/x").split(":");
  assert.equal(new Set(p).size, p.length);
});
