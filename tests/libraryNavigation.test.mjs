import assert from "node:assert/strict";
import { getAdjacentIndex, getWheelDirection } from "../src/libraryNavigation.js";

assert.equal(getAdjacentIndex(0, 1, 6), 1);
assert.equal(getAdjacentIndex(5, 1, 6), 0);
assert.equal(getAdjacentIndex(0, -1, 6), 5);
assert.equal(getAdjacentIndex(2, 0, 6), 2);
assert.equal(getAdjacentIndex(2, 1, 0), -1);

assert.equal(getWheelDirection(60), 1);
assert.equal(getWheelDirection(-60), -1);
assert.equal(getWheelDirection(0), 0);

console.log("library navigation tests passed");
