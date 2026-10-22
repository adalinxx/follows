import assert from "node:assert/strict";
import { test } from "node:test";
import { count, matches, parseWho } from "../app/lib.mjs";

const id = "abcdefghij234567";

test("the search box takes a handle, with or without @, or a profile id", () => {
  assert.deepEqual(parseWho("@ada_1"), { handle: "ada_1" });
  assert.deepEqual(parseWho("  Ada "), { handle: "ada" });
  assert.deepEqual(parseWho(id), { id });
  assert.deepEqual(parseWho(`@${id}`), { handle: id });
  assert.equal(parseWho(""), null);
  assert.equal(parseWho("ada lovelace"), null);
  assert.equal(parseWho("@"), null);
});

test("a filter matches name, handle or profile id, ignoring case and @", () => {
  const ada = { id, name: "Ada Lovelace", handle: "ada" };
  assert.ok(matches(ada, ""));
  assert.ok(matches(ada, "love"));
  assert.ok(matches(ada, "@AD"));
  assert.ok(matches(ada, "j2345"));
  assert.ok(!matches(ada, "grace"));
  assert.ok(matches({ id }, "abcdef"));
  assert.ok(!matches({ id }, "ada"));
});

test("counts read naturally", () => {
  assert.equal(count(1, "follower"), "1 follower");
  assert.equal(count(1204, "follower"), "1,204 followers");
  assert.equal(count(1, "following", "following"), "1 following");
});
