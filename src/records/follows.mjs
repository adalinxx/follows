// The follow graph's records. An account follows an account, or a handle: a
// Moniker name, which stands for the account that shows it now. Account
// `<a>` follows `<t>` with two keys, `follows/<a>/<t>` and its twin
// `followers/<t>/<a>`, so that both ends are one prefix read. `<t>` is an
// account address, or `@<h>`. Only `<a>` may write them, and always together
// (the chain's policy).
//
// The chain can't see Moniker, so readers resolve handles, through `names`
// the reader passes in: `{ pointers(handles), handlesOf(addresses) }`, each
// answering in order. `@h` stands for account `x` while `h` points at `x` and
// `x` shows `h`, the test every app uses to show `@h` beside `x`. A person's
// followers are those of their account and of the handle they show now, each
// account once. When a handle changes hands, its followers follow whoever
// shows it next; an account's own followers stay with it.

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
 * What `who` names, as a key spells it: an account address as given, or
 * `@<h>` for a handle, given with or without its @. A bare address is an
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

export const followKey = (account, t) => (needAccount(account), `follows/${account}/${target(t)}`);
export const followerKey = (account, t) => (needAccount(account), `followers/${target(t)}/${account}`);

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

/** The keys that follow a person: their account's and their handle's. */
const forms = (p) => [p.account, p.handle === undefined ? undefined : `@${p.handle}`].filter(Boolean);

/** The accounts that follow `who`, each once, in key order: its account's followers, then its handle's. */
export async function followers(state, names, who) {
  const lists = await Promise.all(forms(await person(names, who)).map((t) => under(state, `followers/${t}/`)));
  return [...new Set(lists.flat())].filter(isAddress);
}

/**
 * Whom `account` follows, one entry a person, in key order: `{ account,
 * handle }` (the handle it shows, if any), or `{ handle }` for a followed
 * handle that no account shows now.
 */
export async function following(state, names, account) {
  if (!isAddress(account)) return [];
  const targets = await under(state, `follows/${account}/`);
  const handles = targets.filter((t) => t.startsWith("@") && isHandle(t.slice(1))).map((t) => t.slice(1));
  const viaHandle = new Map(handles.map((h, i) => [h, i]));
  const resolved = await accountsOf(names, handles);
  const accounts = targets.map((t) => (t.startsWith("@") ? resolved[viaHandle.get(t.slice(1))] : isAddress(t) ? t : undefined));
  const shown = await shownBy(names, accounts);
  const people = [];
  const seen = new Set();
  targets.forEach((t, i) => {
    const a = accounts[i];
    if (a === undefined) {
      if (t.startsWith("@") && isHandle(t.slice(1))) people.push({ handle: t.slice(1) });
      return;
    }
    if (seen.has(a)) return;
    seen.add(a);
    people.push(shown[i] === undefined ? { account: a } : { account: a, handle: shown[i] });
  });
  return people;
}

/** Whether `account` follows `who`, by its account or by the handle it shows. */
export async function follows(state, names, account, who) {
  if (!isAddress(account)) return false;
  const found = await Promise.all(forms(await person(names, who)).map((t) => state.get(`follows/${account}/${t}`)));
  return found.some((value) => value !== undefined);
}

/**
 * `account` follows `who`: its handle if it shows one, else its account.
 * Nothing to write when it already follows them either way.
 */
export async function follow(state, names, account, who) {
  needAccount(account);
  const p = await person(names, who);
  if (p.account === account) throw new Error("You can't follow yourself.");
  if (await follows(state, names, account, who)) return { actions: [] };
  const t = p.handle === undefined ? p.account : `@${p.handle}`;
  return { actions: [followKey(account, t), followerKey(account, t)].map((key) => ({ key, newValue: "1" })) };
}

/** `account` deletes its keys following `who`, by account and by handle; nothing to write when there are none. */
export async function unfollow(state, names, account, who) {
  needAccount(account);
  const actions = [];
  for (const t of forms(await person(names, who))) {
    const keys = [followKey(account, t), followerKey(account, t)];
    const oldValues = await Promise.all(keys.map((key) => state.get(key)));
    if (oldValues[0] !== undefined) actions.push(...keys.map((key, i) => ({ key, oldValue: oldValues[i] })));
  }
  return { actions };
}

/**
 * What `account` is saving, from transaction bodies not yet in a block, by
 * followed target (an address or `@<h>`): `true` for a follow, `false` for
 * an unfollow. A pending write may still be dropped, so it is never a
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
      if (isAddress(t) || (t.startsWith("@") && isHandle(t.slice(1)))) found[t] = action.newValue !== undefined;
    }
  }
  return found;
}
