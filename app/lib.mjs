// The page's pure parts: what was typed into the search box, how a person
// is labelled, and which people a filter keeps.
import { isAddress, isHandle } from "../src/index.mjs";

/** Whom the search box names: `{ handle }` for a @handle, with or without @, in any case; `{ account }` for an address; or null. */
export function parseWho(text) {
  const typed = String(text ?? "").trim();
  if (isAddress(typed)) return { account: typed };
  const handle = typed.replace(/^@/, "").toLowerCase();
  return isHandle(handle) ? { handle } : null;
}

/** How a person shows: `@handle`, or the tail of an account that shows none. */
export const labelOf = (p) => (p.handle !== undefined ? `@${p.handle}` : `…${p.account.slice(-4)}`);

/** Where a person's page is: by handle while they show one, else by account. */
export const pathOf = (p) => (p.handle !== undefined ? `@${p.handle}` : p.account);

/** Whether a filter keeps a person: their label contains the query, ignoring case and @. */
export function matches(p, query) {
  const q = String(query ?? "").trim().toLowerCase().replace(/^@/, "");
  return q === "" || labelOf(p).replace(/^[@…]/, "").includes(q) || (p.account ?? "").includes(q);
}

/** `1 follower`, `2 followers`, `1,204 following`. */
export const count = (n, one, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
