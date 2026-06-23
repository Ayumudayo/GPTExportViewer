import assert from "node:assert/strict";
import { computeVirtualRange } from "../src/virtualWindow.js";

{
  const range = computeVirtualRange({
    itemCount: 100,
    scrollOffset: 0,
    viewportSize: 300,
    itemSize: 50,
    overscan: 2
  });

  assert.deepEqual(range, {
    startIndex: 0,
    endIndex: 8,
    beforeSize: 0,
    afterSize: 4600
  });
}

{
  const range = computeVirtualRange({
    itemCount: 100,
    scrollOffset: 1000,
    viewportSize: 300,
    itemSize: 50,
    overscan: 2
  });

  assert.deepEqual(range, {
    startIndex: 18,
    endIndex: 28,
    beforeSize: 900,
    afterSize: 3600
  });
}

{
  const range = computeVirtualRange({
    itemCount: 5,
    scrollOffset: 9000,
    viewportSize: 300,
    itemSize: 50,
    overscan: 2
  });

  assert.deepEqual(range, {
    startIndex: 0,
    endIndex: 5,
    beforeSize: 0,
    afterSize: 0
  });
}

console.log("virtual window tests passed");
