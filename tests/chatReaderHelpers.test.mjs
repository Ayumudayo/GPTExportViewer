import assert from "node:assert/strict";
import {
  buildMeasuredOffsets,
  computeMeasuredVirtualRange,
  computeVirtualRangeFromOffsets,
  copyMessageText
} from "../src/chatReaderHelpers.js";

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

{
  const offsets = buildMeasuredOffsets(["m1", "m2", "m3"], { m2: 150.2 }, 80);
  assert.deepEqual(
    offsets,
    [0, 80, 231, 311],
    "buildMeasuredOffsets should ceil measured heights and fall back to estimatedItemSize for unmeasured rows"
  );

  const rangeFromOffsets = computeVirtualRangeFromOffsets(offsets, 90, 140, 0, 80);
  assert.deepEqual(
    rangeFromOffsets,
    {
      startIndex: 1,
      endIndex: 2,
      beforeSize: 80,
      afterSize: 80,
      totalSize: 311
    },
    "computeVirtualRangeFromOffsets should compute visible range directly from precomputed offsets"
  );
}

console.log("chat reader helper tests passed");
