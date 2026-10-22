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

/** Who owns each handle, as Moniker would say. Change it to sell a handle. */
function moniker() {
  const owner = new Map([["ada", ALICE], ["ada_2", ALICE], ["bob", BOB], ["cara", CAROL]]);
  return { owner, owners: async (handles) => handles.map((h) => owner.get(h)) };
}

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
  const { owners } = moniker();
  assert.ok(submit(ALICE, await records.follow(state, ALICE, "ada", "bob")));
  assert.ok(submit(ALICE, await records.follow(state, ALICE, "ada", "cara")));
  assert.ok(submit(CAROL, await records.follow(state, CAROL, "cara", "bob")));
  assert.deepEqual(await records.following(state, "ada", owners), ["bob", "cara"]);
  assert.deepEqual(await records.followers(state, "bob", owners), ["ada", "cara"]);
  assert.deepEqual(await records.followers(state, "cara", owners), ["ada"]);
  assert.deepEqual(await records.followers(state, "ada", owners), []);
  assert.ok(await records.follows(state, "ada", "bob", owners));
  assert.ok(!(await records.follows(state, "bob", "ada", owners)));
});

test("an account with two handles follows as each, separately", async () => {
  const { state, submit } = chain();
  const { owners } = moniker();
  assert.ok(submit(ALICE, await records.follow(state, ALICE, "ada_2", "bob")));
  assert.deepEqual(await records.followers(state, "bob", owners), ["ada_2"]);
  assert.ok(!(await records.follows(state, "ada", "bob", owners)));
});

test("a follow lapses when its handle is sold, and the handle's followers stay", async () => {
  const { state, submit } = chain();
  const { owner, owners } = moniker();
  assert.ok(submit(ALICE, await records.follow(state, ALICE, "ada", "bob")));
  assert.ok(submit(CAROL, await records.follow(state, CAROL, "cara", "ada")));
  owner.set("ada", BOB); // Alice sold @ada to Bob
  assert.ok(!(await records.follows(state, "ada", "bob", owners)));
  assert.deepEqual(await records.following(state, "ada", owners), []);
  assert.deepEqual(await records.followers(state, "bob", owners), []);
  // Who followed @ada still does: a follow is of the handle, whoever owns it.
  assert.deepEqual(await records.followers(state, "ada", owners), ["cara"]);
  // The new owner starts fresh, with keys of its own.
  assert.ok(submit(BOB, await records.follow(state, BOB, "ada", "cara")));
  assert.deepEqual(await records.following(state, "ada", owners), ["cara"]);
  // Bought back, Alice's old follow counts again: it is still hers.
  owner.set("ada", ALICE);
  assert.deepEqual(await records.following(state, "ada", owners), ["bob"]);
});

test("a handle no one owns follows no one", async () => {
  const { state, submit } = chain();
  const { owner, owners } = moniker();
  assert.ok(submit(ALICE, await records.follow(state, ALICE, "ada", "bob")));
  owner.delete("ada"); // released
  assert.deepEqual(await records.followers(state, "bob", owners), []);
  assert.ok(!(await records.follows(state, "ada", "bob", owners)));
});

test("unfollow deletes both of the account's keys; repeats write nothing", async () => {
  const { state, submit, map } = chain();
  const { owners } = moniker();
  assert.ok(submit(ALICE, await records.follow(state, ALICE, "ada", "bob")));
  assert.deepEqual([...map.keys()].sort(), [`followers/bob/ada/${ALICE}`, `follows/ada/bob/${ALICE}`]);
  assert.deepEqual(await records.follow(state, ALICE, "ada", "bob"), { actions: [] });
  assert.ok(submit(ALICE, await records.unfollow(state, ALICE, "ada", "bob")));
  assert.deepEqual(await records.following(state, "ada", owners), []);
  assert.equal(map.size, 0);
  assert.deepEqual(await records.unfollow(state, ALICE, "ada", "bob"), { actions: [] });
});

test("an account's keys are its own", async () => {
  const { state, submit } = chain();
  const { owners } = moniker();
  // Bob signs a write of Alice's keys.
  assert.ok(!submit(BOB, await records.follow(state, ALICE, "ada", "bob")));
  assert.ok(submit(ALICE, await records.follow(state, ALICE, "ada", "bob")));
  assert.ok(!submit(BOB, await records.unfollow(state, ALICE, "ada", "bob")));
  assert.deepEqual(await records.followers(state, "bob", owners), ["ada"]);
  // Keys Bob writes as a handle he doesn't own are kept by the chain, and counted by no reader.
  assert.ok(submit(BOB, await records.follow(state, BOB, "cara", "bob")));
  assert.deepEqual(await records.followers(state, "bob", owners), ["ada"]);
});

test("only handles follow handles", async () => {
  for (const neither of ["Bob", "@bob", "bo b", "bob/x", BOB.slice(0, 7).toUpperCase(), ""]) {
    await assert.rejects(records.follow(chain().state, ALICE, "ada", neither), /not a handle/, neither);
    await assert.rejects(records.follow(chain().state, ALICE, neither, "ada"), /not a handle/, neither);
  }
  assert.ok(records.isHandle("ada_2"));
  assert.ok(!records.isHandle("@ada"));
});

test("a follow or unfollow waiting for a block is found in transaction bodies", () => {
  const follow = { signers: [ALICE], actions: [{ key: records.followKey("ada", "bob", ALICE), newValue: "1" }, { key: records.followerKey("ada", "bob", ALICE), newValue: "1" }] };
  const unfollow = { signers: [ALICE], actions: [{ key: records.followKey("ada_2", "cara", ALICE), oldValue: "1" }, { key: records.followerKey("ada_2", "cara", ALICE), oldValue: "1" }] };
  const others = { signers: [BOB], actions: [{ key: records.followKey("bob", "ada", BOB), newValue: "1" }] };
  assert.deepEqual(records.pendingIn([follow, unfollow, others, undefined, {}], ALICE), { "ada/bob": true, "ada_2/cara": false });
  assert.deepEqual(records.pendingIn([others], ALICE), {});
  // Malformed bodies are skipped, not fatal: a signer string that merely contains the address, odd actions, another account's key.
  const odd = [
    { signers: `x${ALICE}x`, actions: follow.actions },
    { signers: [ALICE], actions: "nope" },
    { signers: [ALICE, BOB], actions: [null, { key: 7 }, { key: records.followKey("bob", "cara", BOB), newValue: "1" }, { key: `${records.followKey("ada", "cara", ALICE)}/x`, newValue: "1" }, { key: records.followKey("cara", "ada", ALICE), newValue: "1" }] },
  ];
  assert.deepEqual(records.pendingIn(odd, ALICE), { "cara/ada": true });
});
