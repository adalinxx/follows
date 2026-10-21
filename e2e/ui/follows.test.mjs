// Acceptance tests for the Follows site: the real page (app/) in Chromium
// against a private Lattice stack (stack.mjs) with a Follows chain and a
// Moniker chain, seeded below. Profiles follow profiles; a follow counts
// while the account that wrote it acts for the following profile. Each test
// is one thing a person does, checked by what the page then shows. Following goes through a stand-in for the Selfhold wallet
// (withWallet); Moniker's suite runs the same button with the real one.
//
//   (cd policy && cargo build --release --target wasm32-unknown-unknown)
//   cd e2e/ui && npm install && LATTICE=<lattice-node>/.build/debug/lattice npm test
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, before, test } from "node:test";
import { chromium, expect as baseExpect } from "playwright/test";
import * as profileRecords from "../../app/vendor/moniker-sdk/src/records/profile.mjs";
import { client, newAccount, pinMedia, until } from "./helpers.mjs";
import { FOLLOWS, MONIKER, start } from "./stack.mjs";

// Reads walk the trie node by node: generous waits.
const expect = baseExpect.configure({ timeout: 30_000 });

// A 1×1 PNG, and an SVG: a document that could run script, never shown as a photo.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="window.pwned=1"/>');
const HOSTILE = '<img src=x onerror="window.pwned=1">Eve';
const FANS = 150;

let stack;
let c;
let browser;
const p = {}; // the seeded accounts, by name
const P = {}; // their profiles' ids, by name

/** A new account with a profile of its own: `{ ...account, id }`. */
async function withProfile(card, handle) {
  const who = newAccount();
  return { ...who, id: await c.profile(who, card, handle) };
}

before(async () => {
  stack = await start();
  c = client(stack.info.node);
  for (const name of ["ada", "bob", "cara", "dan", "eve", "solo", "one", "narc", "swapA", "swapB", "popular", "tara", "org", "staff", "two"]) p[name] = newAccount();
  const [png, svg] = [await pinMedia(stack.info, "image/png", PNG), await pinMedia(stack.info, "image/svg+xml", SVG)];
  const made = await Promise.all([
    c.profile(p.ada, { name: "Ada Lovelace", avatar: png }, "ada"),
    c.profile(p.bob, { name: "Bob Stone" }, "bob"),
    c.profile(p.cara, { name: "Cara Diaz" }, "cara"),
    c.profile(p.dan), // no card, no name
    c.profile(p.eve, { name: HOSTILE, avatar: svg }, "eve"),
    c.profile(p.solo, { name: "Solo" }, "solo"),
    c.profile(p.one, { name: "Only One" }, "one"),
    c.profile(p.narc, { name: "Narcissus" }, "narc"),
    c.profile(p.swapA, { name: "First Holder" }, "swap"),
    c.profile(p.popular, { name: "Popular" }, "popular"),
    c.profile(p.tara, { name: "Tara Get" }, "tara"),
    c.profile(p.org, { name: "Org" }, "org"),
    c.profile(p.two, { name: "Twin A" }, "twin_a"),
  ]);
  ["ada", "bob", "cara", "dan", "eve", "solo", "one", "narc", "swap", "popular", "tara", "org", "twinA"].forEach((name, i) => (P[name] = made[i]));
  // Two's second profile, and Staff an admin of Org's: one write each per account, after the first.
  await Promise.all([c.profile(p.two, { name: "Twin B" }, "twin_b").then((id) => (P.twinB = id)), c.admin(p.org, P.org, p.staff)]);
  // Profiles follow profiles, each written by its owner.
  await Promise.all([
    c.follow(p.bob, P.bob, P.ada, P.one),
    c.follow(p.cara, P.cara, P.ada, P.swap),
    c.follow(p.dan, P.dan, P.ada, P.swap),
    c.follow(p.eve, P.eve, P.ada),
    c.follow(p.ada, P.ada, P.bob, P.eve, P.cara),
    c.follow(p.narc, P.narc, P.narc),
    c.follow(p.swapA, P.swap, P.one),
  ]);
  // Many followers: each fan makes a profile and follows from it; sent together, then waited for.
  p.fans = Array.from({ length: FANS }, newAccount);
  // Two fans with names, so a long list can be filtered by name and @handle.
  // Their filters hold a space or "_", which no profile id has: no chance matches.
  const cards = { 3: [{ name: "Zoe Quinn" }, "zoe_q"], 4: [{ name: "Yusuf Ali" }, "yusuf"] };
  const owned = async () => {
    let n = 0;
    for await (const _ of (await c.state.moniker()).list("owns/")) n++;
    return n;
  };
  const already = await owned();
  const fans = [];
  for (const [i, fan] of p.fans.entries()) {
    const { id, write } = await profileRecords.createProfile(await c.state.moniker(), fan.address, { card: cards[i]?.[0], handle: cards[i]?.[1] });
    await c.submit(MONIKER, fan, write.actions);
    fans.push(id);
  }
  P.fans = fans;
  await until("every fan's profile lands", async () => (await owned()) === already + FANS);
  for (const [i, fan] of p.fans.entries()) await c.submit(FOLLOWS, fan, await c.followActions(fan, fans[i], P.popular));
  await until("every fan's follow lands", async () => {
    let n = 0;
    for await (const _ of (await c.state.follows()).list(`followers/${P.popular}/`)) n++;
    return n === FANS;
  });
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await stack?.stop();
});

const query = (nodes = [stack.info.node]) => `?node=${nodes.join(",")}&chain=${FOLLOWS.join("/")}&moniker=${MONIKER.join("/")}`;

/**
 * A stand-in for Selfhold holding `who`'s key: connect answers with the
 * account, and writeRecords signs the request and sends it to the node, as
 * the wallet would. `decline` makes it refuse instead. Its requests are kept
 * on `page.requests`.
 */
async function withWallet(page, who, { connected = false, decline = false, slow = 0 } = {}) {
  page.requests = [];
  await page.exposeFunction("__writeRecords", async (request) => {
    page.requests.push(request);
    if (decline) throw new Error("The user declined the request.");
    assert.deepEqual(request.chainPath, FOLLOWS);
    // A slow network: the wallet has taken the write, which reaches a block `slow` ms later.
    if (slow) setTimeout(() => c.submit(FOLLOWS, who, request.actions).catch(() => {}), slow);
    else await c.submit(FOLLOWS, who, request.actions);
    return { transactionCID: "sent" };
  });
  await page.addInitScript(({ address, connected }) => {
    let current = connected ? address : null;
    window.lattice = {
      address: async () => current,
      connect: async () => (current = address),
      writeRecords: (request) => window.__writeRecords(request),
    };
  }, { address: who.address, connected });
}

/** The page at `hash`, with what went wrong in it collected on `page.errors`. */
async function open(hash = "#/", { width = 1100, colorScheme = "light", nodes, before } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 800 }, colorScheme });
  const page = await context.newPage();
  page.errors = [];
  page.on("pageerror", (error) => page.errors.push(String(error)));
  await before?.(page);
  await page.goto(`${stack.info.app}${query(nodes)}${hash}`);
  return page;
}
const title = (page) => page.locator("main h1");
const counts = (page) => page.locator(".counts a");
const rows = (page) => page.locator(".people li a strong");
const names = async (page) => (await rows(page).allTextContents()).sort();
const followButton = (page) => page.locator("follows-button button");
const note = (page) => page.locator("follows-button .note");
const SAVING = "Saving… about a minute.";
/** Closes the page, which must not have thrown. */
async function close(page) {
  assert.deepEqual(page.errors, []);
  await page.context().close();
}

const picker = (page) => page.locator("follows-button select");
const tail = (id) => `Profile …${id.slice(-6)}`;

// ---------------------------------------------------------------- finding people

test("the front page says what Follows is and puts the cursor in the search", async () => {
  const page = await open();
  await expect(title(page)).toHaveText("One follow list for every app.");
  await expect(page.locator("#search")).toBeFocused();
  await expect(page.locator("#search")).toHaveAttribute("placeholder", "Search @handle");
  await expect(page.locator(".recent")).toHaveCount(0);
  await close(page);
});

test("a @handle opens the profile holding it: its card, counts and Follow", async () => {
  const page = await open();
  await page.fill("#search", "@ada");
  await page.press("#search", "Enter");
  await expect(title(page)).toHaveText("Ada Lovelace");
  await expect(page.locator(".person .names")).toHaveText("@ada");
  await expect(counts(page)).toHaveText(["4 followers", "3 following"]);
  await expect(followButton(page)).toHaveText("Follow @ada");
  await expect(page.getByRole("link", { name: "Moniker page" })).toHaveAttribute("href", "https://app.moniker.bio/#/%40ada");
  // Accounts are never shown, and the search field is clear again.
  await expect(page.locator("main")).not.toContainText("bafyrei");
  await expect(page.locator("main")).not.toContainText("Account");
  await expect(page.locator("#search")).toHaveValue("");
  assert.match(page.url(), /#\/%40ada$/);
  await close(page);
});

test("a handle may be typed without @ and in capitals", async () => {
  for (const typed of ["ada", "ADA", "  @Ada "]) {
    const page = await open();
    await page.fill("#search", typed);
    await page.press("#search", "Enter");
    await expect(title(page)).toHaveText("Ada Lovelace");
    await close(page);
  }
});

test("a profile ID opens the profile, and Copy ID copies it", async () => {
  const page = await open();
  await page.fill("#search", P.ada);
  await page.press("#search", "Enter");
  await expect(title(page)).toHaveText("Ada Lovelace");
  assert.ok(page.url().endsWith(`#/${P.ada}`), page.url());
  await expect(counts(page)).toHaveText(["4 followers", "3 following"]);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "Copy ID" }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), P.ada);
  await expect(page.locator("#copied")).toHaveText("Profile ID copied");
  await close(page);
});

test("a search that is not a handle says how to search", async () => {
  const page = await open();
  await page.fill("#search", "ada lovelace");
  await page.press("#search", "Enter");
  await expect(page.locator("main")).toHaveText("“ada lovelace” isn't a @handle. Handles look like @name.");
  await close(page);
});

test("a name no one holds, or an unknown ID, says so", async () => {
  let page = await open("#/@nobody_has_this");
  await expect(page.locator("main")).toHaveText("No one holds @nobody_has_this.");
  await close(page);
  page = await open("#/zzzzzzzzzzzzzzzz");
  await expect(page.locator("main")).toHaveText("There's no profile with this ID.");
  await close(page);
});

test("pages you visit are listed under Recently viewed", async () => {
  const page = await open("#/@ada");
  await expect(title(page)).toHaveText("Ada Lovelace");
  await page.goto(`${stack.info.app}${query()}#/@bob`);
  await expect(title(page)).toHaveText("Bob Stone");
  await page.goto(`${stack.info.app}${query()}#/`);
  await expect(page.locator(".recent strong")).toHaveText(["Bob Stone", "Ada Lovelace"]);
  await page.locator(".recent a").first().click();
  await expect(title(page)).toHaveText("Bob Stone");
  await close(page);
});

// ---------------------------------------------------------------- lists

test("the followers count opens the list of profiles, each linking to its page", async () => {
  const page = await open("#/@ada");
  await counts(page).first().click();
  assert.match(page.url(), /#\/%40ada\/followers$/);
  await expect(title(page)).toHaveText("@ada's followers");
  assert.deepEqual(await (async () => (await expect(rows(page)).toHaveCount(4), names(page)))(), ["Bob Stone", "Cara Diaz", HOSTILE, tail(P.dan)].sort());
  // A short list needs no filter.
  await expect(page.locator("#filter")).toHaveCount(0);
  await page.getByRole("link", { name: /Bob Stone/ }).click();
  await expect(title(page)).toHaveText("Bob Stone");
  await page.goBack();
  await expect(title(page)).toHaveText("@ada's followers");
  await page.getByRole("link", { name: "‹ Ada Lovelace" }).click();
  await expect(title(page)).toHaveText("Ada Lovelace");
  await close(page);
});

test("the following count lists the profiles it follows", async () => {
  const page = await open("#/@ada/following");
  await expect(title(page)).toHaveText("@ada follows");
  await expect(rows(page)).toHaveCount(3);
  assert.deepEqual(await names(page), ["Bob Stone", "Cara Diaz", HOSTILE].sort());
  await expect(page.locator(".people li", { hasText: "Bob Stone" })).toContainText("@bob");
  await close(page);
});

test("someone with no follows either way sees both empty lists", async () => {
  let page = await open("#/@solo");
  await expect(counts(page)).toHaveText(["0 followers", "0 following"]);
  await counts(page).first().click();
  await expect(page.locator(".people")).toHaveText("No followers yet.");
  await close(page);
  page = await open("#/@solo/following");
  await expect(page.locator(".people")).toHaveText("Not following anyone yet.");
  await close(page);
});

test("a profile with no name shows as the end of its ID, and links by it", async () => {
  const page = await open(`#/${P.dan}`);
  await expect(title(page)).toHaveText(tail(P.dan));
  await expect(page.locator(".person .avatar")).toHaveText("");
  await counts(page).nth(1).click();
  await expect(title(page)).toHaveText(`${tail(P.dan)} follows`);
  assert.deepEqual(await (async () => (await expect(rows(page)).toHaveCount(2), names(page)))(), ["Ada Lovelace", "First Holder"]);
  await page.goto(`${stack.info.app}${query()}#/@ada/followers`);
  await expect(page.getByRole("link", { name: tail(P.dan) })).toHaveAttribute("href", `#/${P.dan}`);
  await close(page);
});

test(`a long list (${FANS} followers) shows 50 at a time, and its filter looks through everyone`, async () => {
  const page = await open("#/@popular/followers");
  await expect(page.locator(".people li")).toHaveCount(50, { timeout: 60_000 });
  await page.getByRole("button", { name: "Show 50 more" }).click();
  await expect(page.locator(".people li")).toHaveCount(100, { timeout: 60_000 });
  // The filter reads the rest once, then answers at once.
  await page.fill("#filter", "zoe quinn");
  await expect(rows(page)).toHaveText(["Zoe Quinn"], { timeout: 60_000 });
  await expect(page.getByRole("button", { name: /^Show \d+ more$/ })).toBeHidden();
  for (const [typed, expected] of [["@ZOE_Q", ["Zoe Quinn"]], ["yusuf ali", ["Yusuf Ali"]], [P.fans[57], [tail(P.fans[57])]]]) {
    const started = Date.now();
    await page.fill("#filter", typed);
    await expect(rows(page)).toHaveText(expected);
    assert.ok(Date.now() - started < 1000, `filtering took ${Date.now() - started} ms`);
  }
  await expect(page.locator("#results")).toHaveText("1 result");
  await page.fill("#filter", "zz_zz");
  await expect(page.locator(".people")).toHaveText("No one here matches “zz_zz”.");
  await page.fill("#filter", "");
  await expect(page.locator(".people li")).toHaveCount(FANS);
  await close(page);
});

// ---------------------------------------------------------------- what it shows, safely

test("a name with markup in it is shown as text, and an SVG photo never shows", async () => {
  const page = await open("#/@ada/followers");
  const eve = page.locator(".people li", { hasText: "onerror" });
  await expect(eve.locator("strong")).toHaveText(HOSTILE);
  await expect(eve.locator(".avatar")).toHaveText("<");
  await page.waitForTimeout(1500);
  assert.equal(await eve.locator("img").count(), 0);
  assert.equal(await page.evaluate(() => window.pwned), undefined);
  assert.equal(await page.locator('main img[src="x"]').count(), 0);
  await close(page);
});

test("a real photo shows", async () => {
  const page = await open("#/@ada");
  await expect(page.locator(".person .avatar img")).toHaveAttribute("src", /^blob:/);
  await close(page);
});

test("counts read naturally", async () => {
  const page = await open("#/@eve");
  await expect(counts(page)).toHaveText(["1 follower", "1 following"]);
  await close(page);
});

test("a profile that follows itself is on its own list", async () => {
  const page = await open("#/@narc/followers");
  await expect(rows(page)).toHaveText(["Narcissus"]);
  await close(page);
});

// ---------------------------------------------------------------- who counts

test("a follow lapses when its profile changes hands, until the new owner follows", async () => {
  let page = await open("#/@one/followers");
  assert.deepEqual(await (async () => (await expect(rows(page)).toHaveCount(2), names(page)))(), ["Bob Stone", "First Holder"]);
  await close(page);
  await c.hand(p.swapA, P.swap, p.swapB);
  page = await open("#/@one");
  await expect(counts(page)).toHaveText(["1 follower", "0 following"]);
  await counts(page).first().click();
  await expect(rows(page)).toHaveText(["Bob Stone"]);
  // The profile kept its card and name; what it followed under First Holder's key isn't counted.
  await page.goto(`${stack.info.app}${query()}#/@swap`);
  await expect(title(page)).toHaveText("First Holder");
  await expect(counts(page)).toHaveText(["2 followers", "0 following"]);
  await close(page);
  await c.follow(p.swapB, P.swap, P.one);
  page = await open("#/@one");
  await expect(counts(page)).toHaveText(["2 followers", "0 following"]);
  await close(page);
});

test("an admin follows as the profile, counted once with its owner", async () => {
  await c.follow(p.staff, P.org, P.solo);
  let page = await open("#/@solo/followers");
  await expect(rows(page)).toHaveText(["Org"]);
  await close(page);
  await c.follow(p.org, P.org, P.solo);
  page = await open("#/@solo");
  await expect(counts(page).first()).toHaveText("1 follower");
  await close(page);
  // Staff's keys stay after Org's owner unfollows: the admin's follow still counts.
  await c.unfollow(p.org, P.org, P.solo);
  page = await open("#/@org");
  await expect(counts(page)).toHaveText(["0 followers", "1 following"]);
  await close(page);
});

test("an unfollow shows on the next visit", async () => {
  const page = await open("#/@eve");
  await expect(counts(page).first()).toHaveText("1 follower");
  await c.unfollow(p.ada, P.ada, P.eve);
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
  await until("Ada's page asks the node", async () => held.length > 0, 10);
  await page.evaluate((id) => (location.hash = `#/${id}`), P.bob);
  hold = false;
  for (const route of held.splice(0)) await route.continue();
  await expect(title(page)).toHaveText("Bob Stone");
  await page.waitForTimeout(3000);
  await expect(title(page)).toHaveText("Bob Stone");
  await close(page);
});

test("when the first node is down, the page reads from the next", async () => {
  const page = await open("#/@ada", { nodes: ["http://127.0.0.1:9", stack.info.node] });
  await expect(title(page)).toHaveText("Ada Lovelace");
  await expect(counts(page).first()).toHaveText("4 followers");
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
  await expect(title(page)).toHaveText("Ada Lovelace");
  await close(page);
});

test("on a phone, nothing scrolls sideways", async () => {
  for (const hash of ["#/", "#/@ada", `#/${P.dan}`, "#/@ada/following"]) {
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
  await expect(title(page)).toHaveText("Ada Lovelace");
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(18, 20, 24)");
  await expect(followButton(page)).toHaveText("Follow @ada");
  assert.equal(await followButton(page).evaluate((b) => getComputedStyle(b).color), "rgb(18, 20, 24)");
  await close(page);
});

// ---------------------------------------------------------------- following, through the Follow button
// The wallet is a stand-in that signs with the test's key; Moniker's suite
// runs the same button with the real Selfhold extension.

test("following: the wallet is asked once, the button turns at once, the note says saving, then Saved", async () => {
  const fan = await withProfile({ name: "Fan" }, "fan_one");
  const page = await open("#/@tara", { before: (page) => withWallet(page, fan, { slow: 8000 }) });
  await expect(counts(page).first()).toHaveText("0 followers");
  await expect(followButton(page)).toHaveText("Follow @tara");
  await expect(followButton(page)).toHaveAccessibleName("Follow @tara");
  // One profile: no picker.
  await expect(picker(page)).toBeHidden();
  const width = (await followButton(page).boundingBox()).width;
  await followButton(page).click();
  await expect(followButton(page)).toHaveText("Following @tara");
  await expect(followButton(page)).toHaveAccessibleName("Following @tara");
  await expect(note(page)).toHaveText(SAVING);
  // Not there yet: the button is quieter until the chain holds it.
  assert.equal(await followButton(page).evaluate((b) => getComputedStyle(b).opacity), "0.7");
  // The button keeps its size, and the note its place, through every state.
  assert.equal((await followButton(page).boundingBox()).width, width);
  await expect(note(page)).toHaveText("Saved.", { timeout: 120_000 });
  // "Saved." only once the chain holds it.
  assert.equal(await (await c.state.follows()).get(`follows/${fan.id}/${P.tara}/${fan.address}`), "1");
  await expect(counts(page).first()).toHaveText("1 follower");
  assert.equal(await followButton(page).getAttribute("aria-pressed"), null);
  assert.equal(page.requests.length, 1);
  assert.deepEqual(page.requests[0].actions.map((a) => a.key).sort(), [`followers/${P.tara}/${fan.id}/${fan.address}`, `follows/${fan.id}/${P.tara}/${fan.address}`]);
  await expect(note(page)).toHaveText("", { timeout: 10_000 });
  await close(page);
});

test("a profile with no name: the button says Follow, and names it to screen readers", async () => {
  const fan = await withProfile({ name: "Fan" });
  const page = await open(`#/${P.dan}`, { before: (page) => withWallet(page, fan) });
  await expect(followButton(page)).toHaveText("Follow");
  await expect(followButton(page)).toHaveAccessibleName(`Follow, ${tail(P.dan)}`);
  await followButton(page).click();
  await expect(note(page)).toHaveText("Saved.", { timeout: 120_000 });
  await expect(followButton(page)).toHaveText("Following");
  await expect(counts(page).first()).toHaveText("1 follower");
  await close(page);
});

test("an account with two profiles picks which follows, and the choice is remembered", async () => {
  const page = await open("#/@tara", { before: (page) => withWallet(page, p.two, { connected: true }) });
  await expect(picker(page)).toBeVisible();
  await expect(picker(page).locator("option")).toHaveCount(2);
  assert.deepEqual((await picker(page).locator("option").allTextContents()).sort(), ["as Twin A", "as Twin B"]);
  await expect(picker(page)).toHaveAccessibleName("Follow as");
  await picker(page).selectOption({ label: "as Twin B" });
  await expect(followButton(page)).toHaveText("Follow @tara");
  await followButton(page).click();
  await expect(note(page)).toHaveText("Saved.", { timeout: 120_000 });
  assert.deepEqual(page.requests[0].actions.map((a) => a.key).sort(), [`followers/${P.tara}/${P.twinB}/${p.two.address}`, `follows/${P.twinB}/${P.tara}/${p.two.address}`]);
  await page.reload();
  await expect(picker(page)).toHaveValue(P.twinB);
  await expect(followButton(page)).toHaveText("Following @tara");
  // Twin A follows nothing yet.
  await picker(page).selectOption({ label: "as Twin A" });
  await expect(followButton(page)).toHaveText("Follow @tara");
  await close(page);
});

test("an account with no profile is told to make one on Moniker, and nothing is sent", async () => {
  const page = await open("#/@tara", { before: (page) => withWallet(page, newAccount()) });
  await expect(followButton(page)).toHaveText("Follow @tara");
  await followButton(page).click();
  await expect(note(page)).toHaveText("To follow, make a profile on Moniker, then reload this page.");
  await expect(note(page).locator("a")).toHaveAttribute("href", "https://app.moniker.bio/");
  await expect(followButton(page)).toHaveText("Follow @tara");
  assert.equal(page.requests.length, 0);
  await close(page);
});

test("Following shows Unfollow under a mouse, and pressing it unfollows", async () => {
  const fan = await withProfile({ name: "Fan" });
  await c.follow(fan, fan.id, P.tara);
  const page = await open("#/@tara", { before: (page) => withWallet(page, fan, { connected: true }) });
  await expect(followButton(page)).toHaveText("Following @tara");
  await followButton(page).hover();
  await expect(followButton(page).locator(".now")).toBeHidden();
  assert.equal(await followButton(page).evaluate((b) => getComputedStyle(b, "::after").content), '"Unfollow @tara"');
  const before = await counts(page).first().textContent();
  await followButton(page).click();
  await expect(followButton(page)).toHaveText("Follow @tara");
  await expect(note(page)).toHaveText(SAVING);
  await expect(note(page)).toHaveText("Saved.", { timeout: 120_000 });
  await expect(counts(page).first()).not.toHaveText(before);
  assert.deepEqual(page.requests[0].actions.map((a) => a.newValue), [undefined, undefined]);
  await close(page);
});

test("keyboard focus stays on the button while it saves", async () => {
  const fan = await withProfile({ name: "Fan" });
  const page = await open("#/@tara", { before: (page) => withWallet(page, fan) });
  await expect(followButton(page)).toHaveText("Follow @tara");
  await followButton(page).focus();
  await page.keyboard.press("Enter");
  await expect(note(page)).toHaveText(SAVING);
  await expect(followButton(page)).toBeFocused();
  await expect(note(page)).toHaveText("Saved.", { timeout: 120_000 });
  await expect(followButton(page)).toBeFocused();
  await close(page);
});

test("declining in the wallet sends nothing and says so", async () => {
  const fan = await withProfile({ name: "Fan" });
  const page = await open("#/@tara", { before: (page) => withWallet(page, fan, { decline: true }) });
  await followButton(page).click();
  await expect(note(page)).toHaveText("Canceled in Selfhold. Nothing was sent.");
  await expect(followButton(page)).toHaveText("Follow @tara");
  await close(page);
});

test("without a wallet, Follow says how to get one; on a phone, to use a computer", async () => {
  let page = await open("#/@tara");
  await followButton(page).click();
  await expect(note(page)).toContainText("To follow, add Selfhold, a free browser extension");
  await expect(note(page).locator("a")).toHaveAttribute("href", /chromewebstore\.google\.com/);
  await close(page);
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148" });
  page = await phone.newPage();
  page.errors = [];
  await page.goto(`${stack.info.app}${query()}#/@tara`);
  await followButton(page).click();
  await expect(note(page)).toHaveText("Following needs Selfhold, a Chrome extension for computers. Open this page on a computer to follow.");
  await close(page);
});

test("on your own profile there is no Follow button, on others there is", async () => {
  for (const hash of [`#/${P.tara}`, "#/@tara"]) {
    const page = await open(hash, { before: (page) => withWallet(page, p.tara, { connected: true }) });
    await expect(counts(page).first()).toHaveText(/follower/);
    await expect(page.locator("follows-button")).toBeHidden();
    await close(page);
  }
  // Either of two profiles is your own.
  const page = await open("#/@twin_b", { before: (page) => withWallet(page, p.two, { connected: true }) });
  await expect(counts(page).first()).toHaveText(/follower/);
  await expect(page.locator("follows-button")).toBeHidden();
  await page.goto(`${stack.info.app}${query()}#/@ada`);
  await expect(followButton(page)).toHaveText("Follow @ada");
  await close(page);
});

test("a follow still waiting for a block, sent from anywhere, shows as saving until it lands", async () => {
  const fan = await withProfile({ name: "Fan" });
  const mining = (verb) => execFileSync(process.env.LATTICE, ["mine", verb, "--root", stack.info.root]);
  mining("stop");
  try {
    // Sent by another app: this page never asked the wallet for it.
    await c.submit(FOLLOWS, fan, await c.followActions(fan, fan.id, P.tara));
    const page = await open("#/@tara", { before: (page) => withWallet(page, fan, { connected: true }) });
    await expect(followButton(page)).toHaveText("Following @tara");
    await expect(note(page)).toHaveText(SAVING);
    mining("start");
    await expect(note(page)).toHaveText("Saved.", { timeout: 120_000 });
    assert.equal(page.requests.length, 0);
    await close(page);
  } finally {
    try {
      mining("start");
    } catch {}
  }
});

test("a network blip while saving doesn't turn into a failed save", async () => {
  const fan = await withProfile({ name: "Fan" });
  let blip = false;
  const page = await open("#/@tara", {
    before: async (page) => {
      await withWallet(page, fan, { slow: 6000 });
      await page.route(`${stack.info.node}/**`, (route) => (blip ? route.abort() : route.continue()));
    },
  });
  await expect(followButton(page)).toHaveText("Follow @tara");
  await followButton(page).click();
  await expect(note(page)).toHaveText(SAVING);
  blip = true;
  await page.waitForTimeout(7000);
  blip = false;
  await expect(note(page)).toHaveText("Saved.", { timeout: 120_000 });
  await expect(followButton(page)).toHaveText("Following @tara");
  await close(page);
});

test("connecting during the click as the page's own profile follows nothing", async () => {
  const page = await open("#/@tara", { before: (page) => withWallet(page, p.tara) });
  await expect(followButton(page)).toHaveText("Follow @tara");
  await followButton(page).click();
  await expect(page.locator("follows-button")).toBeHidden();
  assert.equal(page.requests.length, 0);
  await close(page);
});

test("a malformed link shows a message, not a blank page", async () => {
  const page = await open("#/%E0");
  await expect(page.locator("main")).toContainText("isn't a @handle");
  await close(page);
});
