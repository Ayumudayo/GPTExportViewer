import assert from "node:assert/strict";
import { copyMessageText, computeMeasuredVirtualRange } from "../src/chatReaderHelpers.js";

{
  const copied = [];
  const fullText = "Full message text that should not be truncated before clipboard copy.\nSecond line kept intact.";
  const result = await copyMessageText(fullText, {
    writeText: async (value) => {
      copied.push(value);
    }
  });

  assert.equal(result, true, "Clipboard helper should report success when writeText resolves");
  assert.deepEqual(copied, [fullText], "Clipboard helper should pass the full message text through unchanged");
}

{
  const result = await copyMessageText("No clipboard available", null);
  assert.equal(result, false, "Clipboard helper should quietly no-op when clipboard support is unavailable");
}

{
  const result = await copyMessageText("Clipboard failure stays silent", {
    writeText: async () => {
      throw new Error("permission denied");
    }
  });
  assert.equal(result, false, "Clipboard helper should quietly no-op when clipboard writing throws");
}

{
  const range = computeMeasuredVirtualRange({
    itemKeys: ["a", "b", "c"],
    measuredHeights: { a: 44, b: 140, c: 58 },
    estimatedItemSize: 96,
    scrollOffset: 0,
    viewportSize: 120,
    overscan: 0
  });

  assert.deepEqual(
    range,
    {
      startIndex: 0,
      endIndex: 2,
      beforeSize: 0,
      afterSize: 58,
      totalSize: 242
    },
    "Measured virtual ranges should honor actual per-row heights instead of a fixed message size"
  );
}

{
  const range = computeMeasuredVirtualRange({
    itemKeys: ["a", "b", "c", "d"],
    measuredHeights: { b: 140, d: 120 },
    estimatedItemSize: 96,
    scrollOffset: 190,
    viewportSize: 110,
    overscan: 1
  });

  assert.deepEqual(
    range,
    {
      startIndex: 0,
      endIndex: 4,
      beforeSize: 0,
      afterSize: 0,
      totalSize: 452
    },
    "Measured virtual ranges should fall back to estimated heights for unseen rows while preserving scroll geometry"
  );
}

console.log("chat reader helper tests passed");
