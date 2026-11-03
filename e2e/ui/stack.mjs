// A private stack for the UI tests: one Lattice host mining Nexus, a Follows
// chain from chain/spec.json and a Moniker chain under Moniker's own policy
// (moniker/: the module Nexus/moniker launched with), both with 2-second blocks and a
// fee of 1, as the testnet hosts ask; a fee sponsor (lattice-sponsor) that
// pays that fee for a device's work; Selfhold's window, served on localhost;
// and a static server for the repository, so the real app/ page runs against
// them. The miner's coins fund the sponsor, and the accounts the tests write
// for with keys of their own.
//
//   LATTICE=<lattice-node>/.build/debug/lattice
//   LATTICE_SPONSOR=<lattice-sponsor>                (default: beside lattice)
//   LATTICE_WALLET_WEB=<selfhold-wallet>/dist-web    (Selfhold's window, built)
import { execFileSync, spawn } from "node:child_process";
import { createReadStream, existsSync, mkdtempSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

export const FOLLOWS = ["Nexus", "follows"];
export const MONIKER = ["Nexus", "moniker"];
const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const repo = here("../../");
const ports = { listen: 28501, rpc: 28580, publicRead: 28581, web: 28590, sponsor: 28591, wallet: 28592 };

const types = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json",
  ".woff2": "font/woff2", ".txt": "text/plain", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".wasm": "application/wasm",
};

/** Serves `root`, the repository's by default, as GitHub Pages does. */
function serve(port, root = repo) {
  const server = createServer((request, response) => {
    const path = normalize(decodeURIComponent(new URL(request.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
    let file = join(root, path);
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!file.startsWith(join(root, "/")) || !existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    createReadStream(file).pipe(response);
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

async function until(label, condition, seconds = 300) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    if (await condition().catch(() => false)) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

export async function start() {
  const walletWeb = process.env.LATTICE_WALLET_WEB && resolvePath(process.env.LATTICE_WALLET_WEB);
  if (!walletWeb || !existsSync(join(walletWeb, "index.html"))) throw new Error("LATTICE_WALLET_WEB: Selfhold's window, built (selfhold-wallet's dist-web/)");
  const sdk = await import("../../vendor/lattice-sdk.js");
  const root = mkdtempSync(`${tmpdir()}/follows-ui-`);
  const lattice = (...args) => execFileSync(process.env.LATTICE, [...args, "--root", root], { encoding: "utf8" });
  const configure = (edit) => {
    const file = `${root}/lattice.json`;
    const topology = JSON.parse(readFileSync(file, "utf8"));
    edit(topology);
    writeFileSync(file, JSON.stringify(topology, null, 2));
  };
  lattice("init");
  configure((t) => {
    Object.assign(t, { listen: ports.listen, rpc: ports.rpc, publicRead: ports.publicRead, webSocket: 0, publicSubmit: true });
    // As the testnet hosts: a fee of 1, which an account with no coins pays
    // in work, through the sponsor.
    t.minRelayFee = 1;
    // Reads are many (one per trie node): no rate ceilings in the way.
    t.publicReadExpensiveRate = 10000;
    t.publicReadRate = 10000;
    t.publicReadMaxRate = 100000;
    t.peers = [];
    t.mine = { worker: "cpu", workers: 1, batchSize: 100000 };
  });
  lattice("up");
  const fast = (file) => {
    const spec = { ...JSON.parse(readFileSync(file, "utf8")), targetBlockTime: 2000, premine: 0 };
    const out = `${root}/${spec.wasmPolicies[0].moduleCID}.json`;
    writeFileSync(out, JSON.stringify(spec));
    return out;
  };
  lattice("child", "create", FOLLOWS.join("/"), "--spec", fast(here("../../chain/spec.json")),
    "--policy-module", here("../../policy/target/wasm32-unknown-unknown/release/follows_policy.wasm"));
  lattice("child", "create", MONIKER.join("/"), "--spec", fast(here("moniker/spec.json")), "--policy-module", here("moniker/moniker_policy.wasm"));
  // Merged mining pays Follows' and Moniker's rewards to the miner, whose
  // coins fund the sponsor and the accounts the tests sign for.
  const minerKey = sdk.generatePrivateKey();
  const miner = sdk.accountFromPrivateKey(minerKey);
  const nobody = sdk.accountFromPrivateKey(new Uint8Array(32).fill(7)).address;
  configure((t) => {
    t.mine.recipients = { Nexus: nobody, [FOLLOWS.join("/")]: miner.address, [MONIKER.join("/")]: miner.address };
  });
  lattice("mine", "start");
  const node = `http://127.0.0.1:${ports.publicRead}`;
  const height = async (chain) => {
    const r = await fetch(`${node}/api/block/latest?chainPath=${chain.join("/")}`);
    return r.ok ? Number((await r.json()).height) : -1;
  };
  const balance = async (address, chain) => {
    const r = await fetch(`${node}/api/state/account/${address}?chainPath=${chain.join("/")}`);
    return r.ok ? BigInt((await r.json()).balance ?? 0) : 0n;
  };
  let sponsor = null;
  const halt = () => {
    sponsor?.kill();
    for (const step of [["mine", "stop"], ["down"]]) {
      try {
        lattice(...step);
      } catch {}
    }
  };
  const sponsorURL = `http://127.0.0.1:${ports.sponsor}`;
  let sponsorAddress;
  try {
    await until("Follows and Moniker blocks", async () => (await height(FOLLOWS)) >= 1 && (await height(MONIKER)) >= 1);
    await until("the miner's coins on Follows and Moniker", async () =>
      (await balance(miner.address, FOLLOWS)) >= MINED && (await balance(miner.address, MONIKER)) >= MINED, 600);
    // The sponsor: it pays a fee of 1 on each chain for small shares of
    // work, from a float the miner sends it there.
    const sponsorKey = `${root}/sponsor-key.json`;
    execFileSync(process.env.LATTICE, ["key", "generate", "--out", sponsorKey]);
    sponsorAddress = JSON.parse(readFileSync(sponsorKey, "utf8")).address;
    for (const chain of [FOLLOWS, MONIKER]) await pay(sdk, node, miner, minerKey, chain, { [sponsorAddress]: 500n });
    const log = openSync(`${root}/sponsor.log`, "a");
    sponsor = spawn(process.env.LATTICE_SPONSOR || join(dirname(process.env.LATTICE), "lattice-sponsor"), [
      "--node", `http://127.0.0.1:${ports.rpc}`, "--cookie-file", `${root}/chains/Nexus/.cookie`, "--key", sponsorKey,
      "--share-work", "2^12", "--fee", "1", "--port", String(ports.sponsor),
    ], { stdio: ["ignore", log, log] });
    await until("the sponsor prices Follows and Moniker", async () => {
      for (const chain of [FOLLOWS, MONIKER]) {
        const r = await fetch(`${sponsorURL}/work`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chain: chain.join("/") }) });
        if (!r.ok) return false;
      }
      return true;
    }, 180);
  } catch (error) {
    halt();
    throw error;
  }
  const web = await serve(ports.web);
  // Selfhold's window, on localhost, where passkeys work and the app (on 127.0.0.1) is another site.
  const wallet = await serve(ports.wallet, walletWeb);
  const info = {
    root,
    node,
    rpc: `http://127.0.0.1:${ports.rpc}`,
    cookie: () => readFileSync(`${root}/chains/Nexus/.cookie`, "utf8").trim(),
    app: `http://127.0.0.1:${ports.web}/app/`,
    sponsor: sponsorURL,
    sponsorAddress,
    walletPage: `http://localhost:${ports.wallet}/`,
    /** The miner pays each of `to` (address → coins) on `chain`, in one transaction, and it lands. */
    fund: (chain, to) => pay(sdk, node, miner, minerKey, chain, to),
  };
  return {
    info,
    stop: async () => {
      wallet.close();
      web.close();
      halt();
    },
  };
}

// What the miner holds on each chain before the stack is ready: the sponsor's
// float and the coins the tests' own accounts are given.
const MINED = 3000n;

/** The miner pays each of `to` (address → coins) on `chain` in one transaction, and waits until every payment lands. */
async function pay(sdk, node, miner, minerKey, chain, to) {
  const read = async (address) => {
    const r = await fetch(`${node}/api/state/account/${address}?chainPath=${chain.join("/")}`);
    return r.ok ? r.json() : {};
  };
  const before = Object.fromEntries(await Promise.all(Object.keys(to).map(async (a) => [a, BigInt((await read(a)).balance ?? 0)])));
  const total = Object.values(to).reduce((sum, amount) => sum + amount, 0n);
  const body = {
    accountActions: [{ owner: miner.address, delta: -(total + 1n) }, ...Object.entries(to).map(([owner, delta]) => ({ owner, delta }))],
    actions: [],
    depositActions: [],
    receiptActions: [],
    withdrawalActions: [],
    signers: [miner.address],
    nonce: BigInt((await read(miner.address)).nonce ?? 0),
    chainPath: [...chain],
  };
  const { publicKey, signature } = sdk.signTransactionBody(body, minerKey);
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`${node}/transactions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sdk.transactionPayload({ [publicKey]: signature }, body)) });
    if (r.ok) break;
    if ((r.status !== 429 && r.status !== 503) || attempt >= 20) throw new Error(`pay on ${chain.join("/")}: ${r.status} ${await r.text()}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  await until(`payments on ${chain.join("/")}`, async () => {
    for (const [address, amount] of Object.entries(to)) if (BigInt((await read(address)).balance ?? 0) < before[address] + amount) return false;
    return true;
  });
}
