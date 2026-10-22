// Follows in a browser page, with the Lattice SDK included:
//
//   import { createFollows } from "https://cdn.jsdelivr.net/gh/adalinxx/follows@v0.4.0/src/browser.mjs";
//   const graph = createFollows({ moniker });  // moniker: createMoniker() from moniker-sdk; or with { nodes, chain }
//   defineFollowButton(graph);                 // then <follows-button target="@ada">
import * as sdk from "../vendor/lattice-sdk.js";
import { createFollows as create } from "./index.mjs";

export { DEFAULTS, isAddress, isHandle } from "./index.mjs";
export { defineFollowButton } from "./element.mjs";
export const createFollows = (options = {}) => create({ sdk, ...options });
