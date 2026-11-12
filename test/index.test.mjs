import assert from "node:assert/strict";
import { test } from "node:test";
import { createFollows, DEFAULTS, isAddress, isHandle } from "../src/index.mjs";

// Enough of the Lattice SDK for createFollows to start; nothing here reads a node.
const sdk = { VolumeClient: class {}, HTTPVolumeTransport: class {}, decodeDagCbor: () => undefined };
const address = "bafyreibc6ggvvnkjlyjghue3qxnagcoprbsh725cutnnnkt3t6dambbt6a";
const other = "bafyreibc6ggvvnkjlyjghue3qxnagcoprbsh725cutnnnkt3t6dambbt6a".replace(/a$/, "e");
// Enough of a Moniker client: @ada points at `other`, which shows it; the account `address` shows no handle.
const moniker = {
  state: async () => ({}),
  pointer: async (h) => (h === "ada" ? other : undefined),
  handlesOf: async (accounts) => accounts.map((a) => (a === other ? "ada" : undefined)),
};

test("needs the SDK and Moniker", () => {
  assert.throws(() => createFollows({ moniker }), /needs \{ sdk \}/);
  assert.throws(() => createFollows({ sdk }), /needs \{ moniker \}/);
});

test("defaults to the testnet trial chain and its shared hosts", () => {
  const graph = createFollows({ sdk, moniker });
  assert.deepEqual(graph.chain, DEFAULTS.chain);
  assert.deepEqual(graph.nodes, DEFAULTS.nodes);
});

test("writes need a wallet; nobody follows themselves", async () => {
  await assert.rejects(createFollows({ sdk, moniker }).follow("@ada", { wallet: undefined }), /Lattice wallet/);
  const wallet = { address: async () => other, writeRecords: async () => assert.fail("sent") };
  await assert.rejects(createFollows({ sdk, moniker }).follow("@ada", { wallet }), /yourself/);
  await assert.rejects(createFollows({ sdk, moniker }).follow("Ada!", { wallet }), /not an account or a handle/);
});

test("a person is an account with the handle it shows, or a handle alone", async () => {
  const graph = createFollows({ sdk, moniker });
  assert.deepEqual(await graph.person("ada"), { account: other, handle: "ada" });
  assert.deepEqual(await graph.person(other), { account: other, handle: "ada" });
  assert.deepEqual(await graph.person(address), { account: address });
  assert.deepEqual(await graph.person("@nobody"), { handle: "nobody" });
  // A handle no account shows follows no one.
  assert.deepEqual(await graph.following("@nobody"), []);
  assert.deepEqual(await graph.followingAccounts("@nobody"), []);
});

test("checks addresses and handles", () => {
  assert.ok(isAddress(address));
  assert.ok(!isAddress("bafyrei"));
  assert.ok(isAddress(other));
  assert.ok(isHandle("ada_1"));
  assert.ok(!isHandle("@ada"));
  assert.ok(!isHandle("Ada"));
  assert.ok(!isHandle(""));
  assert.ok(!isHandle(address.slice(0, 7) + "/x"));
});

// Enough of the SDK to read an empty Follows chain: every Volume is an empty trie root.
const stateSDK = {
  VolumeClient: class {
    get = async () => ({ rootBytes: () => undefined, bytes: () => undefined });
  },
  HTTPVolumeTransport: class {},
  // Every chain is read from the first node given.
  ChainNodes: class {
    constructor(start) {
      this.start = start;
    }
    read = (chain, read) => read({ url: this.start[0], found: false });
  },
  decodeDagCbor: () => ({ count: 0, children: [] }),
  decodeCanonicalBlock: () => ({ postStateCID: "post", specCID: "spec" }),
  decodeCanonicalLatticeState: () => ({ generalStateCID: "root" }),
};
globalThis.fetch = async () => new Response(JSON.stringify({ hash: "tip" }));

test("Selfhold is handed the write at once, as a promise, with no fee proposed", async () => {
  let asked;
  const wallet = {
    isSelfholdWeb: true,
    address: async () => address,
    writeRecords: (request, options) => {
      // Asked before the write is built: handed a promise, not a request.
      assert.ok(request instanceof Promise);
      asked = { request, options };
      return Promise.resolve(request).then((r) => (r === null ? null : { transactionCID: "sent" }));
    },
  };
  const graph = createFollows({ sdk: stateSDK, moniker, nodes: ["http://node.invalid"] });
  const sent = await graph.follow("@ada", { wallet });
  assert.deepEqual(sent, { transactionCID: "sent" });
  assert.equal(asked.options.account, address);
  const request = await asked.request;
  assert.equal(request.fee, undefined, "the wallet pays what the hosts ask");
  assert.deepEqual(request.chainPath, DEFAULTS.chain);
  assert.deepEqual(request.actions.map((a) => a.key), [`follows/${address}/${other}`, `followers/${other}/${address}`] /* the account showing @ada */);
});

test("a wallet that takes only a built request gets one; nothing to write sends nothing", async () => {
  const sent = [];
  const wallet = { address: async () => address, writeRecords: async (request) => (sent.push(request), { transactionCID: "x" }) };
  const graph = createFollows({ sdk: stateSDK, moniker, nodes: ["http://node.invalid"], fee: 2n });
  await graph.follow("@ada", { wallet });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].fee, "2", "a fee given is proposed");
  // Selfhold answers null when nothing needed writing: the library says undefined.
  const selfhold = { isSelfholdWeb: true, address: async () => address, writeRecords: async (r) => ((await r) === null ? null : assert.fail("sent")) };
  assert.equal(await graph.unfollow("@ada", { wallet: selfhold }), undefined);
});
