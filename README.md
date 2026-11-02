# Follows

One follow graph that every app shares. Follow someone once, and every app
that reads Follows knows it. Your audience comes with you, so you don't start
at zero in each app.

Follows is its own Lattice chain. It holds follows and nothing else.

## Records

An account follows an account. People may be named by a handle, a name on
[Moniker](https://github.com/adalinxx/moniker), the names chain: an account
owns `@<h>` there, points it at an account, and an account shows `@<h>` in
every app while it names `h` and `h` points back at it. A handle is
lowercase letters, digits and `_`. Accounts never need a handle to follow.

Account `<a>` following account `<t>` is two keys, so that each end of the
graph is one prefix read:

| Key | Lists |
| --- | --- |
| `follows/<a>/<t>` | whom `<a>` follows: read `follows/<a>/` |
| `followers/<t>/<a>` | who follows `<t>`: read `followers/<t>/` |

`<a>` signs: only it writes or deletes its keys, always both in one
transaction, to the same value, the `followers/` key directly after its
`follows/` twin; clients write `"1"`. The chain starts with neither, so the
two lists always agree. The policy checks only these shapes, that both ends
are account addresses, and that `<a>` signs: a handle is never a key.

This chain can't see Moniker, so clients resolve handles: `@h` stands for
the account it points at, while that account shows `h`, the same test every
app uses to show `@h` beside an account. Following `@h` follows that
account, as it is when the follow is made. So:

- A person's followers are the accounts following their account.
- When a handle moves to another key (given, sold, or its owner moving to a
  new key), the follows stay with the accounts: the old account keeps its
  followers and its follows, and `@h` names the new key, followed by no one
  until someone follows it.
- A handle no account shows names no one, and can't be followed.

## The page

Live at https://adalinxx.github.io/follows/app/, reading the Follows testnet
trial and Moniker on `Nexus/moniker`.

`app/` is a static page: search a `@handle` or an account to see how many
follow them and how many they follow, and both lists. People show by the
handle they show, or by their account's last four characters when they show
none; each links to their page, and long lists have a filter. Follow them
with the button: no handle needed, and no coins. Writes go to Selfhold's
window at `wallet.selfhold.app`: a passkey makes the account, with nothing to
install, and the fee sponsor
(`https://lattice-testnet-apps-iad.fly.dev:8650/sponsor`, lattice-sponsor)
takes a moment of the device's work for each fee. Its client is
`app/vendor/selfhold.mjs`, the same build Stoa and Moniker vendor;
`?sponsor=` names another sponsor (empty for none: the account's coins pay)
and `?wallet=` another Selfhold window. With Selfhold connected, the front page
shows you, with your counts and lists; showing no handle, it offers Moniker's
handle picker to claim or show one without leaving the page. Who shows which
handle is read from Moniker through
[moniker-sdk](https://github.com/adalinxx/moniker-sdk), a submodule at
`app/vendor/moniker-sdk`: clone with `--recurse-submodules`. Links:
`#/@handle`, `#/<account>`, and `/followers` or `/following` after either.

```sh
python3 -m http.server 8767   # from the repository root, then open http://127.0.0.1:8767/app/
```

## Use Follows in your app

```js
import { createFollows, defineFollowButton, defineWho } from "https://cdn.jsdelivr.net/gh/adalinxx/follows@v0.4.0/src/browser.mjs";
import { createMoniker } from "https://cdn.jsdelivr.net/gh/adalinxx/moniker-sdk@2c3491b/src/browser.mjs";
import { selfhold } from "./selfhold.mjs";        // @selfhold/web, from selfhold-wallet

const moniker = createMoniker();                   // Nexus/moniker
const graph = createFollows({ moniker });          // testnet trial by default; or { nodes, chain }
await graph.person("@ada");                        // { account, handle: "ada" }, or { handle } if no account shows it
await graph.following(address);                    // whom it follows: [{ account, handle? }, …]
await graph.followingAccounts(address);            // the accounts it follows, each once: build a feed from these
await graph.followers("@ada");                     // the accounts following the account showing @ada
await graph.counts(address);                       // { followers, following }
await graph.follows(address, "@bob");              // true or false

// Selfhold's window, its fees paid with the device's work through a fee sponsor:
const wallet = selfhold({ use: "window", hosts: () => graph.nodes, sponsor: () => SPONSOR });
await wallet.connect();                            // from a click
await graph.follow("@bob", { wallet });            // from a later click: the account showing @bob; undefined if already
await graph.unfollow(bobAddress, { wallet });      // deletes this account's keys for Bob
```

Anywhere a person goes, an account address or a handle (with or without
`@`) will do; a handle spelled like an address needs its `@`. Nobody follows
themselves.

The wallet picks the fee: Follows proposes none unless `createFollows` is
given a `fee`. Selfhold's window opens only in direct answer to a click, so
`follow` and `unfollow` hand it the write as a promise at once and read the
chain while it opens; connect in an earlier click, since connecting uses that
click up. Any other wallet with `writeRecords`, such as Selfhold for Chrome
(`window.lattice`, which pays fees in coins), is asked once the write is
built.

### Showing people in your app

Key your records by account, as every Lattice app does, and show an account
by your app's own card for it and the handle it shows
(`moniker.handleOf(address)`, or `<moniker-name>` from moniker-sdk). Rank or
filter by `graph.followingAccounts(reader)`, and show a person's
`graph.counts(address)`.

A Follow button for any page, which asks Selfhold only when pressed:

```js
defineFollowButton(graph, { wallet: () => wallet });  // without it, Selfhold for Chrome
```

```html
<follows-button target="@ada"></follows-button>
<follows-button target="bafyrei…"></follows-button>
```

It reads "Follow @ada" / "Following @ada", or just "Follow" for someone who
shows no handle. It follows the person's account as the connected account,
and hides on that account's own page and for a handle no account shows. A
press that has to connect Selfhold's window first connects, shows where the
account stands, and asks for one more press.

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

The same card about a person in every app: wrap a name in `<follows-who>`,
and pressing it opens your app's name, photo and bio for them, the handle
they show (or their account's tail), their counts, a Follow button, and
links to their Follows and Moniker pages.

```js
defineWho(graph, { card: async (address) => ({ name, photo, bio }), wallet: () => wallet });   // your app's card, or undefined
```

```html
<follows-who address="bafyrei…"><moniker-name address="bafyrei…" name="Dana" plain></moniker-name></follows-who>
```

What it wraps sits inside a button, so wrap a name without a link of its own.
Card text is shown as text with every `@` dropped, so only a verified handle
shows with one. It closes on Escape or a press outside, and focus goes back
to the name. Style it with the button's properties and `--follows-surface`.

Reads go to the first node that answers. Every trie node is checked against
its CID, so a read doesn't depend on trusting the node that served it.
Handles are resolved from one Moniker state, all at once. Writes go to the
person's wallet, which shows each one and signs it. The library never holds
a key. The hosts ask a fee on each write, which the fee sponsor pays for
work.

In Node, or with your own copy of the Lattice SDK, import `src/index.mjs` and
pass the SDK in: `createFollows({ sdk, moniker })`. `moniker` needs only
`state()`, `pointer(handle)` and `handlesOf(addresses)`, as `createMoniker`
returns them.

## Layout

- `policy/`: the chain's validity policy (Rust, built to wasm). It uses the
  shared rules crate from Moniker. `policy/host-check` replays the test
  contexts through Lattice's own evaluator.
- `chain/spec.json`: the chain spec, which names the policy module by CID;
  `chain/follows_policy.wasm` is that module, built.
- `src/`: the library. `src/element.mjs` is `<follows-button>`, `src/who.mjs` is `<follows-who>`. `src/records/follows.mjs` holds the records,
  `state.mjs` reads state by walking down the trie, and `wallet.mjs` builds
  the wallet request. `state.mjs` and `wallet.mjs` are copied from
  moniker-sdk.
- `vendor/lattice-sdk.js`: the Lattice SDK, bundled for browsers.

## Test

```sh
policy/build.sh                                   # the module, naming no machine
npm test                                          # the policy, and the records through it
LATTICE=<lattice-node>/.build/debug/lattice node e2e/follows.mjs   # against a real node

CONTEXT_DIR=.contexts node --test test/policy.test.mjs
(cd policy/host-check && swift run -c release host-check \
  ../target/wasm32-unknown-unknown/release/follows_policy.wasm ../../.contexts)
```

The page's acceptance tests run it in Chromium against a private node with a
Follows chain and a Moniker chain (under the module `Nexus/moniker` launched
with, copied into `e2e/ui/moniker/`), both asking a fee of 1 as the testnet
hosts do; a fee sponsor (lattice-sponsor) that pays it for work; and
Selfhold's window (selfhold-wallet's `dist-web/`, served on `localhost`):

```sh
cd e2e/ui && npm install && npx playwright install chromium && \
  LATTICE=<lattice-node>/.build/debug/lattice LATTICE_SPONSOR=<lattice-sponsor> \
  LATTICE_WALLET_WEB=<selfhold-wallet>/dist-web npm test
```

`LATTICE_SPONSOR` defaults to `lattice-sponsor` beside `lattice`. Each person
makes an account with a passkey in Selfhold's window (Chromium's virtual
authenticator) and approves each write there; nobody the page signs for holds
coins, and tests check they still hold none. Pop-ups are blocked as for
anyone, and some tests hold every read the page makes for 1.5 s, so a window
not opened in the click fails. They cover search by handle and by account,
both lists with people shown by handle or account tail, counts, the filter,
navigation and links, empty lists, hostile input, a handle no account shows
(no one to follow), a handle given to another key (the old account keeps its
followers), unfollows, connecting from Follow and following on the next
press, following with no handle, following an account with no handle, a
follow by handle staying with the account, you on the front page and claiming a handle with
its picker, declining in Selfhold, your own page, a long list, a follow
pending in the mempool, a changed account, `<follows-who>` in another app's
page, a slow page overtaken by a newer one, dead nodes, phone width and dark
mode.

The e2e test launches the chain from `chain/spec.json` and a Moniker chain on
a private node. Alice and Bob show @ada and @bob; Carol shows none. Alice and
Carol follow @bob, Bob follows Carol's account, and the test reads both ends
of the graph; following `@bob` writes Bob's account. Writing someone else's
keys, following anything but an account (a `@handle` included), half of a
follow, or twins with different values is refused. Then Alice gives @ada to
Dan: Alice's account keeps its followers and follows, and following @ada
now follows Dan. Last, Bob unfollows Carol.
