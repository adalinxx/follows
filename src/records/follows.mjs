// The follow graph's records. An account follows an account: account `<a>`
// follows `<t>` with two keys, `follows/<a>/<t>` and its twin
// `followers/<t>/<a>`, so that both ends are one prefix read. Only `<a>` may
// write them, and always together (the chain's policy).
//
// A person may be named by a Moniker handle, but a follow never stores one:
// `@h` is the account it stands for when the follow is made, so a follow
// stays with that account when the handle changes hands. Readers resolve
// handles through `names`, which the reader passes in: `{ pointers(handles),
// handlesOf(addresses) }`, each answering in order. `@h` stands for account
// `x` while `h` points at `x` and `x` shows `h`, the test every app uses to
// show `@h` beside `x`.

/**
 * Whether `text` is an account address in its one canonical spelling, as the
 * policy checks a signer.
 */
export function isAddress(text) {
  const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
  return (
    typeof text === "string" &&
    text.length === 59 &&
    text.startsWith("bafyrei") &&
    [...text.slice(7)].every((c) => BASE32.includes(c)) &&
    BASE32.indexOf(text[7]) < 8 &&
    BASE32.indexOf(text[58]) % 4 === 0
  );
}

/** Whether `text` is a Moniker handle, without its @: lowercase letters, digits and `_`. */
export const isHandle = (text) => typeof text === "string" && /^[a-z0-9_]+$/.test(text);

/**
 * What `who` names: an account address as given, or `@<h>` for a handle,
 * given with or without its @. A bare address is an
 * account; a handle spelled like one needs its @.
 */
export function target(who) {
  if (isAddress(who)) return who;
  const h = String(who).replace(/^@/, "");
  if (isHandle(h)) return `@${h}`;
  throw new Error(`not an account or a handle: ${who}`);
}

/** Throws unless `account` is an account address. */
function needAccount(account) {
  if (!isAddress(account)) throw new Error(`not an account: ${account}`);
}

export const followKey = (account, followed) => (needAccount(account), needAccount(followed), `follows/${account}/${followed}`);
export const followerKey = (account, followed) => (needAccount(account), needAccount(followed), `followers/${followed}/${account}`);

/** The last segment of each key under `prefix`, in key order. */
async function under(state, prefix) {
  const found = [];
  for await (const [key] of state.list(prefix)) {
    const rest = key.slice(prefix.length);
    if (!rest.includes("/")) found.push(rest);
  }
  return found;
}

/** The handle each account shows, or undefined, in order; nothing is asked for a missing account. */
async function shownBy(names, accounts) {
  const asked = accounts.filter((a) => a !== undefined);
  const answers = asked.length === 0 ? [] : await names.handlesOf(asked);
  let next = 0;
  return accounts.map((a) => (a === undefined ? undefined : answers[next++]));
}

/** Each handle's account, or undefined: the one it points at, while that account shows it. */
export async function accountsOf(names, handles) {
  if (handles.length === 0) return [];
  const pointed = await names.pointers(handles);
  const shown = await shownBy(names, pointed);
  return handles.map((h, i) => (pointed[i] !== undefined && shown[i] === h ? pointed[i] : undefined));
}

/**
 * Who `who` is: `{ account, handle }`, the handle the account shows now,
 * or, for a handle no account shows, `{ handle }` alone.
 */
export async function person(names, who) {
  const t = target(who);
  if (!t.startsWith("@")) {
    const [handle] = await names.handlesOf([t]);
    return handle === undefined ? { account: t } : { account: t, handle };
  }
  const handle = t.slice(1);
  const [account] = await accountsOf(names, [handle]);
  return account === undefined ? { handle } : { account, handle };
}

/** The accounts that follow `who`'s account, in key order; none for a handle no account shows. */
export async function followers(state, names, who) {
  const { account } = await person(names, who);
  return account === undefined ? [] : (await under(state, `followers/${account}/`)).filter(isAddress);
}

/** Whom `account` follows, in key order: `{ account, handle }`, the handle each account shows now, if any. */
export async function following(state, names, account) {
  if (!isAddress(account)) return [];
  const accounts = (await under(state, `follows/${account}/`)).filter(isAddress);
  const shown = await shownBy(names, accounts);
  return accounts.map((a, i) => (shown[i] === undefined ? { account: a } : { account: a, handle: shown[i] }));
}

/** Whether `account` follows `who`'s account. */
export async function follows(state, names, account, who) {
  if (!isAddress(account)) return false;
  const { account: followed } = await person(names, who);
  return followed !== undefined && (await state.get(followKey(account, followed))) !== undefined;
}

/**
 * `account` follows `who`'s account: for a handle, the account showing it
 * now. Nothing to write when it already does.
 */
export async function follow(state, names, account, who) {
  needAccount(account);
  const { account: followed, handle } = await person(names, who);
  if (followed === undefined) throw new Error(`No account shows @${handle} now, so there is no one to follow.`);
  if (followed === account) throw new Error("You can't follow yourself.");
  if ((await state.get(followKey(account, followed))) !== undefined) return { actions: [] };
  return { actions: [followKey(account, followed), followerKey(account, followed)].map((key) => ({ key, newValue: "1" })) };
}

/** `account` deletes its keys following `who`'s account; nothing to write when there are none. */
export async function unfollow(state, names, account, who) {
  needAccount(account);
  const { account: followed } = await person(names, who);
  if (followed === undefined) return { actions: [] };
  const keys = [followKey(account, followed), followerKey(account, followed)];
  const oldValues = await Promise.all(keys.map((key) => state.get(key)));
  return { actions: oldValues[0] === undefined ? [] : keys.map((key, i) => ({ key, oldValue: oldValues[i] })) };
}

/**
 * What `account` is saving, from transaction bodies not yet in a block, by
 * followed account: `true` for a follow, `false` for an unfollow. A pending write may still be dropped, so it is never a
 * follow yet.
 */
export function pendingIn(bodies, account) {
  const found = {};
  for (const body of bodies) {
    // Anyone can put anything in a mempool: read only what is shaped as a body.
    if (!Array.isArray(body?.signers) || !body.signers.includes(account) || !Array.isArray(body.actions)) continue;
    for (const action of body.actions) {
      const [root, by, t, rest] = typeof action?.key === "string" ? action.key.split("/") : [];
      if (root !== "follows" || by !== account || rest !== undefined || t === undefined) continue;
      if (isAddress(t)) found[t] = action.newValue !== undefined;
    }
  }
  return found;
}
