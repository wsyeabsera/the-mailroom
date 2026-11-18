import test from "node:test";
import assert from "node:assert/strict";
import { cancelAction } from "../shared/cancel.ts";

test("cancelAction by state", () => {
  assert.equal(cancelAction("queued"), "drop");
  assert.equal(cancelAction("waiting_approval"), "drop");
  assert.equal(cancelAction("running"), "stop");
  for (const s of ["done", "failed", "refused", "expired", "cancelled"]) assert.equal(cancelAction(s), "conflict");
});
