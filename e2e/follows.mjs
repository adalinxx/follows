// Follows against a real node: a private host mines Nexus, a Follows chain
// launched from chain/spec.json with the built policy, and a Moniker chain
// under Moniker's own policy (e2e/ui/moniker/), both with fast blocks and
// free writes. Alice, Bob and Carol each claim a handle on Moniker. @ada and
// @cara follow @bob, @cara follows @ada, and the library reads both ends of
// the graph from the node. Every way of writing someone else's keys, or a
// record that is not a follow, is refused, and so is half of a follow. Then
// Alice sells @ada to Dan: her follows lapse, @ada's followers stay, and Dan
// follows as @ada through the library while Alice no longer can. Last, Carol
// unfollows @bob.
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
const ownerOf = async (handle) => (await moniker.name(handle))?.owner;

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

  for (const [who, handle] of [[alice, "ada"], [bob, "bob"], [carol, "cara"]]) {
    await admitted(`claims @${handle} on Moniker`, MONIKER, who, await names.claim(await moniker.state({ fresh: true }), who.address, handle));
  }
  await until("the handles are claimed", async () => (await ownerOf("cara")) === carol.address && (await ownerOf("ada")) === alice.address && (await ownerOf("bob")) === bob.address);

  let state = await graph.state({ fresh: true });
  await admitted("@ada follows @bob", FOLLOWS, alice, await records.follow(state, alice.address, "ada", "bob"));
  await admitted("@cara follows @bob", FOLLOWS, carol, await records.follow(state, carol.address, "cara", "bob"));
  await until("both follows are mined", async () => (await graph.followers("bob")).length === 2);
  assert.deepEqual(await graph.followers("@bob"), ["ada", "cara"]);
  assert.deepEqual(await graph.following("@ada"), ["bob"]);
  assert.ok(await graph.follows("cara", "bob"));
  assert.ok(!(await graph.follows("bob", "ada")));
  await graph.follow("cara", "ada", { wallet: walletOf(carol) });
  console.log("  admitted: @cara follows @ada, through the library");
  await until("@cara's follow of @ada is mined", async () => (await graph.followers("ada")).length === 1);
  assert.deepEqual(await graph.followers("ada"), ["cara"]);
  assert.deepEqual(await graph.following("cara"), ["ada", "bob"]);
  assert.deepEqual(await graph.counts("bob"), { followers: 2, following: 0 });
  console.log("@bob's and @ada's followers, and what each follows, read back through the library");

  state = await graph.state({ fresh: true });
  await refused("Bob writes Alice's keys for @ada following @cara", bob, await records.follow(state, alice.address, "ada", "cara"));
  await refused("Bob deletes Alice's keys for @ada following @bob", bob, await records.unfollow(state, alice.address, "ada", "bob"));
  await refused("Bob follows something that is not a handle", bob, { actions: [`follows/bob/Ada/${bob.address}`, `followers/Ada/bob/${bob.address}`].map((key) => ({ key, newValue: "1" })) });
  await refused("Bob writes his follow of @ada without its twin", bob, { actions: [{ key: records.followKey("bob", "ada", bob.address), newValue: "1" }] });
  await refused("Bob lists @bob as @cara's follower without following", bob, { actions: [{ key: records.followerKey("bob", "cara", bob.address), newValue: "1" }] });
  await refused("Bob writes the twins with different values", bob, { actions: [{ key: records.followKey("bob", "ada", bob.address), newValue: "1" }, { key: records.followerKey("bob", "ada", bob.address), newValue: "2" }] });
  await refused("Bob writes a profile here", bob, { actions: [{ key: `profile/abcdefghij234567`, newValue: bob.address }] });

  // Alice sells @ada to Dan.
  await admitted("Alice lists @ada for 0", MONIKER, alice, await names.list(await moniker.state({ fresh: true }), alice.address, "ada", 0n));
  await until("@ada is listed", async () => (await moniker.name("ada"))?.price === 0n);
  await admitted("Dan buys @ada", MONIKER, dan, await names.buy(await moniker.state({ fresh: true }), dan.address, "ada"));
  await until("@ada is Dan's", async () => (await ownerOf("ada")) === dan.address);
  assert.deepEqual(await graph.following("ada"), [], "Alice's follows as @ada lapse");
  assert.deepEqual(await graph.followers("bob"), ["cara"]);
  assert.ok(!(await graph.follows("ada", "bob")));
  assert.deepEqual(await graph.followers("ada"), ["cara"], "@ada's followers stay");
  await assert.rejects(graph.follow("ada", "cara", { wallet: walletOf(alice) }), /@ada isn't yours/);
  await graph.follow("ada", "cara", { wallet: walletOf(dan) });
  console.log("  admitted: Dan follows @cara as @ada, through the library");
  await until("Dan's follow is mined", async () => (await graph.following("ada")).length === 1);
  assert.deepEqual(await graph.following("ada"), ["cara"]);
  assert.deepEqual(await graph.followers("cara"), ["ada"]);
  console.log("@ada sold: Alice's follows lapsed, its followers stayed, and Dan follows as it");

  await graph.unfollow("cara", "bob", { wallet: walletOf(carol) });
  await until("the unfollow is mined", async () => (await graph.followers("bob")).length === 0);
  assert.deepEqual(await graph.following("cara"), ["ada"]);
  console.log("PASS");
} finally {
  for (const step of [["mine", "stop"], ["down"]]) {
    try {
      lattice(...step);
    } catch {}
  }
}
