// The record code (src/records/follows.mjs) against a chain in memory that
// admits a write the way consensus would: every old value must be what the
// key holds, and the built policy must accept the body.
//
//   policy/build.sh
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

test("a follow is of an account: @bob follows the account showing it", async () => {
  const { state, submit, map } = chain();
  const { names, shows } = moniker();
  shows.delete(CAROL); // Carol shows no handle
  assert.ok(submit(ALICE, await records.follow(state, names, ALICE, "@bob")));
  assert.ok(submit(ALICE, await records.follow(state, names, ALICE, CAROL)));
  assert.deepEqual([...map.keys()].sort(), [`followers/${BOB}/${ALICE}`, `followers/${CAROL}/${ALICE}`, `follows/${ALICE}/${BOB}`, `follows/${ALICE}/${CAROL}`].sort());
  const expected = [{ account: BOB, handle: "bob" }, { account: CAROL }].sort((x, y) => (x.account < y.account ? -1 : 1)); // key order
  assert.deepEqual(await records.following(state, names, ALICE), expected);
  for (const who of ["@bob", "bob", BOB]) assert.deepEqual(await records.followers(state, names, who), [ALICE], who);
  assert.deepEqual(await records.followers(state, names, CAROL), [ALICE]);
  assert.ok(await records.follows(state, names, ALICE, "bob"));
  assert.ok(await records.follows(state, names, ALICE, BOB));
  assert.ok(!(await records.follows(state, names, BOB, ALICE)));
  // By handle or by account, the same follow: nothing more to write.
  assert.deepEqual(await records.follow(state, names, ALICE, BOB), { actions: [] });
  // No handle needed to follow: Carol shows none, and follows Bob.
  assert.ok(submit(CAROL, await records.follow(state, names, CAROL, "@bob")));
  assert.deepEqual(await records.followers(state, names, BOB), [ALICE, CAROL].sort()); // key order
});

test("a follow stays with the account when its handle changes hands", async () => {
  const { state, submit } = chain();
  const { names, points, shows } = moniker();
  assert.ok(submit(CAROL, await records.follow(state, names, CAROL, "@ada"))); // Alice's account
  // Alice gives @ada to Bob's key, and it shows there now.
  points.set("ada", BOB);
  shows.set(BOB, "ada");
  shows.delete(ALICE);
  assert.deepEqual(await records.followers(state, names, ALICE), [CAROL]);
  assert.deepEqual(await records.followers(state, names, "@ada"), []); // Bob's account: nobody follows it
  assert.deepEqual(await records.following(state, names, CAROL), [{ account: ALICE }]);
  assert.ok(!(await records.follows(state, names, CAROL, "@ada")));
});

test("a handle no account shows is no one to follow", async () => {
  const { state, submit } = chain();
  const { names, points, shows } = moniker();
  assert.ok(submit(ALICE, await records.follow(state, names, ALICE, "@bob")));
  shows.set(BOB, "other"); // Bob shows another handle: still followed, as an account
  assert.deepEqual(await records.following(state, names, ALICE), [{ account: BOB }]);
  assert.deepEqual(await records.followers(state, names, BOB), [ALICE]);
  assert.deepEqual(await records.followers(state, names, "@bob"), []);
  assert.ok(!(await records.follows(state, names, ALICE, "@bob")));
  await assert.rejects(records.follow(state, names, ALICE, "@bob"), /No account shows @bob/);
  points.delete("bob"); // released
  await assert.rejects(records.follow(state, names, ALICE, "@nobody"), /No account shows @nobody/);
  assert.deepEqual(await records.unfollow(state, names, ALICE, "@nobody"), { actions: [] });
});

test("unfollow deletes the account's keys; repeats write nothing", async () => {
  const { state, submit, map } = chain();
  const { names } = moniker();
  assert.ok(submit(ALICE, await records.follow(state, names, ALICE, "@bob")));
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

test("only an account, or a @handle naming one, is followed; keys hold accounts only", async () => {
  const { names } = moniker();
  for (const neither of ["Bob", "@Bob", "bo b", "bob/x", "@@bob", ""]) {
    await assert.rejects(records.follow(chain().state, names, ALICE, neither), /not an account or a handle/, neither);
  }
  await assert.rejects(records.follow(chain().state, names, "ada", BOB), /not an account/);
  assert.throws(() => records.followKey(ALICE, "@bob"), /not an account/);
  assert.throws(() => records.followerKey(ALICE, "bob"), /not an account/);
  assert.equal(records.target("bob"), "@bob");
  assert.equal(records.target("@bob"), "@bob");
  assert.equal(records.target(BOB), BOB);
  assert.equal(records.target(`@${BOB}`), `@${BOB}`);
});

test("a follow or unfollow waiting for a block is found in transaction bodies", () => {
  const keys = (t) => [records.followKey(ALICE, t), records.followerKey(ALICE, t)];
  const follow = { signers: [ALICE], actions: keys(BOB).map((key) => ({ key, newValue: "1" })) };
  const unfollow = { signers: [ALICE], actions: keys(CAROL).map((key) => ({ key, oldValue: "1" })) };
  const others = { signers: [BOB], actions: [{ key: records.followKey(BOB, ALICE), newValue: "1" }] };
  assert.deepEqual(records.pendingIn([follow, unfollow, others, undefined, {}], ALICE), { [BOB]: true, [CAROL]: false });
  assert.deepEqual(records.pendingIn([others], ALICE), {});
  // Malformed bodies are skipped, not fatal; a handle is no followed account.
  const odd = [
    { signers: `x${ALICE}x`, actions: follow.actions },
    { signers: [ALICE], actions: "nope" },
    { signers: [ALICE, BOB], actions: [null, { key: 7 }, { key: records.followKey(BOB, CAROL), newValue: "1" }, { key: `${records.followKey(ALICE, CAROL)}/x`, newValue: "1" }, { key: `follows/${ALICE}/Bob`, newValue: "1" }, { key: `follows/${ALICE}/@cara`, newValue: "1" }, { key: records.followKey(ALICE, CAROL), newValue: "1" }] },
  ];
  assert.deepEqual(records.pendingIn(odd, ALICE), { [CAROL]: true });
});
