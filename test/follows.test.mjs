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
  return { state, submit };
}

test("follows are read from both ends", async () => {
  const { state, submit } = chain();
  assert.ok(submit(ALICE, await records.follow(state, ALICE, BOB)));
  assert.ok(submit(ALICE, await records.follow(state, ALICE, CAROL)));
  assert.ok(submit(CAROL, await records.follow(state, CAROL, BOB)));
  assert.deepEqual(await records.following(state, ALICE), [BOB, CAROL].sort());
  assert.deepEqual(await records.followers(state, BOB), [ALICE, CAROL].sort());
  assert.deepEqual(await records.followers(state, CAROL), [ALICE]);
  assert.deepEqual(await records.followers(state, ALICE), []);
  assert.ok(await records.follows(state, ALICE, BOB));
  assert.ok(!(await records.follows(state, BOB, ALICE)));
});

test("unfollow deletes the record; repeats write nothing", async () => {
  const { state, submit } = chain();
  assert.ok(submit(ALICE, await records.follow(state, ALICE, BOB)));
  assert.deepEqual(await records.follow(state, ALICE, BOB), { actions: [] });
  assert.ok(submit(ALICE, await records.unfollow(state, ALICE, BOB)));
  assert.deepEqual(await records.following(state, ALICE), []);
  assert.deepEqual(await records.followers(state, BOB), []);
  assert.deepEqual(await records.unfollow(state, ALICE, BOB), { actions: [] });
});

test("a follow is the follower's alone", async () => {
  const { state, submit } = chain();
  // Bob signs a write that would make Alice follow him.
  assert.ok(!submit(BOB, await records.follow(state, ALICE, BOB)));
  assert.ok(submit(ALICE, await records.follow(state, ALICE, BOB)));
  assert.ok(!submit(BOB, await records.unfollow(state, ALICE, BOB)));
  assert.deepEqual(await records.followers(state, BOB), [ALICE]);
});

test("only an address is followed", async () => {
  await assert.rejects(records.follow(chain().state, ALICE, "@bob"), /not an address/);
});
