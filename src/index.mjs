// Follows for any app: one follow graph every Lattice app shares, so a
// person's audience comes with them instead of starting at zero in each app.
// A handle follows a handle: Moniker names, which accounts own.
//
//   const graph = createFollows({ sdk, moniker });      // sdk: the Lattice SDK module; moniker: createMoniker(…)
//   const hs = await graph.following("@ada");          // the handles @ada follows
//   const fans = await graph.followers("@bob");        // the handles following @bob
//   await graph.follow("@ada", "@bob", { wallet: window.lattice });
//
// A follow counts only while the account that wrote it owns the following
// handle on Moniker now: when a handle is sold, its old owner's follows
// lapse, and its followers stay.
//
// Reads go to the first of `nodes` that answers and are checked by CID, so
// they do not depend on trusting that node. Writes go to the wallet, which
// shows them to the person and signs; this library never holds a key.
import * as records from "./records/follows.mjs";
import { anyHost, tip, view, volumeLoader } from "./records/state.mjs";
import { writeRequest } from "./records/wallet.mjs";

const { bare } = records;

/** Where Follows lives now: its testnet trial chain and the shared hosts. */
export const DEFAULTS = {
  chain: ["Nexus", "testnet", "follows-4dabde"],
  nodes: ["https://lattice-testnet-apps-iad.fly.dev", "https://lattice-testnet-apps-ams.fly.dev"],
  // The trial chain's hosts admit 0-fee transactions: writes are free.
  fee: 0n,
  // How long a read state is reused before asking for the tip again.
  freshFor: 10_000,
};

export function createFollows(options) {
  const { sdk, moniker, chain, nodes, fee, freshFor } = { ...DEFAULTS, ...options };
  if (!sdk) throw new Error("createFollows needs { sdk }: the Lattice SDK module");
  if (!moniker) throw new Error("createFollows needs { moniker }: createMoniker from moniker-sdk");
  /** Each handle's owner on Moniker now, or undefined, in order: one `name/<h>` read each, from one state. */
  const owners = async (handles, { fresh = false } = {}) => {
    // A fresh state is the one owners() then reads.
    if (fresh) await moniker.state({ fresh: true });
    return moniker.owners(handles);
  };
  const volumes = new sdk.VolumeClient(anyHost(nodes.map((node) => new sdk.HTTPVolumeTransport(`${node}/volumes`, { chainPath: chain }))));
  const load = volumeLoader(volumes, sdk.decodeDagCbor);

  let current = null; // { at, state: Promise }
  /** The chain's state at the tip of the first node that answers, reused for `freshFor` ms. */
  function state({ fresh = false } = {}) {
    if (!fresh && current && Date.now() - current.at < freshFor) return current.state;
    const read = (async () => {
      let failure;
      for (const node of nodes) {
        try {
          const { generalStateCID } = await tip(sdk, node, chain, volumes);
          return view(load, generalStateCID);
        } catch (error) {
          failure = error;
        }
      }
      throw new Error(`No node is serving ${chain.join("/")}`, { cause: failure });
    })();
    current = { at: Date.now(), state: read };
    read.catch(() => current?.state === read && (current = null));
    return read;
  }

  const needWallet = (wallet) => {
    if (!wallet?.writeRecords) throw new Error("This needs a Lattice wallet such as Selfhold (window.lattice).");
    return wallet;
  };
  const me = async (wallet) => (await needWallet(wallet).address?.()) ?? (await wallet.connect());
  /** Sends `write` to the wallet unless there is nothing to write; resolves to its answer, or undefined. */
  const send = (wallet, write) => (write.actions.length > 0 ? needWallet(wallet).writeRecords(writeRequest(chain, write, fee)) : undefined);

  return {
    chain,
    nodes,
    state,
    moniker,

    /** The handles `@h` follows, bare, in order. */
    following: async (h) => records.following(await state(), bare(h), owners),
    /** The handles that follow `@t`, bare, in order, each once. */
    followers: async (t) => records.followers(await state(), bare(t), owners),
    /** How many handles follow `@h`, and how many it follows: `{ followers, following }`. */
    counts: async (h) => {
      const s = await state();
      const [followers, following] = await Promise.all([records.followers(s, bare(h), owners), records.following(s, bare(h), owners)]);
      return { followers: followers.length, following: following.length };
    },
    /** Whether `@h` follows `@t`. */
    follows: async (h, t) => records.follows(await state(), bare(h), bare(t), owners),
    /** The handles an account owns on Moniker, bare: the ones it may follow as. `fresh` reads Moniker's tip anew. */
    handlesOf: async (address, { fresh = false } = {}) => {
      // A fresh state is the one names() then reads.
      if (fresh) await moniker.state({ fresh: true });
      return (await moniker.names(address)).map((name) => name.handle);
    },
    /**
     * What `account` is saving now: follows (`true`) and unfollows (`false`)
     * waiting in the first answering node's mempool, by `"<h>/<t>"`.
     */
    pending: async (account) => {
      for (const node of nodes) {
        try {
          const url = new URL("/api/mempool", node);
          url.searchParams.set("chainPath", chain.join("/"));
          const response = await fetch(url, { cache: "no-store" });
          if (!response.ok) continue;
          const { transactions = [] } = await response.json();
          // A few at a time: a full mempool must not flood the reader.
          const bodies = [];
          let next = 0;
          await Promise.all(
            Array.from({ length: Math.min(8, transactions.length) }, async () => {
              while (next < transactions.length) {
                const cid = transactions[next++];
                try {
                  // A transaction's volume carries its body.
                  const volume = await volumes.get(cid);
                  bodies.push(sdk.decodeDagCbor(volume.bytes(sdk.decodeDagCbor(volume.rootBytes()).body.rawCID)));
                } catch {}
              }
            }),
          );
          return records.pendingIn(bodies, account);
        } catch {}
      }
      return {};
    },

    /**
     * `@h` follows `@t`, written by the connected account, which must own `@h`
     * on Moniker. Resolves to undefined when its follow is there already.
     */
    follow: async (h, t, { wallet }) => {
      const account = await me(wallet);
      const [owner] = await owners([bare(h)], { fresh: true });
      if (owner !== account) throw new Error(`@${bare(h)} isn't yours`);
      return send(wallet, await records.follow(await state({ fresh: true }), account, bare(h), bare(t)));
    },
    /** The connected account's follow of `@t` as `@h` is deleted. Resolves to undefined when there was none. */
    unfollow: async (h, t, { wallet }) => {
      const account = await me(wallet);
      return send(wallet, await records.unfollow(await state({ fresh: true }), account, bare(h), bare(t)));
    },
  };
}

export const { isAddress, isHandle } = records;
