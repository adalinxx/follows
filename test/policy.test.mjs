// Runs the built policy module the way the Lattice host does (host.mjs), on
// hand-made writes. Bodies are encoded by the Lattice SDK, whose encoding is
// pinned to Lattice's vectors.
//
//   (cd policy && cargo build --release --target wasm32-unknown-unknown)
//   node --test test/
//
// With CONTEXT_DIR set, every context is recorded with its verdict so
// policy/host-check can replay it through Lattice's own evaluator.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import * as sdk from "../vendor/lattice-sdk.js";
import { context, validate } from "./host.mjs";

const address = (seed) => sdk.addressFromPublicKey(sdk.publicKeyFromPrivate(new Uint8Array(32).fill(seed)));
const [ALICE, BOB, CAROL] = [address(1), address(2), address(3)];
const PATH = ["Nexus", "follows"];

const contextDirectory = process.env.CONTEXT_DIR;
if (contextDirectory) mkdirSync(contextDirectory, { recursive: true });
let recorded = 0;

function accepts(actions, { signers = [ALICE], accountActions = [] } = {}) {
  const body = sdk.encodeTransactionBody({
    accountActions,
    actions,
    depositActions: [],
    receiptActions: [],
    withdrawalActions: [],
    signers,
    nonce: 0n,
    chainPath: PATH,
  }).bytes;
  const bytes = context(body, { path: PATH });
  const accepted = validate(bytes);
  if (contextDirectory) writeFileSync(`${contextDirectory}/${String(recorded++).padStart(3, "0")}-${accepted ? "accept" : "reject"}.bin`, bytes);
  return accepted;
}

const follow = (a, b) => `user/${a}/follows/${b}`;
const follower = (a, b) => `followers/${b}/${a}`;
/** A follow of `b` by `a` as both keys, each with `change` ({ oldValue?, newValue? }). */
const both = (a, b, change) => [{ key: follow(a, b), ...change }, { key: follower(a, b), ...change }];

test("an account follows, refollows and unfollows, both keys at once", () => {
  assert.ok(accepts(both(ALICE, BOB, { newValue: "1" })));
  assert.ok(accepts(both(ALICE, BOB, { oldValue: "1", newValue: "1" })));
  assert.ok(accepts(both(ALICE, BOB, { oldValue: "1" })));
  assert.ok(accepts([...both(ALICE, BOB, { newValue: "1" }), ...both(ALICE, CAROL, { newValue: "1" })]));
  // The twin may come first, or after other follows.
  assert.ok(accepts([{ key: follower(ALICE, BOB), newValue: "1" }, ...both(ALICE, CAROL, { newValue: "1" }), { key: follow(ALICE, BOB), newValue: "1" }]));
  assert.ok(accepts(both(ALICE, ALICE, { newValue: "1" })));
});

test("one key without its twin is refused", () => {
  assert.ok(!accepts([{ key: follow(ALICE, BOB), newValue: "1" }]));
  assert.ok(!accepts([{ key: follower(ALICE, BOB), newValue: "1" }]));
  assert.ok(!accepts([{ key: follow(ALICE, BOB), oldValue: "1" }]));
  assert.ok(!accepts([{ key: follower(ALICE, BOB), oldValue: "1" }]));
  // A twin of someone else's follow is no twin.
  assert.ok(!accepts([{ key: follow(ALICE, BOB), newValue: "1" }, { key: follower(ALICE, CAROL), newValue: "1" }]));
});

test("the twins always hold the same value", () => {
  assert.ok(!accepts([{ key: follow(ALICE, BOB), newValue: "1" }, { key: follower(ALICE, BOB), newValue: "2" }]));
  assert.ok(!accepts([{ key: follow(ALICE, BOB), oldValue: "1" }, { key: follower(ALICE, BOB), oldValue: "1", newValue: "1" }]));
  assert.ok(!accepts([{ key: follow(ALICE, BOB), oldValue: "1", newValue: "1" }, { key: follower(ALICE, BOB), oldValue: "1" }]));
});

test("nobody writes or deletes another account's follows", () => {
  assert.ok(!accepts(both(BOB, CAROL, { newValue: "1" })));
  assert.ok(!accepts(both(BOB, ALICE, { oldValue: "1" })));
  assert.ok(!accepts([...both(ALICE, BOB, { newValue: "1" }), ...both(BOB, ALICE, { newValue: "1" })]));
  // Signed by both, each writes their own.
  assert.ok(accepts([...both(ALICE, BOB, { newValue: "1" }), ...both(BOB, ALICE, { newValue: "1" })], { signers: [ALICE, BOB] }));
});

test("only follows of an address by an address are records", () => {
  for (const [a, b] of [[ALICE, "bob"], [ALICE, BOB.toUpperCase()], [ALICE, ""], ["alice", BOB]]) {
    assert.ok(!accepts(both(a, b, { newValue: "1" })), `${a} ${b}`);
  }
  for (const key of [
    `user/${ALICE}/follows/${BOB}/x`,
    `followers/${BOB}/${ALICE}/x`,
    `user/${ALICE}/follow/${BOB}`,
    `user/${ALICE}/profile`,
    `users/${ALICE}/follows/${BOB}`,
    `followers/${BOB}`,
    `index/follower/${BOB}/${ALICE}`,
    "",
  ]) {
    assert.ok(!accepts([{ key, newValue: "1" }]), key);
  }
  // Twins that both run on are still not follows.
  assert.ok(!accepts([{ key: `${follow(ALICE, BOB)}/x`, newValue: "1" }, { key: `${follower(ALICE, BOB)}/x`, newValue: "1" }]));
  // One bad action rejects the whole write.
  assert.ok(!accepts([...both(ALICE, BOB, { newValue: "1" }), { key: `user/${ALICE}/profile`, newValue: "{}" }]));
});

test("values mean nothing else to the chain", () => {
  assert.ok(accepts(both(ALICE, BOB, { newValue: "" })));
  assert.ok(accepts(both(ALICE, BOB, { newValue: JSON.stringify({ since: 1 }) })));
});

test("coin actions pass untouched", () => {
  assert.ok(accepts([], { accountActions: [{ owner: ALICE, delta: -5n }, { owner: BOB, delta: 5n }] }));
});

test("a malformed or missing body is rejected", () => {
  assert.ok(!validate(context(undefined, { path: PATH })));
  assert.ok(!validate(context(Uint8Array.of(0xa0, 0x00), { path: PATH })));
  assert.ok(!validate(Uint8Array.of(1, 2, 3)));
});
