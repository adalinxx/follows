// Acceptance tests for the Follows site: the real page (app/) in Chromium
// against a private Lattice stack (stack.mjs) with a Follows chain and a
// Moniker chain, seeded below. An account follows an account; a person
// shows by the handle they show on Moniker, or their account's tail. Each test is one thing a person does, checked by what the page then
// shows.
// Following goes through Selfhold's window, where each person makes an
// account with a passkey (Chromium's virtual authenticator) and approves each
// write. Nobody the page signs for holds coins: the stack's fee sponsor pays
// every fee for the device's work. Pop-ups are blocked as for anyone, so a
// window not opened in a click fails a test.
//
//   policy/build.sh
//   cd e2e/ui && npm install && npx playwright install chromium && \
//   LATTICE=<lattice-node>/.build/debug/lattice LATTICE_SPONSOR=<lattice-sponsor> \
//   LATTICE_WALLET_WEB=<selfhold-wallet>/dist-web npm test
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, before, test } from "node:test";
import { chromium, expect as baseExpect } from "playwright/test";
import { approveInSelfhold, client, declineInSelfhold, newAccount, newSelfholdAccount, selfholdRequests, until, windowText, withSelfhold } from "./helpers.mjs";
import { FOLLOWS, MONIKER, start } from "./stack.mjs";

// Reads walk the trie node by node, and writes wait for a block: generous waits.
const expect = baseExpect.configure({ timeout: 60_000 });

// Without a GPU (Linux), Chromium's SwiftShader does the fee's work.
const gpuArgs = process.platform === "linux"
  ? ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan=swiftshader", "--use-webgpu-adapter=swiftshader", "--use-angle=swiftshader"]
  : [];
const HOSTILE = '<img src=x onerror="window.pwned=1">';
const FANS = 60;

let stack;
let c;
let browser;
const p = {}; // the seeded accounts, by name

before(async () => {
  stack = await start();
  c = client(stack.info.node);
  for (const name of ["ada", "bob", "cara", "eve", "solo", "popular", "tara", "swapA", "swapB", "drift", "anon", "quiet", "both"]) p[name] = newAccount();
  p.fans = Array.from({ length: FANS }, newAccount);
  // The accounts written for here pay their fees in coins, from the miner.
  const coins = Object.fromEntries([...Object.values(p).filter((who) => who.address), ...p.fans].map((who) => [who.address, 5n]));
  await stack.info.fund(FOLLOWS, coins);
  await stack.info.fund(MONIKER, coins);
  // Each claims and shows its handle; Anon and Quiet show none.
  await Promise.all(["ada", "bob", "cara", "eve", "solo", "popular", "tara", "drift", "both"].map((name) => c.claim(p[name], name)));
  await c.claim(p.swapA, "swap");
  // A follow is of an account: @ada is Ada's. Quiet, who shows no handle, is followed by account.
  await Promise.all([
    c.follow(p.bob, "@ada", p.quiet.address),
    c.follow(p.cara, "@ada", "@swap"),
    c.follow(p.eve, "@ada"),
    c.follow(p.ada, "@bob", "@eve", "@cara", "@drift"),
    c.follow(p.anon, "@ada"),
  ]);
  // Bob follows Swap A's account by its address; Cara by @swap, which is the same account.
  await c.followAccount(p.bob, p.swapA.address);
  // Many followers: each fan claims a handle, then follows @popular; sent together, then waited for.
  const fanHandle = (i) => `fan_${String(i).padStart(3, "0")}`;
  for (const [i, fan] of p.fans.entries()) await c.submit(MONIKER, fan, await c.claimActions(fan, fanHandle(i)));
  await until("every fan's handle lands", async () => (await (await c.state.moniker()).get(`name/${fanHandle(FANS - 1)}`)) !== undefined && (await (await c.state.moniker()).get(`name/${fanHandle(0)}`)) !== undefined);
  for (const fan of p.fans) await c.submit(FOLLOWS, fan, await c.followActions(fan, "@popular"));
  await until("every fan's follow lands", async () => {
    let n = 0;
    for await (const _ of (await c.state.follows()).list(`followers/${p.popular.address}/`)) n++;
    return n === FANS;
  });
  // Pop-ups blocked as for anyone (Playwright turns the blocker off by
  // default): Selfhold's window opens only from a click, and a test catches
  // one that doesn't.
  browser = await chromium.launch({ args: gpuArgs, ignoreDefaultArgs: ["--disable-popup-blocking"] });
});

after(async () => {
  await browser?.close();
  await stack?.stop();
});

/** An account's tail, as the page shows a person with no handle. */
const tail = (who) => `…${who.address.slice(-4)}`;
const query = (nodes = [stack.info.node]) =>
  `?node=${nodes.join(",")}&chain=${FOLLOWS.join("/")}&moniker=${MONIKER.join("/")}&sponsor=${stack.info.sponsor}&wallet=${stack.info.walletPage}`;
const url = (hash, nodes) => `${stack.info.app}${query(nodes)}${hash}`;

/** The page at `hash` for a visitor with no wallet, with what went wrong in it collected on `page.errors`. */
async function open(hash = "#/", { width = 1100, colorScheme = "light", nodes, before } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 800 }, colorScheme });
  const page = await context.newPage();
  page.errors = [];
  page.on("pageerror", (error) => page.errors.push(String(error)));
  await before?.(page);
  await page.goto(url(hash, nodes));
  return page;
}

/** A person with Selfhold's window, on the page at `hash`, not yet connected. */
async function person(hash = "#/") {
  const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  await withSelfhold(context, stack.info);
  const page = await context.newPage();
  page.errors = [];
  page.on("pageerror", (error) => page.errors.push(String(error)));
  await page.goto(url(hash));
  return page;
}

/** Runs `body` with a person's page at `hash`; on failure, says what Selfhold's window showed. */
async function asPerson(hash, body) {
  const page = await person(hash);
  try {
    await body(page);
    assert.deepEqual(page.errors, []);
  } catch (error) {
    error.message += `\n--- Selfhold's window: ${await windowText(page.context())}`;
    throw error;
  } finally {
    await page.context().close();
  }
}

/** Connects from the front page's You, making a new account with a passkey in Selfhold's window: its address. */
async function connect(page) {
  await page.goto(url("#/"));
  const me = await newSelfholdAccount(page, page.getByRole("button", { name: "Connect Selfhold" }));
  await expect(page.locator(".mine .handle-row")).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect Selfhold" })).toHaveCount(0);
  return me;
}

/**
 * While on, each of the page's reads from the node waits `ms` first: what
 * the page does in a click must not wait for them, or the browser blocks
 * Selfhold's window. Selfhold's own reads, from its window, are not held.
 */
async function slowNode(page, ms = 1500) {
  const slow = { on: false };
  await page.route(`${stack.info.node}/**`, async (route) => {
    if (slow.on) await new Promise((resolve) => setTimeout(resolve, ms));
    await route.continue().catch(() => {});
  });
  return slow;
}

const title = (page) => page.locator("main h1");
const counts = (page) => page.locator(".counts a");
const rows = (page) => page.locator(".people li a strong");
const followButton = (page) => page.locator("follows-button button");
const note = (page) => page.locator("follows-button .note");
/** The list shows exactly `expected`, in any order: a list is in key order, which follows accounts' addresses. */
async function listed(page, expected) {
  await expect(rows(page)).toHaveCount(expected.length);
  assert.deepEqual((await rows(page).allTextContents()).sort(), [...expected].sort());
}
const SAVING = "Saving… about a minute.";
/** Closes the page, which must not have thrown. */
async function close(page) {
  assert.deepEqual(page.errors, []);
  await page.context().close();
}
/** Whether `who` (an account, or its address) holds a follow key for `t` on the chain: an address, or `@h`. */
/** Whether `who` follows `t`: an account, or a seeded @handle, which stands for the account it was claimed by. */
const keyed = (who, t) => c.keyed(typeof who === "string" ? { address: who } : who, t.startsWith("@") ? p[t.slice(1)].address : t);

// ---------------------------------------------------------------- finding people

test("the front page says what Follows is and puts the cursor in the search", async () => {
  const page = await open();
  await expect(title(page)).toHaveText("One follow list for every app.");
  await expect(page.locator("#search")).toBeFocused();
  await expect(page.locator("#search")).toHaveAttribute("placeholder", "Search @handle");
  await expect(page.locator(".recent")).toHaveCount(0);
  // Not connected: You offers Selfhold's window, and says nothing costs coins.
  await expect(page.locator(".mine")).toContainText("No coins needed");
  await expect(page.getByRole("button", { name: "Connect Selfhold" })).toBeVisible();
  await close(page);
});

test("a @handle opens its page: counts, Follow, and its Moniker page", async () => {
  const page = await open();
  await page.fill("#search", "@ada");
  await page.press("#search", "Enter");
  await expect(title(page)).toHaveText("@ada");
  await expect(counts(page)).toHaveText(["4 followers", "4 following"]);
  await expect(followButton(page)).toHaveText("Follow @ada");
  await expect(page.getByRole("link", { name: "Moniker page" })).toHaveAttribute("href", "https://app.moniker.bio/#/%40ada");
  // A person with a handle shows by it, and the search field is clear again.
  await expect(page.locator("main")).not.toContainText("bafyrei");
  await expect(page.locator("#search")).toHaveValue("");
  assert.match(page.url(), /#\/%40ada$/);
  await close(page);
});

test("a handle may be typed without @ and in capitals", async () => {
  for (const typed of ["ada", "ADA", "  @Ada "]) {
    const page = await open();
    await page.fill("#search", typed);
    await page.press("#search", "Enter");
    await expect(title(page)).toHaveText("@ada");
    await close(page);
  }
});

test("an account is found by its address, and one that shows a handle opens by its handle", async () => {
  let page = await open();
  await page.fill("#search", p.quiet.address);
  await page.press("#search", "Enter");
  await expect(title(page)).toHaveText(`Account ${tail(p.quiet)}`);
  await expect(counts(page)).toHaveText(["1 follower", "0 following"]);
  // Someone with no handle is followed by account: the button names no one.
  await expect(followButton(page)).toHaveText("Follow");
  await expect(page.getByRole("link", { name: "Moniker page" })).toHaveCount(0);
  await close(page);
  page = await open(`#/${p.ada.address}`);
  await expect(title(page)).toHaveText("@ada");
  await expect(counts(page)).toHaveText(["4 followers", "4 following"]);
  await close(page);
});

test("a search that is neither a handle nor an account says how to search, as text", async () => {
  const page = await open();
  await page.fill("#search", "ada lovelace");
  await page.press("#search", "Enter");
  await expect(page.locator("main")).toHaveText("“ada lovelace” isn't a @handle or an account. Handles look like @name.");
  await page.fill("#search", HOSTILE);
  await page.press("#search", "Enter");
  await expect(page.locator("main")).toHaveText(`“${HOSTILE}” isn't a @handle or an account. Handles look like @name.`);
  assert.equal(await page.locator('main img[src="x"]').count(), 0);
  assert.equal(await page.evaluate(() => window.pwned), undefined);
  await close(page);
});

test("a handle no one holds says so", async () => {
  const page = await open("#/@nobody_has_this");
  await expect(page.locator("main")).toHaveText("No one holds @nobody_has_this.");
  await close(page);
});

test("people you visit are listed under Recently viewed, by handle or account", async () => {
  const page = await open("#/@ada");
  await expect(title(page)).toHaveText("@ada");
  await page.goto(url(`#/${p.quiet.address}`));
  await expect(title(page)).toHaveText(`Account ${tail(p.quiet)}`);
  await page.goto(url("#/"));
  await expect(page.locator(".recent strong")).toHaveText([tail(p.quiet), "@ada"]);
  await page.locator(".recent a").first().click();
  await expect(title(page)).toHaveText(`Account ${tail(p.quiet)}`);
  await close(page);
});

// ---------------------------------------------------------------- lists

test("the followers count opens the list of people, each linking to their page", async () => {
  const page = await open("#/@ada");
  await counts(page).first().click();
  assert.match(page.url(), /#\/%40ada\/followers$/);
  await expect(title(page)).toHaveText("@ada's followers");
  // Anon follows with no handle of its own: shown by its account's tail.
  await listed(page, ["@bob", "@cara", "@eve", tail(p.anon)]);
  // A short list needs no filter.
  await expect(page.locator("#filter")).toHaveCount(0);
  await page.getByRole("link", { name: "@bob" }).click();
  await expect(title(page)).toHaveText("@bob");
  await page.goBack();
  await expect(title(page)).toHaveText("@ada's followers");
  await page.getByRole("link", { name: tail(p.anon) }).click();
  await expect(title(page)).toHaveText(`Account ${tail(p.anon)}`);
  assert.match(page.url(), new RegExp(`#/${p.anon.address}$`));
  await page.goBack();
  await page.getByRole("link", { name: "‹ @ada" }).click();
  await expect(title(page)).toHaveText("@ada");
  await close(page);
});

test("the following count lists whom they follow; one who stops showing a handle is listed by account", async () => {
  await c.stopShowing(p.drift);
  const page = await open("#/@ada/following");
  await expect(title(page)).toHaveText("@ada follows");
  await listed(page, ["@bob", "@cara", "@eve", tail(p.drift)]);
  await expect(page.getByRole("link", { name: "@cara" })).toHaveAttribute("href", "#/%40cara");
  // Drift's account, showing no handle, keeps Ada's follow.
  await page.getByRole("link", { name: tail(p.drift) }).click();
  await expect(title(page)).toHaveText(`Account ${tail(p.drift)}`);
  await expect(counts(page)).toHaveText(["1 follower", "0 following"]);
  // @drift's page: no account shows it, so there is no one to follow.
  await page.goto(url("#/@drift"));
  await expect(title(page)).toHaveText("@drift");
  await expect(page.locator(".person")).toContainText("No account shows @drift now, so there is no one to follow.");
  await expect(counts(page)).toHaveText(["0 followers", "0 following"]);
  await expect(page.locator("follows-button")).toBeHidden();
  await close(page);
});

test("someone with no follows either way shows both empty lists", async () => {
  let page = await open("#/@solo");
  await expect(counts(page)).toHaveText(["0 followers", "0 following"]);
  await counts(page).first().click();
  await expect(page.locator(".people")).toHaveText("No followers yet.");
  await close(page);
  page = await open("#/@solo/following");
  await expect(page.locator(".people")).toHaveText("Not following anyone yet.");
  await close(page);
});

test(`a long list (${FANS} followers) shows 50 at a time, and its filter looks through everyone`, async () => {
  const page = await open("#/@popular/followers");
  await expect(page.locator(".people li")).toHaveCount(50);
  await page.getByRole("button", { name: `Show ${FANS - 50} more` }).click();
  await expect(page.locator(".people li")).toHaveCount(FANS);
  await page.reload();
  await expect(page.locator(".people li")).toHaveCount(50);
  // The filter looks past the 50 shown.
  await page.fill("#filter", "@FAN_059");
  await expect(rows(page)).toHaveText(["@fan_059"]);
  await expect(page.getByRole("button", { name: /^Show \d+ more$/ })).toBeHidden();
  await expect(page.locator("#results")).toHaveText("1 result");
  await page.fill("#filter", "fan_00");
  await expect(rows(page)).toHaveCount(10);
  await page.fill("#filter", "zz_zz");
  await expect(page.locator(".people")).toHaveText("No one here matches “zz_zz”.");
  await page.fill("#filter", "");
  await expect(page.locator(".people li")).toHaveCount(50);
  await close(page);
});

test("counts read naturally", async () => {
  const page = await open("#/@eve");
  await expect(counts(page)).toHaveText(["1 follower", "1 following"]);
  await close(page);
});

// ---------------------------------------------------------------- handles that move

test("a handle given to another key: the followers stay with the old account, and @handle names the new one", async () => {
  let page = await open("#/@swap/followers");
  await listed(page, ["@bob", "@cara"]);
  await close(page);
  await c.give(p.swapA, "swap", p.swapB);
  // @swap is Swap B's account now, which nobody follows yet.
  page = await open("#/@swap");
  await expect(counts(page)).toHaveText(["0 followers", "0 following"]);
  // Swap A's account, showing no handle now, keeps both its followers.
  await page.goto(url(`#/${p.swapA.address}`));
  await expect(title(page)).toHaveText(`Account ${tail(p.swapA)}`);
  await expect(counts(page)).toHaveText(["2 followers", "0 following"]);
  await page.goto(url(`#/${p.swapA.address}/followers`));
  await listed(page, ["@bob", "@cara"]);
  // Bob's list shows Swap A's account by its tail now.
  await page.goto(url("#/@bob/following"));
  await listed(page, ["@ada", tail(p.quiet), tail(p.swapA)]);
  await close(page);
});

test("an unfollow shows on the next visit", async () => {
  const page = await open("#/@eve");
  await expect(counts(page).first()).toHaveText("1 follower");
  await c.unfollow(p.ada, "@eve");
  await page.reload();
  await expect(counts(page).first()).toHaveText("0 followers");
  await close(page);
});

// ---------------------------------------------------------------- reading from nodes

test("moving on before a page loads shows the newer one, not the slower one", async () => {
  const held = [];
  let hold = true;
  const page = await open("#/", {
    before: (page) => page.route(`${stack.info.node}/**`, (route) => (hold ? held.push(route) : route.continue())),
  });
  await page.evaluate(() => (location.hash = "#/@ada"));
  await until("@ada's page asks the node", async () => held.length > 0, 10);
  await page.evaluate(() => (location.hash = "#/@bob"));
  hold = false;
  for (const route of held.splice(0)) await route.continue();
  await expect(title(page)).toHaveText("@bob");
  await page.waitForTimeout(3000);
  await expect(title(page)).toHaveText("@bob");
  await close(page);
});

test("when the first node is down, the page reads from the next", async () => {
  const page = await open("#/@ada", { nodes: ["http://127.0.0.1:9", stack.info.node] });
  await expect(title(page)).toHaveText("@ada");
  await expect(counts(page).first()).toHaveText(/\d+ followers?/);
  await close(page);
});

test("when no node answers, the page says so, and Try again works once one does", async () => {
  let down = true;
  const page = await open("#/@ada", {
    before: (page) => page.route(`${stack.info.node}/**`, (route) => (down ? route.abort() : route.continue())),
  });
  await expect(page.locator("main")).toContainText("Couldn't reach Follows.");
  down = false;
  await page.click("text=Try again");
  await expect(title(page)).toHaveText("@ada");
  await close(page);
});

test("on a phone, nothing scrolls sideways", async () => {
  for (const hash of ["#/", "#/@ada", "#/@popular/followers", "#/@ada/following", `#/${p.quiet.address}`]) {
    const page = await open(hash, { width: 360 });
    if (hash !== "#/") await expect(title(page)).not.toHaveText("");
    await page.waitForTimeout(500);
    const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
    assert.ok(scroll <= width, `${hash}: ${scroll} > ${width}`);
    await close(page);
  }
});

test("in dark mode the page is dark, and the Follow button readable", async () => {
  const page = await open("#/@ada", { colorScheme: "dark" });
  await expect(title(page)).toHaveText("@ada");
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(18, 20, 24)");
  await expect(followButton(page)).toHaveText("Follow @ada");
  assert.equal(await followButton(page).evaluate((b) => getComputedStyle(b).color), "rgb(18, 20, 24)");
  await close(page);
});

test("a malformed link shows a message, not a blank page", async () => {
  const page = await open("#/%E0");
  await expect(page.locator("main")).toContainText("isn't a @handle or an account");
  await close(page);
});

// ---------------------------------------------------------------- following, with Selfhold's window

test("following: Follow connects Selfhold first, the next press follows, the fee is paid in work, then Saved", async () => {
  await asPerson("#/@tara", async (page) => {
    await expect(counts(page).first()).toHaveText(/^\d+ followers?$/);
    const before = Number((await counts(page).first().textContent()).match(/\d+/)[0]);
    await expect(followButton(page)).toHaveText("Follow @tara");
    await expect(followButton(page)).toHaveAccessibleName("Follow @tara");
    // Connecting takes the click Selfhold's window needs: nothing is sent yet.
    const me = await newSelfholdAccount(page, followButton(page));
    await expect(note(page)).toHaveText("Connected. Press Follow to follow.");
    await expect(followButton(page)).toHaveText("Follow @tara");
    assert.ok(!(await keyed(me, "@tara")));
    await approveInSelfhold(page, followButton(page));
    await expect(followButton(page)).toHaveText("Following @tara");
    await expect(followButton(page)).toHaveAccessibleName("Following @tara");
    await expect(note(page)).toHaveText("Saved.", { timeout: 180_000 });
    // "Saved." only once the chain holds it: the handle, followed by the account.
    assert.ok(await keyed(me, "@tara"));
    await expect(counts(page).first()).toHaveText(`${before + 1} follower${before === 0 ? "" : "s"}`);
    // No coins: the sponsor paid the fee for this device's work.
    assert.equal(await c.coins(FOLLOWS, me), 0n);
    assert.equal(await selfholdRequests(page), 2);
    await expect(note(page)).toHaveText("", { timeout: 10_000 });
  });
});

test("Selfhold's window opens in the click though the node is slow, and no handle is needed to follow", async () => {
  await asPerson("#/", async (page) => {
    const slow = await slowNode(page);
    const me = await connect(page);
    await page.goto(url("#/@tara"));
    await expect(followButton(page)).toHaveText("Follow @tara");
    // Every read takes 1.5 s now: the follow's reads, together, far longer than a click lets a window wait.
    slow.on = true;
    await approveInSelfhold(page, followButton(page));
    slow.on = false;
    await expect(note(page)).toHaveText("Saved.", { timeout: 180_000 });
    assert.ok(await keyed(me, "@tara"));
    await page.goto(url("#/@tara/followers"));
    await expect(rows(page).filter({ hasText: tail({ address: me }) })).toHaveCount(1);
  });
});

test("someone with no handle is followed by account, from their page", async () => {
  await asPerson("#/", async (page) => {
    const me = await connect(page);
    await page.goto(url(`#/${p.quiet.address}`));
    await expect(counts(page)).toHaveText(["1 follower", "0 following"]);
    await expect(followButton(page)).toHaveText("Follow");
    await approveInSelfhold(page, followButton(page));
    await expect(followButton(page)).toHaveText("Following");
    await expect(note(page)).toHaveText("Saved.", { timeout: 180_000 });
    assert.ok(await keyed(me, p.quiet.address));
    await expect(counts(page)).toHaveText(["2 followers", "0 following"]);
    // Quiet shows a handle later: the follow by account still counts.
    await c.claim(p.quiet, "quiet");
    // A new visit: the page reuses a read of Moniker for a few seconds.
    await page.goto(url("#/@quiet"));
    await page.reload();
    await expect(counts(page)).toHaveText(["2 followers", "0 following"]);
    await expect(followButton(page)).toHaveText("Following @quiet");
  });
});

test("Following shows Unfollow under a mouse, and pressing it unfollows", async () => {
  await asPerson("#/", async (page) => {
    const me = await connect(page);
    await page.goto(url("#/@tara"));
    await approveInSelfhold(page, followButton(page));
    await expect(note(page)).toHaveText("Saved.", { timeout: 180_000 });
    await expect(followButton(page)).toHaveText("Following @tara");
    await followButton(page).hover();
    await expect(followButton(page).locator(".now")).toBeHidden();
    assert.equal(await followButton(page).evaluate((b) => getComputedStyle(b, "::after").content), '"Unfollow @tara"');
    await approveInSelfhold(page, followButton(page));
    await expect(followButton(page)).toHaveText("Follow @tara");
    await expect(note(page)).toHaveText(SAVING);
    await expect(note(page)).toHaveText("Saved.", { timeout: 180_000 });
    assert.ok(!(await keyed(me, "@tara")));
  });
});

test("following by handle follows the account: it stays followed when the handle stops showing, and unfollows in one write", async () => {
  await asPerson("#/", async (page) => {
    const me = await connect(page);
    await page.goto(url("#/@both"));
    await approveInSelfhold(page, followButton(page));
    await expect(note(page)).toHaveText("Saved.", { timeout: 180_000 });
    assert.ok(await keyed(me, p.both.address));
    // Both stops showing a handle: still followed, by account.
    await c.stopShowing(p.both);
    await page.goto(url(`#/${p.both.address}`));
    await page.reload();
    await expect(followButton(page)).toHaveText("Following");
    await c.show(p.both, "both");
    await page.goto(url("#/@both"));
    await page.reload();
    await expect(followButton(page)).toHaveText("Following @both");
    const asked = await selfholdRequests(page);
    await approveInSelfhold(page, followButton(page));
    await expect(note(page)).toHaveText("Saved.", { timeout: 180_000 });
    assert.ok(!(await keyed(me, p.both.address)));
    assert.equal(await selfholdRequests(page), asked + 1);
  });
});

test("you on the front page: your account's tail, then a handle claimed in the page, coinlessly, though the node is slow", async () => {
  await asPerson("#/", async (page) => {
    const slow = await slowNode(page);
    const me = await connect(page);
    await expect(page.locator(".mine > h2")).toHaveText("You");
    await expect(page.locator(".mine .handle-row strong")).toHaveText(tail({ address: me }));
    await expect(page.locator(".mine")).toContainText("You show no @handle, so apps show your account's tail.");
    await page.getByRole("button", { name: "Show a handle" }).click();
    const dialog = page.locator("moniker-handle-picker dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Or claim a free one").fill("fresh_one");
    // The claim's reads take far longer than a click lets a window wait.
    slow.on = true;
    await approveInSelfhold(page, dialog.getByRole("button", { name: "Use handle" }));
    slow.on = false;
    // Once Moniker shows it, You shows it.
    await expect(page.locator(".mine .handle-row strong")).toHaveText("@fresh_one", { timeout: 180_000 });
    await expect(page.locator(".mine #pick")).toHaveCount(0);
    assert.equal(await c.coins(MONIKER, me), 0n);
    const mine = page.locator(".mine .handle-row");
    await expect(mine.locator(".row-counts a")).toHaveText(["0 followers", "0 following"]);
    await mine.getByRole("link", { name: /following$/ }).click();
    await expect(title(page)).toHaveText("@fresh_one follows");
    // Your own page, by handle or account, has no Follow button; others' do.
    await page.goto(url("#/@fresh_one"));
    await expect(counts(page).first()).toHaveText(/follower/);
    await expect(page.locator("follows-button")).toBeHidden();
    await page.goto(url(`#/${me}`));
    await expect(title(page)).toHaveText("@fresh_one");
    await expect(page.locator("follows-button")).toBeHidden();
    await page.goto(url("#/@ada"));
    await expect(followButton(page)).toHaveText("Follow @ada");
  });
});

test("declining in Selfhold sends nothing and says so", async () => {
  await asPerson("#/", async (page) => {
    const me = await connect(page);
    await page.goto(url("#/@tara"));
    await expect(followButton(page)).toHaveText("Follow @tara");
    await declineInSelfhold(page, followButton(page));
    await expect(note(page)).toHaveText("Canceled in Selfhold. Nothing was sent.");
    await expect(followButton(page)).toHaveText("Follow @tara");
    assert.ok(!(await keyed(me, "@tara")));
  });
});

test("a follow still waiting for a block shows as saving, on this visit and the next, until it lands", async () => {
  const mining = (verb) => execFileSync(process.env.LATTICE, ["mine", verb, "--root", stack.info.root], { stdio: "pipe" });
  await asPerson("#/", async (page) => {
    await connect(page);
    await page.goto(url("#/@tara"));
    await expect(followButton(page)).toHaveText("Follow @tara");
    mining("stop");
    try {
      await approveInSelfhold(page, followButton(page));
      await expect(note(page)).toHaveText(SAVING);
      // A new visit finds it in the node's mempool.
      await page.reload();
      await expect(followButton(page)).toHaveText("Following @tara");
      await expect(note(page)).toHaveText(SAVING);
      mining("start");
      await expect(note(page)).toHaveText("Saved.", { timeout: 180_000 });
    } finally {
      // Started again however the test went; already running is fine.
      try {
        mining("start");
      } catch {}
    }
  });
});

test("when this site's Selfhold account changes, a press sends nothing, shows that account's follow, and says so", async () => {
  await asPerson("#/", async (page) => {
    await connect(page);
    await page.goto(url("#/@ada"));
    await expect(followButton(page)).toHaveText("Follow @ada");
    // Another of the person's accounts, which follows @ada, is given to this site in another tab.
    await page.evaluate(({ origin, address }) => localStorage.setItem(`selfhold.web.address ${origin}`, address), { origin: page.context().walletOrigin, address: p.bob.address });
    const asked = await selfholdRequests(page);
    await followButton(page).click();
    await expect(note(page)).toHaveText("Selfhold is connected to another account now. Check, then press again.");
    await expect(followButton(page)).toHaveText("Following @ada");
    assert.equal(await selfholdRequests(page), asked);
  });
});

// ---------------------------------------------------------------- in another app: <follows-who>

/** Another app's page (who.html) showing `who`, with `card` as that app's card for them. */
const otherApp = (who, card) =>
  `${new URL("../e2e/ui/who.html", stack.info.app)}${query()}&address=${who.address}${card ? `&card=${encodeURIComponent(JSON.stringify(card))}` : ""}`;

test("in another app, a name opens the same card: the app's name for them, their handle, counts, Follow, links", async () => {
  await asPerson("#/", async (page) => {
    const me = await connect(page);
    await page.goto(otherApp(p.tara, { name: "@Tara <b>Okafor</b>", bio: "Eats @ noon" }));
    const name = page.locator("follows-who moniker-name");
    await expect(name).toContainText("@tara");
    const opener = page.locator("follows-who button.open");
    await expect(opener).toHaveAttribute("aria-expanded", "false");
    await opener.click();
    const card = page.locator("follows-who [popover]");
    await expect(card).toBeVisible();
    await expect(opener).toHaveAttribute("aria-expanded", "true");
    // The app's name, as text, with no @: only the verified handle has one.
    await expect(card.locator(".name")).toHaveText("Tara <b>Okafor</b>");
    await expect(card.locator(".handle")).toHaveText("@tara");
    await expect(card.locator(".bio")).toHaveText("Eats  noon");
    await expect(card.locator(".counts")).toHaveText(/^\d+ followers?\s*\d+ following$/);
    await expect(card.getByRole("link", { name: "Follows page" })).toHaveAttribute("href", /#\/%40tara$/);
    await expect(card.getByRole("link", { name: "Moniker page" })).toHaveAttribute("href", /#\/%40tara$/);
    assert.equal(await page.locator("b", { hasText: "Okafor" }).count(), 0);
    // On screen, under the name.
    const [box, view] = [await card.boundingBox(), page.viewportSize()];
    assert.ok(box.x >= 0 && box.x + box.width <= view.width && box.y >= 0 && box.y + box.height <= view.height, JSON.stringify(box));
    // Follow works from the card.
    const follow = card.locator("follows-button button");
    await expect(follow).toHaveText("Follow @tara");
    await approveInSelfhold(page, follow);
    await expect(card.locator("follows-button .note")).toHaveText("Saved.", { timeout: 180_000 });
    assert.ok(await keyed(me, "@tara"));
    // Escape closes it, and focus goes back to the name.
    await follow.focus();
    await page.keyboard.press("Escape");
    await expect(card).toBeHidden();
    await expect(opener).toBeFocused();
    await expect(opener).toHaveAttribute("aria-expanded", "false");
  });
});

test("in another app, someone with no handle and no card shows by their account's tail", async () => {
  const page = await open();
  await page.goto(otherApp(p.anon));
  await page.locator("follows-who button.open").click();
  const card = page.locator("follows-who [popover]");
  await expect(card.locator(".id")).toHaveText(tail(p.anon));
  await expect(card.locator(".handle")).toHaveCount(0);
  await expect(card).toHaveAttribute("aria-label", `Account ${tail(p.anon)}`);
  await expect(card.getByRole("link", { name: "Follows page" })).toHaveAttribute("href", new RegExp(`#/${p.anon.address}$`));
  await expect(card.getByRole("link", { name: "Moniker page" })).toHaveCount(0);
  await expect(card.locator("follows-button button")).toHaveText("Follow");
  // A press outside closes it.
  await page.mouse.click(5, 300);
  await expect(card).toBeHidden();
  await close(page);
});

test("a link's ?node=, ?chain= and ?moniker= apply to that visit only: nothing about them is stored", async () => {
  const page = await open("#/@ada");
  await expect(title(page)).toHaveText("@ada");
  await page.goto(url("#/"));
  await expect(page.locator(".recent strong")).toHaveText(["@ada"]);
  const stored = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
  assert.deepEqual(Object.keys(stored), ["follows.recent.v2"]);
  for (const value of Object.values(stored)) assert.ok(!value.includes("127.0.0.1") && !value.includes("Nexus"), value);
  // The same page without the params reads the default nodes, not the link's.
  const requests = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.goto(`${stack.info.app}#/@ada`);
  await page.waitForTimeout(1500);
  assert.ok(!requests.some((r) => r.startsWith(stack.info.node)), "read from the link's node after it was left");
  await page.context().close();
});
