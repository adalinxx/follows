import assert from "node:assert/strict";
import { test } from "node:test";
import { count, matches, parseWho } from "../app/lib.mjs";

test("the search box takes a handle, with or without @, in any case", () => {
  assert.deepEqual(parseWho("@ada_1"), { handle: "ada_1" });
  assert.deepEqual(parseWho("  Ada "), { handle: "ada" });
  assert.deepEqual(parseWho("@ABCDEFGHIJ234567"), { handle: "abcdefghij234567" });
  assert.equal(parseWho(""), null);
  assert.equal(parseWho("ada lovelace"), null);
  assert.equal(parseWho("@"), null);
  assert.equal(parseWho("@@ada"), null);
});

test("a filter matches part of a handle, ignoring case and @", () => {
  assert.ok(matches("ada", ""));
  assert.ok(matches("ada_lovelace", "love"));
  assert.ok(matches("ada", "@AD"));
  assert.ok(!matches("ada", "grace"));
});

test("counts read naturally", () => {
  assert.equal(count(1, "follower"), "1 follower");
  assert.equal(count(1204, "follower"), "1,204 followers");
  assert.equal(count(1, "following", "following"), "1 following");
});
