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
const [ALICE, BOB] = [address(1), address(2)];
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

// Handles: Moniker names, lowercase letters, digits and `_`.
const [P, Q, R] = ["alice", "bob_2", "c7"];
const follow = (p, t, a) => `follows/${p}/${t}/${a}`;
const follower = (p, t, a) => `followers/${t}/${p}/${a}`;
/** Handle `p` following `t`, written by account `a`, as both keys, each with `change` ({ oldValue?, newValue? }). */
const both = (p, t, a, change) => [{ key: follow(p, t, a), ...change }, { key: follower(p, t, a), ...change }];

test("an account follows, refollows and unfollows as a handle, both keys at once", () => {
  assert.ok(accepts(both(P, Q, ALICE, { newValue: "1" })));
  assert.ok(accepts(both(P, Q, ALICE, { oldValue: "1", newValue: "1" })));
  assert.ok(accepts(both(P, Q, ALICE, { oldValue: "1" })));
  assert.ok(accepts([...both(P, Q, ALICE, { newValue: "1" }), ...both(P, R, ALICE, { newValue: "1" })]));
  // Any handle, owned by anyone: who owns it is Moniker's business, checked by readers.
  assert.ok(accepts(both(Q, P, ALICE, { newValue: "1" })));
  assert.ok(accepts(both(P, P, ALICE, { newValue: "1" })));
});

test("one key without its twin is refused", () => {
  assert.ok(!accepts([{ key: follow(P, Q, ALICE), newValue: "1" }]));
  assert.ok(!accepts([{ key: follower(P, Q, ALICE), newValue: "1" }]));
  assert.ok(!accepts([{ key: follow(P, Q, ALICE), oldValue: "1" }]));
  assert.ok(!accepts([{ key: follower(P, Q, ALICE), oldValue: "1" }]));
  // A twin of another follow is no twin: another followed, another follower, another account.
  assert.ok(!accepts([{ key: follow(P, Q, ALICE), newValue: "1" }, { key: follower(P, R, ALICE), newValue: "1" }]));
  assert.ok(!accepts([{ key: follow(P, Q, ALICE), newValue: "1" }, { key: follower(R, Q, ALICE), newValue: "1" }]));
  assert.ok(!accepts([{ key: follow(P, Q, ALICE), newValue: "1" }, { key: follower(P, Q, BOB), newValue: "1" }], { signers: [ALICE, BOB] }));
  // Ends swapped: Q following P is no twin of P following Q.
  assert.ok(!accepts([{ key: follow(P, Q, ALICE), newValue: "1" }, { key: follower(Q, P, ALICE), newValue: "1" }]));
});

test("the twin comes directly after: not first, not after other follows", () => {
  assert.ok(!accepts([{ key: follower(P, Q, ALICE), newValue: "1" }, { key: follow(P, Q, ALICE), newValue: "1" }]));
  assert.ok(!accepts([{ key: follow(P, Q, ALICE), newValue: "1" }, ...both(P, R, ALICE, { newValue: "1" }), { key: follower(P, Q, ALICE), newValue: "1" }]));
});

test("the work grows with the transaction, no faster", () => {
  const time = (n) => {
    const actions = [];
    for (let i = 0; i < n; i++) actions.push(...both(P, `t${i}`, ALICE, { newValue: "1" }));
    const start = performance.now();
    assert.ok(accepts(actions));
    return performance.now() - start;
  };
  time(500);
  const [small, large] = [time(2000), time(8000)];
  assert.ok(large < small * 8, `${small.toFixed(1)}ms for 2000, ${large.toFixed(1)}ms for 8000`);
});

test("the twins always hold the same value", () => {
  assert.ok(!accepts([{ key: follow(P, Q, ALICE), newValue: "1" }, { key: follower(P, Q, ALICE), newValue: "2" }]));
  assert.ok(!accepts([{ key: follow(P, Q, ALICE), oldValue: "1" }, { key: follower(P, Q, ALICE), oldValue: "1", newValue: "1" }]));
  assert.ok(!accepts([{ key: follow(P, Q, ALICE), oldValue: "1", newValue: "1" }, { key: follower(P, Q, ALICE), oldValue: "1" }]));
});

test("nobody writes or deletes another account's keys", () => {
  assert.ok(!accepts(both(P, Q, BOB, { newValue: "1" })));
  assert.ok(!accepts(both(P, Q, BOB, { oldValue: "1" })));
  assert.ok(!accepts([...both(P, Q, ALICE, { newValue: "1" }), ...both(Q, P, BOB, { newValue: "1" })]));
  // Signed by both, each writes their own; and two accounts may each write for one handle.
  assert.ok(accepts([...both(P, Q, ALICE, { newValue: "1" }), ...both(P, Q, BOB, { newValue: "1" })], { signers: [ALICE, BOB] }));
});

test("a handle of any length is a record; a profile id is just a handle", () => {
  // No 16-character profile-id shape: short, long, any digit, underscores.
  for (const id of ["a", "_", "0", "aaaaaaaaaaaaaaa1", "aaaaaaaaaaaaaaa8", "aaaaaaaaaaaaaaa_", "aaaaaaaaaaaaaaaaa", "x".repeat(300), "aaaaaaaaaaaaaaaa"]) {
    assert.ok(accepts(both(id, Q, ALICE, { newValue: "1" })), `follower ${id}`);
    assert.ok(accepts(both(P, id, ALICE, { newValue: "1" })), `followed ${id}`);
  }
});

test("only a handle following a handle, by an account, is a record", () => {
  for (const id of ["", "Alice", "ALICE", "al-ice", "-", "al.ice", "al ice", "alicé", "@alice", "al/ice", ALICE.toUpperCase()]) {
    assert.ok(!accepts(both(id, Q, ALICE, { newValue: "1" })), `follower ${id}`);
    assert.ok(!accepts(both(P, id, ALICE, { newValue: "1" })), `followed ${id}`);
  }
  // The account must be an address, and sign.
  for (const a of ["alice", "abcdefghijklmnop", ALICE.toUpperCase(), `${ALICE}x`, ""]) assert.ok(!accepts(both(P, Q, a, { newValue: "1" }), { signers: [ALICE, a] }), a);
  for (const key of [
    `${follow(P, Q, ALICE)}/x`,
    `${follower(P, Q, ALICE)}/x`,
    `follows/${P}/${Q}`,
    `followers/${Q}/${P}`,
    `follow/${P}/${Q}/${ALICE}`,
    `user/${ALICE}/follows/${Q}`,
    `followers/${Q}/${ALICE}`,
    "",
  ]) {
    assert.ok(!accepts([{ key, newValue: "1" }]), key);
  }
  // Twins that both run on are still not follows.
  assert.ok(!accepts([{ key: `${follow(P, Q, ALICE)}/x`, newValue: "1" }, { key: `${follower(P, Q, ALICE)}/x`, newValue: "1" }]));
  // One bad action rejects the whole write.
  assert.ok(!accepts([...both(P, Q, ALICE, { newValue: "1" }), { key: `user/${ALICE}/profile`, newValue: "{}" }]));
});

test("values mean nothing else to the chain", () => {
  assert.ok(accepts(both(P, Q, ALICE, { newValue: "" })));
  assert.ok(accepts(both(P, Q, ALICE, { newValue: JSON.stringify({ since: 1 }) })));
});

test("coin actions pass untouched", () => {
  assert.ok(accepts([], { accountActions: [{ owner: ALICE, delta: -5n }, { owner: BOB, delta: 5n }] }));
});

test("a malformed or missing body is rejected", () => {
  assert.ok(!validate(context(undefined, { path: PATH })));
  assert.ok(!validate(context(Uint8Array.of(0xa0, 0x00), { path: PATH })));
  assert.ok(!validate(Uint8Array.of(1, 2, 3)));
});
