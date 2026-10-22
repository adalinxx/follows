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
// Profiles, by id: Alice's, Bob's, Carol's, and a second of Alice's.
const [PA, PB, PC, PA2] = ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb", "cccccccccccccccc", "aaaaaaaaaaaaaaa2"];

/** Who acts for each profile, as Moniker would say: its owner, then its admins. Change it to sell a profile. */
function moniker() {
  const acting = new Map([[PA, [ALICE]], [PB, [BOB]], [PC, [CAROL]], [PA2, [ALICE]]]);
  return { acting, actsFor: async (account, p) => (acting.get(p) ?? []).includes(account) };
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
  const { actsFor } = moniker();
  assert.ok(submit(ALICE, await records.follow(state, ALICE, PA, PB)));
  assert.ok(submit(ALICE, await records.follow(state, ALICE, PA, PC)));
  assert.ok(submit(CAROL, await records.follow(state, CAROL, PC, PB)));
  assert.deepEqual(await records.following(state, PA, actsFor), [PB, PC]);
  assert.deepEqual(await records.followers(state, PB, actsFor), [PA, PC]);
  assert.deepEqual(await records.followers(state, PC, actsFor), [PA]);
  assert.deepEqual(await records.followers(state, PA, actsFor), []);
  assert.ok(await records.follows(state, PA, PB, actsFor));
  assert.ok(!(await records.follows(state, PB, PA, actsFor)));
});

test("a profile counts once, however many of its accounts wrote the follow", async () => {
  const { state, submit } = chain();
  const { acting, actsFor } = moniker();
  acting.set(PA, [ALICE, BOB]); // Bob is an admin of Alice's profile
  assert.ok(submit(ALICE, await records.follow(state, ALICE, PA, PC)));
  assert.ok(submit(BOB, await records.follow(state, BOB, PA, PC)));
  assert.deepEqual(await records.followers(state, PC, actsFor), [PA]);
  assert.deepEqual(await records.following(state, PA, actsFor), [PC]);
  // Each account's keys are its own: Alice's unfollow leaves Bob's, which still counts.
  assert.ok(submit(ALICE, await records.unfollow(state, ALICE, PA, PC)));
  assert.ok(await records.follows(state, PA, PC, actsFor));
});

test("an admin follows as the profile, until it is no longer one", async () => {
  const { state, submit } = chain();
  const { acting, actsFor } = moniker();
  acting.set(PA, [ALICE, CAROL]);
  assert.ok(submit(CAROL, await records.follow(state, CAROL, PA, PB)));
  assert.deepEqual(await records.followers(state, PB, actsFor), [PA]);
  acting.set(PA, [ALICE]);
  assert.deepEqual(await records.followers(state, PB, actsFor), []);
});

test("a follow lapses when its profile changes hands; the new owner writes their own", async () => {
  const { state, submit } = chain();
  const { acting, actsFor } = moniker();
  assert.ok(submit(ALICE, await records.follow(state, ALICE, PA, PB)));
  acting.set(PA, [CAROL]); // Alice sold the profile to Carol
  assert.ok(!(await records.follows(state, PA, PB, actsFor)));
  assert.deepEqual(await records.followers(state, PB, actsFor), []);
  assert.deepEqual(await records.following(state, PA, actsFor), []);
  assert.ok(submit(CAROL, await records.follow(state, CAROL, PA, PB)));
  assert.deepEqual(await records.followers(state, PB, actsFor), [PA]);
});

test("unfollow deletes both of the account's keys; repeats write nothing", async () => {
  const { state, submit, map } = chain();
  const { actsFor } = moniker();
  assert.ok(submit(ALICE, await records.follow(state, ALICE, PA, PB)));
  assert.deepEqual([...map.keys()].sort(), [`followers/${PB}/${PA}/${ALICE}`, `follows/${PA}/${PB}/${ALICE}`]);
  assert.deepEqual(await records.follow(state, ALICE, PA, PB), { actions: [] });
  assert.ok(submit(ALICE, await records.unfollow(state, ALICE, PA, PB)));
  assert.deepEqual(await records.following(state, PA, actsFor), []);
  assert.equal(map.size, 0);
  assert.deepEqual(await records.unfollow(state, ALICE, PA, PB), { actions: [] });
});

test("an account's keys are its own", async () => {
  const { state, submit } = chain();
  const { actsFor } = moniker();
  // Bob signs a write of Alice's keys.
  assert.ok(!submit(BOB, await records.follow(state, ALICE, PA, PB)));
  assert.ok(submit(ALICE, await records.follow(state, ALICE, PA, PB)));
  assert.ok(!submit(BOB, await records.unfollow(state, ALICE, PA, PB)));
  assert.deepEqual(await records.followers(state, PB, actsFor), [PA]);
  // Keys Bob writes for a profile he doesn't act for are kept by the chain, and counted by no reader.
  assert.ok(submit(BOB, await records.follow(state, BOB, PC, PB)));
  assert.deepEqual(await records.followers(state, PB, actsFor), [PA]);
});

test("only profiles follow profiles", async () => {
  for (const neither of ["Bob", "@bob", "bob", BOB, "aaaaaaaaaaaaaaa1", ""]) {
    await assert.rejects(records.follow(chain().state, ALICE, PA, neither), /not a profile/, neither);
    await assert.rejects(records.follow(chain().state, ALICE, neither, PA), /not a profile/, neither);
  }
  assert.ok(records.isProfileId(PA2));
  assert.ok(!records.isProfileId(BOB));
});

test("a follow or unfollow waiting for a block is found in transaction bodies", () => {
  const follow = { signers: [ALICE], actions: [{ key: records.followKey(PA, PB, ALICE), newValue: "1" }, { key: records.followerKey(PA, PB, ALICE), newValue: "1" }] };
  const unfollow = { signers: [ALICE], actions: [{ key: records.followKey(PA2, PC, ALICE), oldValue: "1" }, { key: records.followerKey(PA2, PC, ALICE), oldValue: "1" }] };
  const others = { signers: [BOB], actions: [{ key: records.followKey(PB, PA, BOB), newValue: "1" }] };
  assert.deepEqual(records.pendingIn([follow, unfollow, others, undefined, {}], ALICE), { [`${PA}/${PB}`]: true, [`${PA2}/${PC}`]: false });
  assert.deepEqual(records.pendingIn([others], ALICE), {});
  // Malformed bodies are skipped, not fatal: a signer string that merely contains the address, odd actions, another account's key.
  const odd = [
    { signers: `x${ALICE}x`, actions: follow.actions },
    { signers: [ALICE], actions: "nope" },
    { signers: [ALICE, BOB], actions: [null, { key: 7 }, { key: records.followKey(PB, PC, BOB), newValue: "1" }, { key: `${records.followKey(PA, PC, ALICE)}/x`, newValue: "1" }, { key: records.followKey(PC, PA, ALICE), newValue: "1" }] },
  ];
  assert.deepEqual(records.pendingIn(odd, ALICE), { [`${PC}/${PA}`]: true });
});
