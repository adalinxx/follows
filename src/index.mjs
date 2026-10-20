// Follows for any app: one follow graph every Lattice app shares, so a
// person's audience comes with them instead of starting at zero in each app.
//
//   const graph = createFollows({ sdk });               // sdk: the Lattice SDK module
//   const people = await graph.following(address);     // whom they follow
//   const audience = await graph.followers(address);   // who follows them
//   await graph.follow(address, { wallet: window.lattice });
//
// Reads go to the first of `nodes` that answers and are checked by CID, so
// they do not depend on trusting that node. Writes go to the wallet, which
// shows them to the person and signs; this library never holds a key.
import * as records from "./records/follows.mjs";
import { anyHost, tip, view, volumeLoader } from "./records/state.mjs";
import { writeRequest } from "./records/wallet.mjs";

/** Where Follows lives now: its testnet trial chain and the shared hosts. */
export const DEFAULTS = {
  chain: ["Nexus", "testnet", "follows-bff4ba"],
  nodes: ["https://lattice-testnet-apps-iad.fly.dev", "https://lattice-testnet-apps-ams.fly.dev"],
  // The trial chain's hosts admit 0-fee transactions: writes are free.
  fee: 0n,
  // How long a read state is reused before asking for the tip again.
  freshFor: 10_000,
};

export function createFollows(options) {
  const { sdk, chain, nodes, fee, freshFor } = { ...DEFAULTS, ...options };
  if (!sdk) throw new Error("createFollows needs { sdk }: the Lattice SDK module");
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

    /** The addresses `address` follows. */
    following: async (address) => records.following(await state(), address),
    /** The addresses that follow `address`. */
    followers: async (address) => records.followers(await state(), address),
    /** Whether `follower` follows `followed`. */
    follows: async (follower, followed) => records.follows(await state(), follower, followed),

    /** The connected account follows `address`. Resolves to undefined when it already does. */
    follow: async (address, { wallet }) => {
      const follower = await me(wallet);
      return send(wallet, await records.follow(await state({ fresh: true }), follower, address));
    },
    /** The connected account stops following `address`. Resolves to undefined when it did not. */
    unfollow: async (address, { wallet }) => {
      const follower = await me(wallet);
      return send(wallet, await records.unfollow(await state({ fresh: true }), follower, address));
    },
  };
}

export const { isAddress } = records;
