// The record code (src/records/follows.mjs) against a chain in memory that
// admits a write the way consensus would: every old value must be what the
// key holds, and the built policy must accept the body.
//
//   (cd policy && cargo build --release --target wasm32-unknown-unknown)
//   node --test test/
import assert from "node:assert/strict";
import { test } from "node:test";
import * as sdk from "../vendor/lattice-sdk.js";
import * as records from "../src/records/follows.mjs";
import { transaction } from "../src/records/wallet.mjs";
import { context, validate } from "./host.mjs";

const PATH = ["Nexus", "follows"];
const address = (seed) => sdk.addressFromPublicKey(sdk.publicKeyFromPrivate(new Uint8Array(32).fill(seed)));
const [ALICE, BOB, CAROL] = [address(1), address(2), address(3)];

function chain() {
  const map = new Map();
  const state = {
    get: async (key) => map.get(key),
    async *list(prefix) {
      for (const key of [...map.keys()].sort()) if (key.startsWith(prefix)) yield [key, map.get(key)];
    },
  };
  function submit(owner, { actions }) {
    const body = transaction({ owner, actions, fee: 0n, nonce: 0n, chainPath: PATH });
    for (const { key, oldValue } of actions) if (map.get(key) !== oldValue) return false;
    if (!validate(context(sdk.encodeTransactionBody(body).bytes, { path: PATH }))) return false;
    for (const { key, newValue } of actions) {
      if (newValue === undefined) map.delete(key);
      else map.set(key, newValue);
    }
    return true;
  }
  return { state, submit, map };
}

test("follows are read from both ends", async () => {
  const { state, submit } = chain();
  assert.ok(submit(ALICE, await records.follow(state, ALICE, "bob")));
  assert.ok(submit(ALICE, await records.follow(state, ALICE, "@carol")));
  assert.ok(submit(CAROL, await records.follow(state, CAROL, "bob")));
  assert.deepEqual(await records.following(state, ALICE), ["@bob", "@carol"]);
  assert.deepEqual(await records.followers(state, "bob"), [ALICE, CAROL].sort());
  assert.deepEqual(await records.followers(state, "@carol"), [ALICE]);
  assert.deepEqual(await records.followers(state, "alice"), []);
  assert.ok(await records.follows(state, ALICE, "@bob"));
  assert.ok(!(await records.follows(state, BOB, "alice")));
});

test("an account follows another account, and both kinds read back as stored", async () => {
  const { state, submit, map } = chain();
  assert.ok(submit(ALICE, await records.follow(state, ALICE, BOB)));
  assert.ok(submit(ALICE, await records.follow(state, ALICE, "bob")));
  assert.ok(submit(CAROL, await records.follow(state, CAROL, BOB)));
  assert.ok(map.has(`followers/${BOB}/${ALICE}`) && map.has(`followers/@bob/${ALICE}`));
  // Names sort first: "@" comes before every letter.
  assert.deepEqual(await records.following(state, ALICE), ["@bob", BOB]);
  assert.deepEqual(await records.followers(state, BOB), [ALICE, CAROL].sort());
  assert.deepEqual(await records.followers(state, "@bob"), [ALICE]);
  assert.ok(await records.follows(state, CAROL, BOB));
  assert.ok(!(await records.follows(state, CAROL, "bob")));
  assert.ok(submit(ALICE, await records.unfollow(state, ALICE, BOB)));
  assert.deepEqual(await records.following(state, ALICE), ["@bob"]);
});

test("unfollow deletes both keys; repeats write nothing", async () => {
  const { state, submit, map } = chain();
  assert.ok(submit(ALICE, await records.follow(state, ALICE, "bob")));
  assert.deepEqual([...map.keys()].sort(), [`followers/@bob/${ALICE}`, `user/${ALICE}/follows/@bob`]);
  assert.deepEqual(await records.follow(state, ALICE, "@bob"), { actions: [] });
  assert.ok(submit(ALICE, await records.unfollow(state, ALICE, "bob")));
  assert.deepEqual(await records.following(state, ALICE), []);
  assert.equal(map.size, 0);
  assert.deepEqual(await records.followers(state, "bob"), []);
  assert.deepEqual(await records.unfollow(state, ALICE, "bob"), { actions: [] });
});

test("a follow is the follower's alone", async () => {
  const { state, submit } = chain();
  // Bob signs a write that would make Alice follow his name.
  assert.ok(!submit(BOB, await records.follow(state, ALICE, "bob")));
  assert.ok(submit(ALICE, await records.follow(state, ALICE, "bob")));
  assert.ok(!submit(BOB, await records.unfollow(state, ALICE, "bob")));
  assert.deepEqual(await records.followers(state, "bob"), [ALICE]);
});

test("only an account or a name is followed", async () => {
  for (const neither of ["Bob", "@", "bob smith", BOB.toUpperCase(), `@${BOB}`.toUpperCase(), ""]) {
    await assert.rejects(records.follow(chain().state, ALICE, neither), /not an account or a name/, neither);
  }
  assert.throws(() => records.followKey(ALICE, "@@bob"), /not an account or a name/);
  // An address is an account even though its letters would make a handle; "@" makes it a name.
  assert.equal(records.target(BOB), BOB);
  assert.equal(records.target(`@${BOB}`), `@${BOB}`);
  assert.equal(records.target("bob"), "@bob");
});
