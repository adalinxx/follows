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

/**
 * Moniker as readers see it: where each handle points, and which handle
 * each account shows. Change them to move a handle.
 */
function moniker() {
  const points = new Map([["ada", ALICE], ["bob", BOB], ["cara", CAROL]]);
  const shows = new Map([[ALICE, "ada"], [BOB, "bob"], [CAROL, "cara"]]);
  const names = {
    pointers: async (handles) => handles.map((h) => points.get(h)),
    // Shown only while the handle points back, as Moniker's handleOf.
    handlesOf: async (accounts) => accounts.map((a) => (points.get(shows.get(a)) === a ? shows.get(a) : undefined)),
  };
  return { points, shows, names };
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

const people = (list) => list.map((p) => p.handle ?? p.account);

test("following a person with a handle follows the handle; without one, the account", async () => {
  const { state, submit, map } = chain();
  const { names, shows } = moniker();
  shows.delete(CAROL); // Carol shows no handle
  assert.ok(submit(ALICE, await records.follow(state, names, ALICE, BOB)));
  assert.ok(submit(ALICE, await records.follow(state, names, ALICE, CAROL)));
  assert.deepEqual([...map.keys()].sort(), [`followers/${CAROL}/${ALICE}`, `followers/@bob/${ALICE}`, `follows/${ALICE}/${CAROL}`, `follows/${ALICE}/@bob`].sort());
  // In key order: `@` sorts before any address.
  assert.deepEqual(await records.following(state, names, ALICE), [{ account: BOB, handle: "bob" }, { account: CAROL }]);
  assert.deepEqual(await records.followers(state, names, "@bob"), [ALICE]);
  assert.deepEqual(await records.followers(state, names, BOB), [ALICE]);
  assert.deepEqual(await records.followers(state, names, CAROL), [ALICE]);
  assert.ok(await records.follows(state, names, ALICE, "bob"));
  assert.ok(!(await records.follows(state, names, BOB, ALICE)));
  // No handle needed to follow: Carol shows none, and follows Bob.
  assert.ok(submit(CAROL, await records.follow(state, names, CAROL, "@bob")));
  assert.deepEqual(await records.followers(state, names, BOB), [ALICE, CAROL].sort()); // key order
});

test("a person's followers are their account's and their handle's, each account once", async () => {
  const { state, submit } = chain();
  const { names, shows } = moniker();
  shows.delete(BOB);
  assert.ok(submit(ALICE, await records.follow(state, names, ALICE, BOB))); // by account: Bob shows no handle yet
  shows.set(BOB, "bob");
  assert.ok(submit(CAROL, await records.follow(state, names, CAROL, BOB))); // by handle now
  assert.deepEqual(await records.follow(state, names, ALICE, "@bob"), { actions: [] }); // already, by account
  assert.deepEqual(await records.followers(state, names, BOB), [ALICE, CAROL]);
  assert.deepEqual(await records.followers(state, names, "@bob"), [ALICE, CAROL]);
  // Alice follows both ways by hand: still one follower, one entry.
  assert.ok(submit(ALICE, { actions: [records.followKey(ALICE, "@bob"), records.followerKey(ALICE, "@bob")].map((key) => ({ key, newValue: "1" })) }));
  assert.deepEqual(await records.followers(state, names, BOB), [ALICE, CAROL]);
  assert.deepEqual(await records.following(state, names, ALICE), [{ account: BOB, handle: "bob" }]);
  // Unfollow deletes both.
  assert.equal((await records.unfollow(state, names, ALICE, BOB)).actions.length, 4);
});

test("a handle's followers go where it goes; an account's stay", async () => {
  const { state, submit } = chain();
  const { names, points, shows } = moniker();
  assert.ok(submit(CAROL, await records.follow(state, names, CAROL, "@ada")));
  shows.delete(ALICE);
  assert.ok(submit(BOB, await records.follow(state, names, BOB, ALICE))); // by account: Alice shows no handle yet
  shows.set(ALICE, "ada");
  // Alice gives @ada to Bob's key, and it shows there now.
  points.set("ada", BOB);
  shows.set(BOB, "ada");
  assert.deepEqual(await records.followers(state, names, "@ada"), [CAROL]);
  assert.deepEqual(await records.followers(state, names, BOB), [CAROL]);
  assert.deepEqual(await records.followers(state, names, ALICE), [BOB]);
  assert.deepEqual(people(await records.following(state, names, CAROL)), ["ada"]);
  assert.equal((await records.following(state, names, CAROL))[0].account, BOB);
});

test("a handle no account shows is still followed, and stands for no one", async () => {
  const { state, submit } = chain();
  const { names, points, shows } = moniker();
  assert.ok(submit(ALICE, await records.follow(state, names, ALICE, "@bob")));
  shows.set(BOB, "other"); // Bob shows another handle
  assert.deepEqual(await records.following(state, names, ALICE), [{ handle: "bob" }]);
  assert.deepEqual(await records.followers(state, names, BOB), []);
  assert.deepEqual(await records.followers(state, names, "@bob"), [ALICE]);
  points.delete("bob"); // released
  assert.deepEqual(await records.following(state, names, ALICE), [{ handle: "bob" }]);
  // A handle never claimed can be followed too, as `{ handle }`.
  assert.ok(submit(ALICE, await records.follow(state, names, ALICE, "@nobody")));
  assert.ok(await records.follows(state, names, ALICE, "nobody"));
  // Shown again, the follow counts for whoever shows it.
  points.set("bob", BOB);
  shows.set(BOB, "bob");
  assert.deepEqual(await records.followers(state, names, BOB), [ALICE]);
});

test("unfollow deletes the account's keys; repeats write nothing", async () => {
  const { state, submit, map } = chain();
  const { names } = moniker();
  assert.ok(submit(ALICE, await records.follow(state, names, ALICE, "@bob")));
  assert.deepEqual(await records.follow(state, names, ALICE, BOB), { actions: [] });
  assert.ok(submit(ALICE, await records.unfollow(state, names, ALICE, BOB)));
  assert.deepEqual(await records.following(state, names, ALICE), []);
  assert.equal(map.size, 0);
  assert.deepEqual(await records.unfollow(state, names, ALICE, "@bob"), { actions: [] });
});

test("an account's keys are its own; nobody follows themselves", async () => {
  const { state, submit } = chain();
  const { names } = moniker();
  assert.ok(!submit(BOB, await records.follow(state, names, ALICE, "@bob")));
  assert.ok(submit(ALICE, await records.follow(state, names, ALICE, "@bob")));
  assert.ok(!submit(BOB, await records.unfollow(state, names, ALICE, "@bob")));
  assert.deepEqual(await records.followers(state, names, BOB), [ALICE]);
  await assert.rejects(records.follow(state, names, ALICE, "@ada"), /yourself/);
  await assert.rejects(records.follow(state, names, ALICE, ALICE), /yourself/);
});

test("only an account or a @handle is followed", async () => {
  const { names } = moniker();
  for (const neither of ["Bob", "@Bob", "bo b", "bob/x", "@@bob", ""]) {
    await assert.rejects(records.follow(chain().state, names, ALICE, neither), /not an account or a handle/, neither);
  }
  await assert.rejects(records.follow(chain().state, names, "ada", BOB), /not an account/);
  assert.equal(records.target("bob"), "@bob");
  assert.equal(records.target("@bob"), "@bob");
  assert.equal(records.target(BOB), BOB);
  assert.equal(records.target(`@${BOB}`), `@${BOB}`);
});

test("a follow or unfollow waiting for a block is found in transaction bodies", () => {
  const keys = (t) => [records.followKey(ALICE, t), records.followerKey(ALICE, t)];
  const follow = { signers: [ALICE], actions: keys("@bob").map((key) => ({ key, newValue: "1" })) };
  const unfollow = { signers: [ALICE], actions: keys(CAROL).map((key) => ({ key, oldValue: "1" })) };
  const others = { signers: [BOB], actions: [{ key: records.followKey(BOB, "@ada"), newValue: "1" }] };
  assert.deepEqual(records.pendingIn([follow, unfollow, others, undefined, {}], ALICE), { "@bob": true, [CAROL]: false });
  assert.deepEqual(records.pendingIn([others], ALICE), {});
  // Malformed bodies are skipped, not fatal.
  const odd = [
    { signers: `x${ALICE}x`, actions: follow.actions },
    { signers: [ALICE], actions: "nope" },
    { signers: [ALICE, BOB], actions: [null, { key: 7 }, { key: records.followKey(BOB, "@cara"), newValue: "1" }, { key: `${records.followKey(ALICE, "@cara")}/x`, newValue: "1" }, { key: `follows/${ALICE}/Bob`, newValue: "1" }, { key: records.followKey(ALICE, "@cara"), newValue: "1" }] },
  ];
  assert.deepEqual(records.pendingIn(odd, ALICE), { "@cara": true });
});
