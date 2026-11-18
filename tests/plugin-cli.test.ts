import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pluginCommands, repoRoot } from "../daemon/plugin.ts";

test("install adds the marketplace from this repo, then installs the plugin, at the chosen scope", () => {
  assert.deepEqual(pluginCommands("install", "project", "/r"), [
    ["plugin", "marketplace", "add", "/r", "--scope", "project"],
    ["plugin", "install", "the-mailroom@the-mailroom", "--scope", "project"],
  ]);
  assert.deepEqual(pluginCommands("uninstall", "user", "/r"), [["plugin", "uninstall", "the-mailroom@the-mailroom", "--scope", "user"]]);
});

test("the repo ships the marketplace the CLI points at", () => {
  const m = JSON.parse(fs.readFileSync(path.join(repoRoot(), ".claude-plugin/marketplace.json"), "utf8"));
  assert.equal(m.name, "the-mailroom");
  assert.equal(m.plugins[0].name, "the-mailroom");
  assert.ok(fs.existsSync(path.join(repoRoot(), m.plugins[0].source, ".claude-plugin/plugin.json")));
});
