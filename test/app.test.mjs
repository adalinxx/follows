import assert from "node:assert/strict";
import { test } from "node:test";
import { count, label, matches, parseWho, shortID } from "../app/lib.mjs";

const address = "bafyreibc6ggvvnkjlyjghue3qxnagcoprbsh725cutnnnkt3t6dambbt6a";

test("the search box takes a handle, with or without @, or an address", () => {
  assert.deepEqual(parseWho("@ada_1"), { handle: "ada_1" });
  assert.deepEqual(parseWho("  Ada "), { handle: "ada" });
  assert.deepEqual(parseWho(address), { address });
  assert.equal(parseWho(""), null);
  assert.equal(parseWho("ada lovelace"), null);
  assert.equal(parseWho("@"), null);
});

test("a filter matches name, handle or address, ignoring case and @", () => {
  const ada = { address, name: "Ada Lovelace", handle: "ada" };
  assert.ok(matches(ada, ""));
  assert.ok(matches(ada, "love"));
  assert.ok(matches(ada, "@AD"));
  assert.ok(matches(ada, "dambbt6a"));
  assert.ok(!matches(ada, "grace"));
  assert.ok(matches({ address }, "bafyrei"));
  assert.ok(!matches({ address }, "ada"));
});

test("people are labeled by what they show", () => {
  assert.equal(label({ address, name: "Ada", handle: "ada" }), "Ada");
  assert.equal(label({ address, handle: "ada" }), "@ada");
  assert.equal(label({ address }), "Account …dambbt6a");
});

test("counts read naturally", () => {
  assert.equal(count(1, "follower"), "1 follower");
  assert.equal(count(1204, "follower"), "1,204 followers");
  assert.equal(count(1, "following", "following"), "1 following");
});

test("an account ID is shown by its end, which tells accounts apart", () => {
  assert.equal(shortID(address), "…dambbt6a");
});
