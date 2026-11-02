// What the UI tests do outside the page: make accounts and write records the
// way another client would, signed here and sent to the node's public submit,
// each paying the fee of 1 from coins the miner gave it; and drive Selfhold's
// window for the people who use the page.
import * as sdk from "../../vendor/lattice-sdk.js";
import * as follows from "../../src/records/follows.mjs";
import { tip, view, volumeLoader } from "../../src/records/state.mjs";
import { transaction } from "../../src/records/wallet.mjs";
import * as names from "../../app/vendor/moniker-sdk/src/records/names.mjs";
import { FOLLOWS, MONIKER } from "./stack.mjs";

export { sdk };

/** A new account: its address, private key, and the key in hex for Selfhold. */
export function newAccount() {
  const privateKey = sdk.generatePrivateKey();
  return { address: sdk.accountFromPrivateKey(privateKey).address, privateKey, keyHex: Buffer.from(privateKey).toString("hex") };
}

export async function until(label, condition, seconds = 300) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    if (await condition().catch(() => false)) return;
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Writing and reading on the stack's chains, as `node` serves them. */
export function client(node) {
  const states = (chain) => {
    const volumes = new sdk.VolumeClient(new sdk.HTTPVolumeTransport(`${node}/volumes`, { chainPath: chain }));
    const load = volumeLoader(volumes, sdk.decodeDagCbor);
    return async () => view(load, (await tip(sdk, node, chain, volumes)).generalStateCID);
  };
  const state = { follows: states(FOLLOWS), moniker: states(MONIKER) };

  /** Sends `actions` on `chain` signed by `who`; resolves once the node took them. */
  async function submit(chain, who, actions) {
    const account = await fetch(`${node}/api/state/account/${who.address}?chainPath=${chain.join("/")}`).then((r) => (r.ok ? r.json() : {}));
    const body = transaction({ owner: who.address, actions, fee: 1n, nonce: BigInt(account.nonce ?? 0), chainPath: chain });
    const { publicKey, signature } = sdk.signTransactionBody(body, who.privateKey);
    // A public node limits how fast it takes submissions: wait and send again.
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(`${node}/transactions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sdk.transactionPayload({ [publicKey]: signature }, body)),
      });
      if (r.ok) return;
      if ((r.status !== 429 && r.status !== 503) || attempt >= 20) throw new Error(`submit: ${r.status} ${await r.text()}`);
      await new Promise((resolve) => setTimeout(resolve, 1000 * (Number(r.headers.get("retry-after")) || 1 + attempt)));
    }
  }

  /** `actions` on `chain`, signed by `who`, landed. */
  async function write(chain, who, actions) {
    if (actions.length === 0) return;
    await submit(chain, who, actions);
    const read = chain === FOLLOWS ? state.follows : state.moniker;
    await until("records land", async () => {
      const now = await read();
      for (const { key, newValue } of actions) if ((await now.get(key)) !== newValue) return false;
      return true;
    });
  }

  /** Moniker as the records read it, from its tip now. */
  const resolver = async () => {
    const m = await state.moniker();
    return { pointers: (hs) => Promise.all(hs.map((h) => names.pointer(m, h))), handlesOf: (as) => names.handlesOf(m, as) };
  };
  /** The actions for `who` following `t`, an account or a @handle, as the library writes them. */
  const followActions = async (who, t) => (await follows.follow(await state.follows(), await resolver(), who.address, t)).actions;

  return {
    state,
    submit,
    write,
    /** The actions for `who` claiming the free `@handle` and showing it, unsent. */
    claimActions: async (who, handle) => (await names.claim(await state.moniker(), who.address, handle, { show: true })).actions,
    /** `who` claims the free `@handle` on Moniker and shows it. */
    claim: async (who, handle) => write(MONIKER, who, (await names.claim(await state.moniker(), who.address, handle, { show: true })).actions),
    /** `who` stops showing its handle: apps show its account's tail. */
    stopShowing: async (who) => write(MONIKER, who, (await names.stopShowing(await state.moniker(), who.address)).actions),
    /** `who` shows `@handle` again, a name it owns. */
    show: async (who, handle) => write(MONIKER, who, (await names.showName(await state.moniker(), who.address, handle)).actions),
    /** The coins `address` holds on `chain`. */
    coins: async (chain, address) => {
      const r = await fetch(`${node}/api/state/account/${address}?chainPath=${chain.join("/")}`);
      return r.ok ? BigInt((await r.json()).balance ?? 0) : 0n;
    },
    /** `from` gives `@handle` to `to`, who takes it and shows it. */
    give: async (from, handle, to) => {
      await write(MONIKER, from, (await names.offerName(await state.moniker(), from.address, handle, to.address)).actions);
      await write(MONIKER, to, (await names.buy(await state.moniker(), to.address, handle, { show: true })).actions);
    },
    /** `who` follows each of `targets` (accounts, or @handles for the accounts showing them) as the library would, in one transaction. */
    follow: async (who, ...targets) => {
      const actions = [];
      for (const t of targets) actions.push(...(await followActions(who, t)));
      await write(FOLLOWS, who, actions);
    },
    followActions,
    /** `who` follows `account` by its account, whatever handle it shows. */
    followAccount: async (who, account) =>
      write(FOLLOWS, who, [follows.followKey(who.address, account), follows.followerKey(who.address, account)].map((key) => ({ key, newValue: "1" }))),
    unfollow: async (who, t) => write(FOLLOWS, who, (await follows.unfollow(await state.follows(), await resolver(), who.address, t)).actions),
    /** Whether `who` holds a follow key for account `t`. */
    keyed: async (who, t) => (await (await state.follows()).get(follows.followKey(who.address, t))) === "1",
  };
}

// ------------------------------------------------- Selfhold's window, with a passkey

const REQUESTS = "follows-test-selfhold"; // sessionStorage: the page's requests to Selfhold's window so far

/**
 * Makes `context` one person with a passkey in Selfhold's window at
 * `walletPage`. Chromium's virtual authenticator belongs to one page, and a
 * passkey made in one window derives no key in another, so every window the
 * page opens is one window, kept open: each request navigates it, `?n=`
 * counting them. As that window is reused, which the browser would allow
 * any time, an open outside a click's moment (no transient user activation)
 * is refused here as the browser refuses a new one: it fails.
 */
export async function withSelfhold(context, { app, walletPage }) {
  const walletOrigin = new URL(walletPage).origin;
  context.walletOrigin = walletOrigin;
  await context.addInitScript((origin) => {
    if (location.origin === origin) window.close = () => {};
  }, walletOrigin);
  await context.addInitScript(({ key, port }) => {
    if (location.port !== port) return;
    const open = window.open.bind(window);
    window.open = (url, _name, features) => {
      // The window is reused, and the browser blocks only new ones: refuse,
      // as it would, an open outside a click's moment.
      if (!navigator.userActivation.isActive) return null;
      const to = new URL(url);
      const n = Number(sessionStorage.getItem(key) ?? 0) + 1;
      sessionStorage.setItem(key, String(n));
      to.searchParams.set("n", String(n));
      return open(to.href, "selfhold-test", features);
    };
  }, { key: REQUESTS, port: new URL(app).port });
  const arm = () => (context.selfhold = new Promise((resolve) => {
    const opened = async (popup) => {
      if (!(await popup.opener().catch(() => null))) return;
      context.off("page", opened);
      const cdp = await context.newCDPSession(popup);
      await cdp.send("WebAuthn.enable");
      await cdp.send("WebAuthn.addVirtualAuthenticator", {
        options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
      });
      // Closed (a write with nothing to send, or one the page couldn't build): the next request opens another.
      popup.on("close", () => arm());
      resolve(popup);
    };
    context.on("page", opened);
  }));
  arm();
}

/** How many times the page has opened Selfhold's window. */
export const selfholdRequests = (page) => page.evaluate((key) => Number(sessionStorage.getItem(key) ?? 0), REQUESTS);

/** The account Selfhold's window gave this site, as the page remembers it, or null. */
export const selfholdAccount = (page) => page.evaluate((origin) => localStorage.getItem(`selfhold.web.address ${origin}`), page.context().walletOrigin);

/** Presses `button` on `page`, and resolves with Selfhold's window once it shows this request. */
export async function inSelfhold(page, button) {
  const n = (await selfholdRequests(page)) + 1;
  await button.click();
  const opened = await page.context().selfhold;
  await until(`Selfhold's window, request ${n}`, async () => new URL(opened.url()).searchParams.get("n") === String(n), 30);
  // Its approving button wakes only in a focused window.
  await opened.bringToFront();
  await opened.locator("button").first().waitFor({ timeout: 30_000 }).catch(() => {});
  return opened;
}

/** Presses `button`, and in Selfhold's window makes a new account with a passkey and connects it here. Its address. */
export async function newSelfholdAccount(page, button) {
  const opened = await inSelfhold(page, button);
  await opened.getByRole("button", { name: "Create an account" }).click();
  await opened.getByRole("button", { name: "Connect", exact: true }).click();
  await until("Selfhold's account, here", async () => Boolean(await selfholdAccount(page)), 30);
  await page.bringToFront();
  return selfholdAccount(page);
}

/** Presses `button`, then approves the write in Selfhold's window with the passkey; resolves once the window says it was sent. */
export async function approveInSelfhold(page, button) {
  const opened = await inSelfhold(page, button);
  await opened.getByRole("button", { name: "Approve with your passkey" }).click();
  await opened.getByRole("heading", { name: "Sent" }).waitFor({ timeout: 180_000 });
  await page.bringToFront();
  return opened;
}

/** Presses `button`, then declines the write in Selfhold's window. */
export async function declineInSelfhold(page, button) {
  const opened = await inSelfhold(page, button);
  await opened.getByRole("button", { name: "Decline" }).click();
  await page.bringToFront();
  return opened;
}

/** What Selfhold's window shows now, for a failure's message. */
export const windowText = async (context) => {
  const opened = await Promise.race([context.selfhold, new Promise((resolve) => setTimeout(() => resolve(null), 100))]);
  return opened ? (await opened.locator("body").innerText().catch(() => "?")).replace(/\s+/g, " ").slice(0, 400) : "(no window)";
};
