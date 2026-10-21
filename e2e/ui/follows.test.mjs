// Acceptance tests for the Follows page: the real page (app/) in Chromium
// against a private Lattice stack (stack.mjs) with a Follows chain and a
// Moniker chain, seeded below. Each test is one thing a person does, checked
// by what the page then shows. The page only reads, so no wallet is needed.
//
//   (cd policy && cargo build --release --target wasm32-unknown-unknown)
//   cd e2e/ui && npm install && LATTICE=<lattice-node>/.build/debug/lattice npm test
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, expect as baseExpect } from "playwright/test";
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

before(async () => {
  stack = await start();
  c = client(stack.info.node);
  for (const name of ["ada", "bob", "cara", "dan", "eve", "solo", "one", "narc", "swapA", "swapB", "popular"]) p[name] = newAccount();
  const [png, svg] = [await pinMedia(stack.info, "image/png", PNG), await pinMedia(stack.info, "image/svg+xml", SVG)];
  await Promise.all([
    c.card(p.ada, { name: "Ada Lovelace", avatar: png }, "ada"),
    c.card(p.bob, { name: "Bob Stone" }, "bob"),
    c.card(p.cara, { name: "Cara Diaz" }),
    c.card(p.eve, { name: HOSTILE, avatar: svg }),
    c.card(p.solo, { name: "Solo" }, "solo"),
    c.card(p.one, { name: "Only One" }, "one"),
    c.card(p.narc, { name: "Narcissus" }, "narc"),
    c.card(p.swapA, { name: "First Holder" }, "swap"),
    c.card(p.swapB, { name: "Second Holder" }),
    c.card(p.popular, { name: "Popular" }, "popular"),
  ]);
  await Promise.all([
    c.follow(p.bob, p.ada, p.one),
    c.follow(p.cara, p.ada, p.swapA),
    c.follow(p.dan, p.ada, p.swapB),
    c.follow(p.eve, p.ada),
    c.follow(p.ada, p.bob, p.cara),
    c.follow(p.narc, p.narc),
    c.follow(p.swapB, p.bob),
  ]);
  // Many followers: each fan signs their own follow; sent together, then waited for.
  p.fans = Array.from({ length: FANS }, newAccount);
  for (const fan of p.fans) await c.submit(FOLLOWS, fan, await c.followActions(fan, p.popular));
  await until("every fan's follow lands", async () => {
    let n = 0;
    for await (const _ of (await c.state.follows()).list(`followers/${p.popular.address}/`)) n++;
    return n === FANS;
  });
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await stack?.stop();
});

const short = (address) => `${address.slice(0, 7)}…${address.slice(-5)}`;
const query = (nodes = [stack.info.node]) => `?node=${nodes.join(",")}&chain=${FOLLOWS.join("/")}&moniker=${MONIKER.join("/")}`;

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
const rows = (page) => page.locator(".people li a strong");
const names = async (page) => (await rows(page).allTextContents()).sort();
/** Closes the page, which must not have thrown. */
async function close(page) {
  assert.deepEqual(page.errors, []);
  await page.context().close();
}

test("the front page says what Follows is and puts the cursor in the search", async () => {
  const page = await open();
  await expect(title(page)).toHaveText("One follow list for every app.");
  await expect(page.locator("#search")).toBeFocused();
  await close(page);
});

test("searching a @handle shows who follows them, with names from Moniker", async () => {
  const page = await open();
  await page.fill("#search", "@ada");
  await page.click("#find button");
  await expect(title(page)).toHaveText("Ada Lovelace");
  await expect(page.locator(".tabs a").first()).toHaveText("4 followers");
  await expect(page.locator(".tabs a").last()).toHaveText("2 following");
  await expect(rows(page)).toHaveCount(4);
  assert.deepEqual(await names(page), ["Bob Stone", "Cara Diaz", HOSTILE, short(p.dan.address)].sort());
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

test("searching an address finds the account", async () => {
  const page = await open();
  await page.fill("#search", p.bob.address);
  await page.press("#search", "Enter");
  await expect(title(page)).toHaveText("Bob Stone");
  await expect(page.locator(".tabs a").first()).toHaveText("2 followers");
  // Bob shows @bob, but the tabs keep the address he was found by.
  await page.locator(".tabs a").last().click();
  await expect(page.locator(".tabs a[aria-current=page]")).toHaveText(/following$/);
  assert.ok(page.url().endsWith(`#/${p.bob.address}/following`), page.url());
  await close(page);
});

test("a search that is neither a handle nor an address says so", async () => {
  const page = await open();
  await page.fill("#search", "ada lovelace");
  await page.press("#search", "Enter");
  await expect(page.locator("main")).toHaveText("“ada lovelace” isn't a handle or an address.");
  await close(page);
});

test("a handle nobody holds says so", async () => {
  const page = await open("#/@nobody_has_this");
  await expect(page.locator("main")).toHaveText("No one holds @nobody_has_this.");
  await close(page);
});

test("the Following tab lists whom they follow", async () => {
  const page = await open("#/@ada");
  await expect(rows(page)).toHaveCount(4);
  await page.click("text=2 following");
  await expect(page.locator(".tabs a[aria-current=page]")).toHaveText("2 following");
  await expect(rows(page)).toHaveCount(2);
  assert.deepEqual(await names(page), ["Bob Stone", "Cara Diaz"]);
  assert.match(page.url(), /#\/%40ada\/following$/);
  await expect(page.locator("#filter")).toHaveAttribute("placeholder", "Search people they follow");
  await close(page);
});

test("a link to someone's Following tab opens it", async () => {
  const page = await open("#/@ada/following");
  await expect(page.locator(".tabs a[aria-current=page]")).toHaveText("2 following");
  await expect(rows(page)).toHaveCount(2);
  await close(page);
});

test("counts read naturally: one follower, nobody followed", async () => {
  const page = await open("#/@one");
  await expect(page.locator(".tabs a").first()).toHaveText("1 follower");
  await expect(page.locator(".tabs a").last()).toHaveText("0 following");
  await close(page);
});

test("the filter matches by name, @handle or part of an address", async () => {
  const page = await open("#/@ada");
  await expect(rows(page)).toHaveCount(4);
  await page.fill("#filter", "car");
  assert.deepEqual(await names(page), ["Cara Diaz"]);
  await page.fill("#filter", "@BOB");
  assert.deepEqual(await names(page), ["Bob Stone"]);
  await page.fill("#filter", p.dan.address.slice(20, 32));
  assert.deepEqual(await names(page), [short(p.dan.address)]);
  await page.fill("#filter", "zzz");
  await expect(page.locator(".people")).toHaveText("No one here matches “zzz”.");
  await page.fill("#filter", "");
  await expect(rows(page)).toHaveCount(4);
  await close(page);
});

test("the filter starts empty on the other tab", async () => {
  const page = await open("#/@ada");
  await expect(rows(page)).toHaveCount(4);
  await page.fill("#filter", "bob");
  await page.click("text=2 following");
  await expect(rows(page)).toHaveCount(2);
  await expect(page.locator("#filter")).toHaveValue("");
  await close(page);
});

test("a person in the list opens their page, and Back and Forward work", async () => {
  const page = await open("#/@ada");
  await page.click("text=Bob Stone");
  await expect(title(page)).toHaveText("Bob Stone");
  await page.goBack();
  await expect(title(page)).toHaveText("Ada Lovelace");
  await page.goForward();
  await expect(title(page)).toHaveText("Bob Stone");
  await close(page);
});

test("someone with no follows either way sees both empty lists, without a filter", async () => {
  const page = await open("#/@solo");
  await expect(page.locator(".people")).toHaveText("No followers yet.");
  await expect(page.locator("#filter")).toBeHidden();
  await page.click("text=0 following");
  await expect(page.locator(".people")).toHaveText("Not following anyone yet.");
  await close(page);
});

test("an account with no Moniker card is shown by a short address", async () => {
  const page = await open(`#/${p.dan.address}/following`);
  await expect(title(page)).toHaveText(short(p.dan.address));
  await expect(rows(page)).toHaveCount(2);
  assert.deepEqual(await names(page), ["Ada Lovelace", "Second Holder"]);
  await close(page);
});

test("a name with markup in it is shown as text and runs nothing", async () => {
  const page = await open(`#/${p.eve.address}`);
  await expect(title(page)).toHaveText(HOSTILE);
  await page.goto(`${stack.info.app}${query()}#/@ada`);
  await expect(rows(page).filter({ hasText: "onerror" })).toHaveText(HOSTILE);
  await page.waitForTimeout(1000);
  assert.equal(await page.evaluate(() => window.pwned), undefined);
  assert.equal(await page.locator('main img[src="x"]').count(), 0);
  await close(page);
});

test("a photo shows when it is an image, and the initial when it is not", async () => {
  const page = await open(`#/${p.bob.address}/following`);
  await expect(page.locator(".people .avatar img")).toHaveCount(1);
  await expect(page.locator(".people .avatar img")).toHaveAttribute("src", /^blob:/);
  await page.goto(`${stack.info.app}${query()}#/@ada`);
  const eve = page.locator(".people li", { hasText: "onerror" }).locator(".avatar");
  await expect(eve).toHaveText("<");
  await page.waitForTimeout(1500);
  assert.equal(await eve.locator("img").count(), 0);
  assert.equal(await page.evaluate(() => window.pwned), undefined);
  await close(page);
});

test("someone who follows themself is in both their lists", async () => {
  const page = await open("#/@narc");
  await expect(rows(page)).toHaveText(["Narcissus"]);
  await page.click("text=1 following");
  await expect(rows(page)).toHaveText(["Narcissus"]);
  await close(page);
});

test("a handle that changed hands shows its new holder's follows", async () => {
  let page = await open("#/@swap");
  await expect(title(page)).toHaveText("First Holder");
  await expect(rows(page)).toHaveText(["Cara Diaz"]);
  await close(page);
  await c.give(p.swapA, "swap", p.swapB);
  page = await open("#/@swap");
  await expect(title(page)).toHaveText("Second Holder");
  await expect(rows(page)).toHaveText([short(p.dan.address)]);
  await page.click("text=1 following");
  await expect(rows(page)).toHaveText(["Bob Stone"]);
  await close(page);
});

test("an unfollow shows on the next visit", async () => {
  const page = await open("#/@one");
  await expect(rows(page)).toHaveText(["Bob Stone"]);
  await c.unfollow(p.bob, p.one);
  await page.reload();
  await expect(page.locator(".tabs a").first()).toHaveText("0 followers");
  await expect(page.locator(".people")).toHaveText("No followers yet.");
  await close(page);
});

test(`a long list (${FANS} followers) loads, and the filter keeps up`, async () => {
  const page = await open("#/@popular");
  await expect(page.locator(".tabs a").first()).toHaveText(`${FANS} followers`, { timeout: 120_000 });
  await expect(page.locator(".people li")).toHaveCount(FANS);
  const fan = p.fans[57].address;
  const started = Date.now();
  await page.fill("#filter", fan.slice(-10));
  await expect(rows(page)).toHaveText([short(fan)]);
  assert.ok(Date.now() - started < 1000, `filtering took ${Date.now() - started} ms`);
  await close(page);
});

test("moving on before a page loads shows the newer one, not the slower one", async () => {
  const held = [];
  let hold = true;
  const page = await open("#/", {
    before: (page) => page.route(`${stack.info.node}/**`, (route) => (hold ? held.push(route) : route.continue())),
  });
  await page.evaluate(() => (location.hash = "#/@ada"));
  await until("Ada's page asks the node", async () => held.length > 0, 10);
  await page.evaluate((bob) => (location.hash = `#/${bob}`), p.bob.address);
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
  await expect(rows(page)).toHaveCount(4);
  await close(page);
});

test("when no node answers, the page says so, and Try again works once one does", async () => {
  let down = true;
  const page = await open("#/@ada", {
    before: (page) => page.route(`${stack.info.node}/**`, (route) => (down ? route.abort() : route.continue())),
  });
  await expect(page.locator("main")).toContainText("Couldn't reach the Follows nodes.");
  down = false;
  await page.click("text=Try again");
  await expect(title(page)).toHaveText("Ada Lovelace");
  await close(page);
});

test("on a phone, nothing scrolls sideways", async () => {
  for (const hash of ["#/", "#/@ada", `#/${p.dan.address}`]) {
    const page = await open(hash, { width: 360 });
    if (hash !== "#/") await expect(page.locator(".tabs")).toBeVisible();
    const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
    assert.ok(scroll <= width, `${hash}: ${scroll} > ${width}`);
    await close(page);
  }
});

test("in dark mode the page is dark", async () => {
  const page = await open("#/@ada", { colorScheme: "dark" });
  await expect(title(page)).toHaveText("Ada Lovelace");
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(18, 20, 24)");
  await close(page);
});
