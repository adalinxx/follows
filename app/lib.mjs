// The page's pure parts: what was typed into the search box, and which
// handles a filter keeps.
import { isHandle } from "../src/index.mjs";

/** The handle the search box names, `{ handle }`, with or without @, in any case; or null. */
export function parseWho(text) {
  const handle = String(text ?? "").trim().replace(/^@/, "").toLowerCase();
  return isHandle(handle) ? { handle } : null;
}

/** Whether a filter keeps a handle: it contains the query, ignoring case and @. */
export function matches(handle, query) {
  const q = String(query ?? "").trim().toLowerCase().replace(/^@/, "");
  return q === "" || handle.includes(q);
}

/** `1 follower`, `2 followers`, `1,204 following`. */
export const count = (n, one, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
