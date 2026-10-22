import assert from "node:assert/strict";
import { test } from "node:test";
import { count, labelOf, matches, parseWho, pathOf } from "../app/lib.mjs";

const ADDRESS = "bafyreibc6ggvvnkjlyjghue3qxnagcoprbsh725cutnnnkt3t6dambbt6a";

test("the search box takes a handle, with or without @, in any case, or an account", () => {
  assert.deepEqual(parseWho("@ada_1"), { handle: "ada_1" });
  assert.deepEqual(parseWho("  Ada "), { handle: "ada" });
  assert.deepEqual(parseWho("@ABCDEFGHIJ234567"), { handle: "abcdefghij234567" });
  assert.deepEqual(parseWho(ADDRESS), { account: ADDRESS });
  assert.deepEqual(parseWho(`@${ADDRESS}`), { handle: ADDRESS });
  assert.equal(parseWho(""), null);
  assert.equal(parseWho("ada lovelace"), null);
  assert.equal(parseWho("@"), null);
  assert.equal(parseWho("@@ada"), null);
});

test("a person shows by handle, else by their account's tail", () => {
  assert.equal(labelOf({ account: ADDRESS, handle: "ada" }), "@ada");
  assert.equal(labelOf({ account: ADDRESS }), "…bt6a");
  assert.equal(pathOf({ handle: "ada" }), "@ada");
  assert.equal(pathOf({ account: ADDRESS }), ADDRESS);
});

test("a filter matches part of a handle or account, ignoring case and @", () => {
  assert.ok(matches({ handle: "ada" }, ""));
  assert.ok(matches({ handle: "ada_lovelace" }, "love"));
  assert.ok(matches({ handle: "ada" }, "@AD"));
  assert.ok(!matches({ handle: "ada" }, "grace"));
  assert.ok(matches({ account: ADDRESS }, "bt6a"));
  assert.ok(!matches({ account: ADDRESS }, "zzz"));
});

test("counts read naturally", () => {
  assert.equal(count(1, "follower"), "1 follower");
  assert.equal(count(1204, "follower"), "1,204 followers");
  assert.equal(count(1, "following", "following"), "1 following");
});
