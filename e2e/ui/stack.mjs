// A private stack for the UI tests: one Lattice host mining Nexus, a Follows
// chain from chain/spec.json and a Moniker chain under Moniker's own policy
// (moniker/, copied from the Moniker repo), both with 2-second blocks and
// free writes; and a static server for the repository, so the real app/
// page runs against them.
//
//   LATTICE=<lattice-node>/.build/debug/lattice
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

export const FOLLOWS = ["Nexus", "follows"];
export const MONIKER = ["Nexus", "moniker"];
const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const repo = here("../../");
const ports = { listen: 28501, rpc: 28580, publicRead: 28581, web: 28590 };

const types = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json",
  ".woff2": "font/woff2", ".txt": "text/plain",
};

/** Serves the repository root, as GitHub Pages does. */
function serve(port) {
  const server = createServer((request, response) => {
    const path = normalize(decodeURIComponent(new URL(request.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
    let file = join(repo, path);
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!file.startsWith(repo) || !existsSync(file)) {
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
    // As the trial hosts: any fee is admitted, so writing is free.
    t.minRelayFee = 0;
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
  // Merged mining pays each chain's reward somewhere: an address nobody holds.
  const nobody = (await import("../../vendor/lattice-sdk.js")).accountFromPrivateKey(new Uint8Array(32).fill(7)).address;
  configure((t) => {
    t.mine.recipients = { Nexus: nobody, [FOLLOWS.join("/")]: nobody, [MONIKER.join("/")]: nobody };
  });
  lattice("mine", "start");
  const node = `http://127.0.0.1:${ports.publicRead}`;
  const height = async (chain) => {
    const r = await fetch(`${node}/api/block/latest?chainPath=${chain.join("/")}`);
    return r.ok ? Number((await r.json()).height) : -1;
  };
  const halt = () => {
    for (const step of [["mine", "stop"], ["down"]]) {
      try {
        lattice(...step);
      } catch {}
    }
  };
  try {
    await until("Follows and Moniker blocks", async () => (await height(FOLLOWS)) >= 1 && (await height(MONIKER)) >= 1);
  } catch (error) {
    halt();
    throw error;
  }
  const web = await serve(ports.web);
  const info = {
    root,
    node,
    rpc: `http://127.0.0.1:${ports.rpc}`,
    cookie: () => readFileSync(`${root}/chains/Nexus/.cookie`, "utf8").trim(),
    app: `http://127.0.0.1:${ports.web}/app/`,
  };
  return {
    info,
    stop: async () => {
      web.close();
      halt();
    },
  };
}
