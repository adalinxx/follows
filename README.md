# Follows

One follow graph that every app shares. Follow someone once, and every app
that reads Follows knows it. Your audience comes with you, so you don't start
at zero in each app.

Follows is its own Lattice chain. It holds follows and nothing else.

## Records

A handle follows a handle. Handles are names on
[Moniker](https://github.com/adalinxx/moniker), the names chain: an account
(a key, never shown) owns `@<h>` as `name/<h>` there, and may sell it or
give it away. A handle is lowercase letters, digits and `_`. Profiles live on
each app's own chain; Follows has none of its own, and no account follows an
account.

A follow of `@<t>` by `@<h>`, written by account `<a>`, is two keys, so that
each end of the graph is one prefix read:

| Key | Lists |
| --- | --- |
| `follows/<h>/<t>/<a>` | what `@<h>` follows: read `follows/<h>/` |
| `followers/<t>/<h>/<a>` | who follows `@<t>`: read `followers/<t>/` |

`<a>` signs: only it writes or deletes its keys, always both in one
transaction, to the same value, the `followers/` key directly after its
`follows/` twin; clients write `"1"`. The chain starts with neither, so the
two lists always agree. The policy checks only these shapes and that `<a>`
signs.

This chain can't see Moniker, so it can't check that `<a>` owns `@<h>`.
Readers do: a follow counts only while `<a>` owns `@<h>` on Moniker **now**,
one `name/<h>` read (`<a>`, `<a>@<price>` or `<a>><taker>`). Nothing older is
looked at. So when `@tess` is sold, the follows written as `@tess` lapse
and its new owner starts fresh; whoever follows `@tess` still does, since a
follow is of the handle. Count handles, not keys: each counts once.

## The page

Live at https://adalinxx.github.io/follows/app/, reading the testnet trial.

`app/` is a static page: search a `@handle` to see how many handles follow
it and how many it follows, and both lists, each `@handle` linked to its own
page, with a filter on long lists. Follow it as one of your handles (a
picker says which when you have several); with none, the page says to get
one on Moniker first. With Selfhold connected, the front page lists your
handles with their counts and lists. Accounts are never shown. Who owns a
handle is read from Moniker through
[moniker-sdk](https://github.com/adalinxx/moniker-sdk), a submodule at
`app/vendor/moniker-sdk`: clone with `--recurse-submodules`. Links:
`#/@handle`, `#/@handle/followers` and `#/@handle/following`.

```sh
python3 -m http.server 8767   # from the repository root, then open http://127.0.0.1:8767/app/
```

## Use Follows in your app

```js
import { createFollows } from "https://cdn.jsdelivr.net/gh/adalinxx/follows@v0.3.0/src/browser.mjs";
import { createMoniker } from "https://cdn.jsdelivr.net/gh/adalinxx/moniker-sdk@v0.2.0/src/browser.mjs";

const moniker = createMoniker();
const graph = createFollows({ moniker });          // testnet trial by default; or { nodes, chain }
const followed = await graph.following("@ada");    // the handles @ada follows: ["bob", …]
const fans = await graph.followers("@ada");        // the handles that follow @ada
await graph.counts("@ada");                        // { followers, following }
await graph.follows("@ada", "@bob");               // true or false
await graph.handlesOf(address);                    // an account's handles: the ones it follows as

const wallet = window.lattice;                     // Selfhold
await graph.follow("@ada", "@bob", { wallet });    // as @ada, which the account must own; undefined if already
await graph.unfollow("@ada", "@bob", { wallet });  // deletes this account's keys only
```

Handles come back bare (`"bob"`); they are taken with or without `@`.

### Showing followers in your app

Your app's profiles live on your chain, and a profile shows `@h` while it
names `h` and Moniker points `h` back at it (moniker-sdk's `createProfiles`
checks both: `p.handle`). Followers are of the handle, so show
`graph.followers(p.handle)` and `graph.counts(p.handle)` on a profile that
shows one; a profile without a handle has no followers here. To show a
follower as your app's profile, look up the profile its handle points at
on your chain (`people.profileOf("@" + h)`), else just `@h`.

A Follow button for any page, which asks Selfhold only when pressed:

```js
import { createFollows, defineFollowButton } from "https://cdn.jsdelivr.net/gh/adalinxx/follows@v0.3.0/src/browser.mjs";

defineFollowButton(createFollows({ moniker }));
```

```html
<follows-button target="@ada"></follows-button>
```

It reads "Follow @ada" / "Following @ada". The follower is one of the
connected account's handles: its one, or, with several, the one picked
under the button ("as @bob"), remembered in this browser. An account with no
handle is told to get one on Moniker first (`defineFollowButton(graph, {
monikerURL })`). It hides on your own handles.

A follow takes about a block (a minute on the trial) to save. The button
turns at once and its note says "Saving… about a minute." until a block
holds it, then "Saved.", and it fires `follows:change`. A follow still
waiting in a node's mempool shows as saving too, even one sent from another
app or device: `graph.pending(account)` finds them. With no wallet it fires
`follows:needs-wallet`; handle that event to show your own help, or the button
explains how to add Selfhold (and, on a phone, to use a computer). Style it
with `--follows-accent`, `--follows-accent-ink`, `--follows-ink`,
`--follows-line`, `--follows-muted`, `--follows-width` and
`--follows-note-align`.

Reads go to the first node that answers. Every trie node is checked against
its CID, so a read doesn't depend on trusting the node that served it. Owners
are read from one Moniker state, one `name/<h>` read per handle, all at once.
Writes go to the person's wallet, which shows each one and signs it. The
library never holds a key. Writes are free on the testnet trial.

In Node, or with your own copy of the Lattice SDK, import `src/index.mjs` and
pass the SDK in: `createFollows({ sdk, moniker })`. `moniker` needs only
`state()` and `names(address)`, as `createMoniker` returns them.

## Layout

- `policy/`: the chain's validity policy (Rust, built to wasm). It uses the
  shared rules crate from Moniker. `policy/host-check` replays the test
  contexts through Lattice's own evaluator.
- `chain/spec.json`: the chain spec, which names the policy module by CID;
  `chain/follows_policy.wasm` is that module, built.
- `src/`: the library. `src/element.mjs` is `<follows-button>`. `src/records/follows.mjs` holds the records,
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

The page's acceptance tests run it in Chromium against a private node with a
Follows chain and a Moniker chain (under Moniker's own policy, copied into
`e2e/ui/moniker/`):

```sh
cd e2e/ui && npm install && \
  LATTICE=<lattice-node>/.build/debug/lattice LATTICE_WALLET=<selfhold>/dist npm test
```

Following goes through the real Selfhold extension, holding each person's
key. They cover search by handle, both lists, counts, the filter, navigation
and links, empty lists, hostile input, self-follows, keys written as a handle
the signer doesn't own, a sold handle's follows lapsing while its followers
stay, unfollows, the as-picker, the no-handle note, your handles on the front
page, declining in Selfhold, a long list, a follow pending in the mempool, a
slow page overtaken by a newer one, dead nodes, phone width and dark mode.

The e2e test launches the chain from `chain/spec.json` and a Moniker chain on
a private node. @ada and @cara follow @bob, and the test reads both ends of
the graph. Writing someone else's keys, a key that isn't a handle, half of a
follow, or twins with different values is refused. Then Alice sells @ada to
Dan: her follows as @ada lapse, @ada's followers stay, and Dan follows as
@ada while Alice no longer can. Last, @cara unfollows @bob.
