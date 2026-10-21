// Follows against a real node: a private host mines Nexus and a Follows chain
// launched from chain/spec.json with the built policy, whose genesis pays the
// premine to Alice. Alice funds Bob and Carol. Alice and Carol follow the
// name @bob, Carol follows Alice's account, and the library reads both ends
// of the graph from the node. Every way of writing someone else's follow, or
// a record that is not a follow, is refused, and so is half of a follow.
// Last, Alice unfollows @bob.
//
//   (cd policy && cargo build --release --target wasm32-unknown-unknown)
//   LATTICE=<lattice-node>/.build/debug/lattice node e2e/follows.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import * as sdk from "../vendor/lattice-sdk.js";
import { createFollows } from "../src/index.mjs";
import * as records from "../src/records/follows.mjs";
import { transaction } from "../src/records/wallet.mjs";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const CHAIN = ["Nexus", "follows"];
const [listen, rpc, publicRead] = [25041, 29390, 29391];
const node = `http://127.0.0.1:${publicRead}`;
const MODULE = here("../policy/target/wasm32-unknown-unknown/release/follows_policy.wasm");
const SPEC = here("../chain/spec.json");

const root = mkdtempSync(`${tmpdir()}/follows-e2e-`);
const lattice = (...args) => execFileSync(process.env.LATTICE, [...args, "--root", root], { encoding: "utf8" });
function configure(change) {
  const file = `${root}/lattice.json`;
  const topology = JSON.parse(readFileSync(file, "utf8"));
  change(topology);
  writeFileSync(file, JSON.stringify(topology, null, 2));
}

const account = () => sdk.accountFromPrivateKey(sdk.generatePrivateKey());
const [miner, alice, bob, carol] = [account(), account(), account(), account()];

async function until(label, condition, seconds = Number(process.env.E2E_SECONDS ?? 300)) {
  const deadline = Date.now() + seconds * 1000;
  let failure;
  for (;;) {
    const value = await condition().catch((error) => void (failure = error));
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`, { cause: failure });
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function api(path) {
  const url = new URL(path, node);
  url.searchParams.set("chainPath", CHAIN.join("/"));
  const response = await fetch(url, { cache: "no-store" });
  return response.ok ? response.json() : undefined;
}
const balance = async (who) => BigInt((await api(`/api/state/account/${who.address}`))?.balance ?? 0);
const nonce = async (who) => BigInt((await api(`/api/state/account/${who.address}`))?.nonce ?? 0);

async function send(who, { actions, payments = [] }) {
  const body = transaction({ owner: who.address, actions, fee: 1n, nonce: await nonce(who), chainPath: CHAIN });
  for (const { to, amount } of payments) {
    body.accountActions[0].delta -= amount;
    body.accountActions.push({ owner: to, delta: amount });
  }
  const { publicKey, signature } = sdk.signTransactionBody(body, who.privateKey);
  const response = await fetch(new URL("/transactions", node), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sdk.transactionPayload({ [publicKey]: signature }, body)),
  });
  return { ok: response.ok, status: response.status, text: await response.text() };
}

async function admitted(label, who, write) {
  const result = await send(who, write);
  assert.ok(result.ok, `${label}: ${result.status} ${result.text}`);
  console.log(`  admitted: ${label}`);
}

async function refused(label, who, write) {
  const result = await send(who, write);
  assert.ok(!result.ok, `${label} was admitted`);
  console.log(`  refused: ${label} (${result.status} ${result.text.trim()})`);
}

const graph = createFollows({ sdk, chain: CHAIN, nodes: [node], freshFor: 0 });
const sorted = (...addresses) => addresses.map((a) => a.address).sort();

try {
  lattice("init");
  configure((topology) => {
    Object.assign(topology, { listen, rpc, publicRead, webSocket: 0, publicSubmit: true });
    topology.publicReadExpensiveRate = 1000;
    topology.peers = [];
    topology.mine = { worker: "cpu", workers: 1, batchSize: 100000 };
  });
  lattice("child", "create", CHAIN.join("/"), "--spec", SPEC, "--policy-module", MODULE, "--premine-to", alice.address);
  configure((topology) => {
    topology.mine.recipients = { Nexus: miner.address, [CHAIN.join("/")]: miner.address };
  });
  lattice("up");
  lattice("mine", "start");

  await until("the chain's genesis is mined", async () => (await balance(alice)) > 0n);
  console.log(`Follows launched; Alice holds ${await balance(alice)}`);
  for (const who of [bob, carol]) {
    await admitted("Alice funds an account", alice, { actions: [], payments: [{ to: who.address, amount: 1000n }] });
    await until("the account is funded", async () => (await balance(who)) === 1000n);
  }

  let state = await graph.state({ fresh: true });
  await admitted("Alice follows @bob", alice, await records.follow(state, alice.address, "bob"));
  await admitted("Carol follows @bob", carol, await records.follow(state, carol.address, "@bob"));
  await until("both follows are mined", async () => (await graph.followers("bob")).length === 2);
  assert.deepEqual(await graph.followers("@bob"), sorted(alice, carol));
  assert.deepEqual(await graph.following(alice.address), ["@bob"]);
  assert.ok(await graph.follows(carol.address, "bob"));
  assert.ok(!(await graph.follows(bob.address, "alice")));
  await admitted("Carol follows Alice's account", carol, await records.follow(await graph.state({ fresh: true }), carol.address, alice.address));
  await until("the account follow is mined", async () => (await graph.followers(alice.address)).length === 1);
  assert.deepEqual(await graph.followers(alice.address), [carol.address]);
  assert.deepEqual(await graph.following(carol.address), ["@bob", alice.address]);
  console.log("@bob's and Alice's followers, and what each follows, read back through the library");

  state = await graph.state({ fresh: true });
  await refused("Bob writes Alice's follow of @carol", bob, await records.follow(state, alice.address, "carol"));
  await refused("Bob deletes Alice's follow of @bob", bob, await records.unfollow(state, alice.address, "bob"));
  await refused("Bob follows something neither an account nor a name", bob, { actions: [records.followKey, records.followerKey].map((key) => ({ key: key(bob.address, "x").replace("@x", "Alice"), newValue: "1" })) });
  await refused("Bob writes his follow of @alice without its twin", bob, { actions: [{ key: records.followKey(bob.address, "alice"), newValue: "1" }] });
  await refused("Bob lists himself as @carol's follower without following", bob, { actions: [{ key: records.followerKey(bob.address, "carol"), newValue: "1" }] });
  await refused("Bob writes a profile here", bob, { actions: [{ key: `user/${bob.address}/profile`, newValue: "{}" }] });

  await admitted("Alice unfollows @bob", alice, await records.unfollow(state, alice.address, "bob"));
  await until("the unfollow is mined", async () => (await graph.followers("bob")).length === 1);
  assert.deepEqual(await graph.followers("bob"), [carol.address]);
  assert.deepEqual(await graph.following(alice.address), []);
  console.log("PASS");
} finally {
  for (const step of [["mine", "stop"], ["down"]]) {
    try {
      lattice(...step);
    } catch {}
  }
}
