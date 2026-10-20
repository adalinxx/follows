# Follows

One follow graph that every app shares. Follow someone once, and every app
that reads Follows knows it. Your audience comes with you, so you don't start
at zero in each app.

Follows is its own Lattice chain. It holds follows and nothing else.

## Records

| Key | Present while | Who may write |
| --- | --- | --- |
| `user/<a>/follows/<b>` | `<a>` follows `<b>` | `<a>` |

`<a>` and `<b>` are account addresses. A follow is one record, written or
deleted only by the follower, and clients write `"1"` as its value. The chain
gives values no meaning.

- **Whom `<a>` follows**: the keys under `user/<a>/follows/`, one prefix read.
- **Who follows `<b>`**: every key ending in `/follows/<b>`. Since the chain
  holds only follows, that read is the whole graph, so it grows with the graph.

Names and photos for these addresses come from
[Moniker](https://github.com/adalinxx/moniker), the profile chain.

## Use Follows in your app

```js
import { createFollows } from "https://cdn.jsdelivr.net/gh/adalinxx/follows@v0.1.0/src/browser.mjs";

const graph = createFollows();                    // testnet trial by default; or { nodes, chain }
const people = await graph.following(address);    // whom they follow
const audience = await graph.followers(address);  // who follows them
await graph.follows(a, b);                        // true or false

const wallet = window.lattice;                    // Selfhold
await graph.follow(address, { wallet });          // undefined if already following
await graph.unfollow(address, { wallet });
```

Reads go to the first node that answers. Every trie node is checked against
its CID, so a read doesn't depend on trusting the node that served it. Writes
go to the person's wallet, which shows each one and signs it. The library
never holds a key. Writes are free on the testnet trial.

In Node, or with your own copy of the Lattice SDK, import `src/index.mjs` and
pass the SDK in: `createFollows({ sdk })`.

## Layout

- `policy/`: the chain's validity policy (Rust, built to wasm). It uses the
  shared rules crate from Moniker. `policy/host-check` replays the test
  contexts through Lattice's own evaluator.
- `chain/spec.json`: the chain spec, which names the policy module by CID.
- `src/`: the library. `src/records/follows.mjs` holds the records,
  `state.mjs` reads state by walking down the trie, and `wallet.mjs` builds
  the wallet request. `state.mjs` and `wallet.mjs` are copied from
  moniker-sdk.
- `vendor/lattice-sdk.js`: the Lattice SDK, bundled for browsers.

## Test

```sh
(cd policy && cargo build --release --target wasm32-unknown-unknown)
npm test                                          # the policy, and the records through it
LATTICE=<lattice-node>/.build/debug/lattice node e2e/follows.mjs   # against a real node

CONTEXT_DIR=.contexts node --test test/policy.test.mjs
(cd policy/host-check && swift run -c release host-check \
  ../target/wasm32-unknown-unknown/release/follows_policy.wasm ../../.contexts)
```

The e2e test launches the chain from `chain/spec.json` on a private node.
Alice and Carol follow Bob, and the test reads both ends of the graph. Each
way of writing someone else's follow is refused. Then Alice unfollows Bob.
