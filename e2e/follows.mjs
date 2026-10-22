// Follows against a real node: a private host mines Nexus, a Follows chain
// launched from chain/spec.json with the built policy, and a Moniker chain
// under Moniker's own policy (e2e/ui/moniker/), both with fast blocks and
// free writes. Alice and Bob claim and show @ada and @bob on Moniker; Carol
// shows no handle. Alice follows Bob (by @bob), Carol follows Bob through the
// library, and Bob follows Carol, who has no handle, by her account. Every
// way of writing someone else's keys, half a follow, or a target that is
// neither an account nor a @handle is refused. Then Alice gives @ada to
// Dan's key and Dan shows it: @ada's followers follow Dan now, and what
// followed Alice's account stays hers. Last, Bob unfollows Carol, and an
// unfollow of a person followed both ways deletes both.
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
import { createMoniker } from "../app/vendor/moniker-sdk/src/index.mjs";
import * as names from "../app/vendor/moniker-sdk/src/records/names.mjs";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const FOLLOWS = ["Nexus", "follows"];
const MONIKER = ["Nexus", "moniker"];
const [listen, rpc, publicRead] = [25041, 29390, 29391];
const node = `http://127.0.0.1:${publicRead}`;

const root = mkdtempSync(`${tmpdir()}/follows-e2e-`);
const lattice = (...args) => execFileSync(process.env.LATTICE, [...args, "--root", root], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
function configure(change) {
  const file = `${root}/lattice.json`;
  const topology = JSON.parse(readFileSync(file, "utf8"));
  change(topology);
  writeFileSync(file, JSON.stringify(topology, null, 2));
}
/** A chain spec with 2-second blocks and no premine, written next to the node. */
function fast(file, name) {
  const out = `${root}/${name}-spec.json`;
  writeFileSync(out, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), targetBlockTime: 2000, premine: 0 }));
  return out;
}

const account = () => sdk.accountFromPrivateKey(sdk.generatePrivateKey());
const [alice, bob, carol, dan] = [account(), account(), account(), account()];

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

async function nonce(chain, who) {
  const response = await fetch(`${node}/api/state/account/${who.address}?chainPath=${chain.join("/")}`, { cache: "no-store" });
  return BigInt((response.ok ? await response.json() : {}).nonce ?? 0);
}

/** `actions` on `chain`, signed by `who`, sent; the node's answer. */
async function send(chain, who, { actions }) {
  const body = transaction({ owner: who.address, actions, fee: 0n, nonce: await nonce(chain, who), chainPath: chain });
  const { publicKey, signature } = sdk.signTransactionBody(body, who.privateKey);
  const response = await fetch(new URL("/transactions", node), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sdk.transactionPayload({ [publicKey]: signature }, body)),
  });
  return { ok: response.ok, status: response.status, text: await response.text() };
}

async function admitted(label, chain, who, write) {
  const result = await send(chain, who, write);
  assert.ok(result.ok, `${label}: ${result.status} ${result.text}`);
  console.log(`  admitted: ${label}`);
}

async function refused(label, who, write) {
  const result = await send(FOLLOWS, who, write);
  assert.ok(!result.ok, `${label} was admitted`);
  console.log(`  refused: ${label} (${result.status} ${result.text.trim()})`);
}

/** A wallet holding `who`'s key, as Selfhold would answer the library: it signs what it is asked and sends it. */
const walletOf = (who) => ({
  address: async () => who.address,
  writeRecords: async (request) => {
    const result = await send(request.chainPath, who, request);
    if (!result.ok) throw new Error(`${result.status} ${result.text}`);
    return { transactionCID: "sent" };
  },
});

const moniker = createMoniker({ sdk, chain: MONIKER, nodes: [node], freshFor: 0 });
const graph = createFollows({ sdk, moniker, chain: FOLLOWS, nodes: [node], freshFor: 0 });
const sorted = (list) => [...list].sort();
/** Starts mining; another suite on this machine may hold the miner a while. */
async function mine() {
  for (let attempt = 0; ; attempt++) {
    try {
      return lattice("mine", "start");
    } catch (error) {
      if (!/already running/i.test(`${error.stderr}${error.stdout}${error.message}`) || attempt >= 10) throw error;
      console.log("  mining is already running elsewhere: waiting a minute");
      await new Promise((resolve) => setTimeout(resolve, 60_000));
    }
  }
}

try {
  lattice("init");
  configure((topology) => {
    Object.assign(topology, { listen, rpc, publicRead, webSocket: 0, publicSubmit: true });
    // As the trial hosts: any fee is admitted, so writing is free.
    topology.minRelayFee = 0;
    topology.publicReadExpensiveRate = 10000;
    topology.publicReadRate = 10000;
    topology.publicReadMaxRate = 100000;
    topology.peers = [];
    topology.mine = { worker: "cpu", workers: 1, batchSize: 100000 };
  });
  lattice("child", "create", FOLLOWS.join("/"), "--spec", fast(here("../chain/spec.json"), "follows"), "--policy-module", here("../chain/follows_policy.wasm"));
  lattice("child", "create", MONIKER.join("/"), "--spec", fast(here("ui/moniker/spec.json"), "moniker"), "--policy-module", here("ui/moniker/moniker_policy.wasm"));
  const miner = account().address;
  configure((topology) => {
    topology.mine.recipients = { Nexus: miner, [FOLLOWS.join("/")]: miner, [MONIKER.join("/")]: miner };
  });
  lattice("up");
  await mine();
  const height = async (chain) => {
    const response = await fetch(`${node}/api/block/latest?chainPath=${chain.join("/")}`);
    return response.ok ? Number((await response.json()).height) : -1;
  };
  await until("both chains' first blocks", async () => (await height(FOLLOWS)) >= 1 && (await height(MONIKER)) >= 1);
  console.log("Follows and Moniker launched");

  for (const [who, handle] of [[alice, "ada"], [bob, "bob"]]) {
    await admitted(`claims and shows @${handle} on Moniker`, MONIKER, who, await names.claim(await moniker.state({ fresh: true }), who.address, handle, { show: true }));
  }
  await until("the handles show", async () => (await moniker.handleOf(alice.address)) === "ada" && (await moniker.handleOf(bob.address)) === "bob");

  // Following someone who shows a handle follows the handle.
  let state = await graph.state({ fresh: true });
  const viaMoniker = { pointers: (hs) => Promise.all(hs.map((h) => moniker.pointer(h))), handlesOf: (as) => moniker.handlesOf(as) };
  const aliceFollowsBob = await records.follow(state, viaMoniker, alice.address, bob.address);
  assert.deepEqual(aliceFollowsBob.actions.map((x) => x.key), [`follows/${alice.address}/@bob`, `followers/@bob/${alice.address}`]);
  await admitted("Alice follows @bob", FOLLOWS, alice, aliceFollowsBob);
  // No handle needed to follow: Carol shows none.
  await graph.follow("@bob", { wallet: walletOf(carol) });
  console.log("  admitted: Carol, showing no handle, follows @bob through the library");
  // Someone with no handle is followed by account.
  await graph.follow(carol.address, { wallet: walletOf(bob) });
  console.log("  admitted: @bob follows Carol's account through the library");
  await until("the follows are mined", async () => (await graph.followers("@bob")).length === 2 && (await graph.followers(carol.address)).length === 1);
  assert.deepEqual(sorted(await graph.followers("@bob")), sorted([alice.address, carol.address]));
  assert.deepEqual(sorted(await graph.followers(bob.address)), sorted([alice.address, carol.address]));
  assert.deepEqual(await graph.followers(carol.address), [bob.address]);
  assert.deepEqual(await graph.following("@ada"), [{ account: bob.address, handle: "bob" }]);
  assert.deepEqual(await graph.following("@bob"), [{ account: carol.address }]);
  assert.deepEqual(await graph.followingAccounts(carol.address), [bob.address]);
  assert.ok(await graph.follows(carol.address, "@bob"));
  assert.ok(!(await graph.follows(bob.address, "@ada")));
  assert.deepEqual(await graph.counts("bob"), { followers: 2, following: 1 });
  assert.deepEqual(await graph.person(carol.address), { account: carol.address });
  assert.equal(await graph.follow("bob", { wallet: walletOf(alice) }), undefined, "already following: nothing sent");
  await assert.rejects(graph.follow("@ada", { wallet: walletOf(alice) }), /yourself/);
  console.log("followers, following and counts read back through the library");

  state = await graph.state({ fresh: true });
  const keys = (a, t, value = "1") => [records.followKey(a, t), records.followerKey(a, t)].map((key) => ({ key, newValue: value }));
  await refused("Bob writes Alice's keys following Carol", bob, { actions: keys(alice.address, carol.address) });
  await refused("Bob deletes Alice's keys following @bob", bob, { actions: [records.followKey(alice.address, "@bob"), records.followerKey(alice.address, "@bob")].map((key) => ({ key, oldValue: "1" })) });
  await refused("Bob follows a target that is neither an account nor a @handle", bob, { actions: [`follows/${bob.address}/Ada`, `followers/Ada/${bob.address}`].map((key) => ({ key, newValue: "1" })) });
  await refused("Bob follows a bare handle without its @", bob, { actions: [`follows/${bob.address}/ada`, `followers/ada/${bob.address}`].map((key) => ({ key, newValue: "1" })) });
  await refused("Bob writes his follow of @ada without its twin", bob, { actions: [keys(bob.address, "@ada")[0]] });
  await refused("Bob lists himself as @ada's follower without following", bob, { actions: [keys(bob.address, "@ada")[1]] });
  await refused("Bob writes the twins with different values", bob, { actions: [keys(bob.address, "@ada")[0], keys(bob.address, "@ada", "2")[1]] });
  await refused("Bob writes the old handle-follows-handle shape", bob, { actions: [`follows/bob/ada/${bob.address}`, `followers/ada/bob/${bob.address}`].map((key) => ({ key, newValue: "1" })) });
  await refused("Bob writes a profile here", bob, { actions: [{ key: "profile/abcdefghij234567", newValue: bob.address }] });

  // Dan follows Alice's account by hand, so her account has a follower of its own.
  await admitted("Dan follows Alice's account", FOLLOWS, dan, { actions: keys(dan.address, alice.address) });
  await until("Dan's follow is mined", async () => (await graph.followers(alice.address)).includes(dan.address));
  // Alice gives @ada to Dan's key: offered, taken, pointed and shown.
  await admitted("Alice offers @ada to Dan", MONIKER, alice, await names.offerName(await moniker.state({ fresh: true }), alice.address, "ada", dan.address));
  await until("@ada is offered", async () => (await moniker.name("ada"))?.offer === dan.address);
  await admitted("Dan takes @ada and shows it", MONIKER, dan, await names.buy(await moniker.state({ fresh: true }), dan.address, "ada", { show: true }));
  await until("@ada shows for Dan", async () => (await moniker.handleOf(dan.address)) === "ada");
  // Carol follows @ada now, so @ada has a follower; then the handle's and the account's split.
  await graph.follow("@ada", { wallet: walletOf(carol) });
  await until("Carol's follow of @ada is mined", async () => (await graph.followers("@ada")).includes(carol.address));
  assert.equal((await graph.person("@ada")).account, dan.address);
  assert.deepEqual(await graph.followers("@ada"), [carol.address], "@ada's followers follow Dan now");
  assert.deepEqual(await graph.followers(alice.address), [dan.address], "Alice's account keeps its own followers");
  assert.deepEqual(await graph.person(alice.address), { account: alice.address });
  // Alice's own follows are her account's: giving a handle away keeps them.
  assert.deepEqual(await graph.following(alice.address), [{ account: bob.address, handle: "bob" }]);
  console.log("@ada given to Dan: its followers follow Dan; Alice's account kept its followers and its follows");

  // Unfollowing deletes every way the account follows someone.
  await admitted("Carol also follows Bob's account", FOLLOWS, carol, { actions: keys(carol.address, bob.address) });
  await until("both of Carol's follows of Bob are mined", async () => (await (await graph.state({ fresh: true })).get(records.followKey(carol.address, bob.address))) !== undefined);
  assert.deepEqual(sorted(await graph.followers("@bob")), sorted([alice.address, carol.address]), "each account once");
  await graph.unfollow(bob.address, { wallet: walletOf(carol) });
  await graph.unfollow(carol.address, { wallet: walletOf(bob) });
  await until("the unfollows are mined", async () => (await graph.followers(bob.address)).length === 1 && (await graph.followers(carol.address)).length === 0);
  assert.deepEqual(await graph.followers(bob.address), [alice.address]);
  assert.deepEqual(await graph.following(carol.address), [{ account: dan.address, handle: "ada" }]);
  const left = await graph.state({ fresh: true });
  assert.equal(await left.get(records.followKey(carol.address, bob.address)), undefined);
  assert.equal(await left.get(records.followKey(carol.address, "@bob")), undefined);
  assert.equal(await graph.unfollow(bob.address, { wallet: walletOf(carol) }), undefined, "nothing left to unfollow");
  console.log("PASS");
} finally {
  for (const step of [["mine", "stop"], ["down"]]) {
    try {
      lattice(...step);
    } catch {}
  }
}
