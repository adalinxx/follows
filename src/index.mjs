// Follows for any app: one follow graph every Lattice app shares, so a
// person's audience comes with them instead of starting at zero in each app.
// A profile follows a profile: Moniker profiles, by id. An app resolves a
// @name to its profile through Moniker first.
//
//   const graph = createFollows({ sdk, moniker });      // sdk: the Lattice SDK module; moniker: createMoniker(…)
//   const ids = await graph.following(p);              // the profiles p follows
//   const fans = await graph.followers(t);             // the profiles following t
//   await graph.follow(p, t, { wallet: window.lattice });
//
// A follow counts while the account that wrote it acts for the following
// profile on Moniker now (owns it, or is its admin): when a profile changes
// hands, the old owner's follows lapse.
//
// Reads go to the first of `nodes` that answers and are checked by CID, so
// they do not depend on trusting that node. Writes go to the wallet, which
// shows them to the person and signs; this library never holds a key.
import * as records from "./records/follows.mjs";
import { anyHost, tip, view, volumeLoader } from "./records/state.mjs";
import { writeRequest } from "./records/wallet.mjs";

/** Where Follows lives now: its testnet trial chain and the shared hosts. */
export const DEFAULTS = {
  chain: ["Nexus", "testnet", "follows-a8fa7f"],
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
  const actsFor = (account, p) => moniker.actsFor(account, p);
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

    /** The profiles profile `p` follows. */
    following: async (p) => records.following(await state(), p, actsFor),
    /** The profiles that follow profile `t`, each once. */
    followers: async (t) => records.followers(await state(), t, actsFor),
    /** Whether profile `p` follows profile `t`. */
    follows: async (p, t) => records.follows(await state(), p, t, actsFor),
    /**
     * What `account` is saving now: follows (`true`) and unfollows (`false`)
     * waiting in the first answering node's mempool, by `"<p>/<t>"`.
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
     * Profile `p` follows profile `t`, written by the connected account, which
     * must act for `p`. Resolves to undefined when its follow is there already.
     */
    follow: async (p, t, { wallet }) => {
      const account = await me(wallet);
      if (!(await actsFor(account, p))) throw new Error("That profile isn't yours");
      return send(wallet, await records.follow(await state({ fresh: true }), account, p, t));
    },
    /** The connected account's follow of `t` as `p` is deleted. Resolves to undefined when there was none. */
    unfollow: async (p, t, { wallet }) => {
      const account = await me(wallet);
      return send(wallet, await records.unfollow(await state({ fresh: true }), account, p, t));
    },
  };
}

export const { isAddress, isProfileId } = records;
