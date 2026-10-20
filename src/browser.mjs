// Follows in a browser page, with the Lattice SDK included:
//
//   import { createFollows } from "https://cdn.jsdelivr.net/gh/adalinxx/follows@v0.1.0/src/browser.mjs";
//   const graph = createFollows();          // or createFollows({ nodes, chain })
import * as sdk from "../vendor/lattice-sdk.js";
import { createFollows as create } from "./index.mjs";

export { DEFAULTS, isAddress } from "./index.mjs";
export const createFollows = (options = {}) => create({ sdk, ...options });
