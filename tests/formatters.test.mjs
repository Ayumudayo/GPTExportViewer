import assert from "node:assert/strict";
import { formatChatTimestamp, formatDate, formatExportLabel, formatShortDate } from "../src/data/formatters.js";

assert.equal(
  formatExportLabel({
    name: "3bd5c51b89af9329ce7f92691e2ebddbdde76597964f49f4aad2e533872e077ac-2026-06-09-10-00-20-15e4418a00b749c9b08684be44f9f741",
    modifiedAt: "2026-06-10T12:34:56.000Z"
  }),
  "2026-06-09 10:00:20"
);

assert.equal(
  formatExportLabel({
    name: "chatgpt-export-good",
    modifiedAt: "2026-06-10T12:34:56.000Z"
  }),
  "chatgpt-export-good"
);

assert.equal(
  formatExportLabel({
    name: "",
    modifiedAt: "2026-06-10T12:34:56.000Z"
  }),
  "2026-06-10 12:34:56"
);

assert.match(
  formatChatTimestamp("2026-06-09T10:00:20.000Z"),
  /2026/,
  "Chat timestamps should include the four-digit year"
);

// Numeric epoch-ms string inputs (legacy metadata/modifiedAt values)
assert.notEqual(
  formatDate("1717927220000", "Unknown"),
  "Unknown",
  "formatDate should parse numeric epoch-ms strings rather than falling back"
);
assert.equal(
  formatDate("1717927220000"),
  formatDate("2024-06-09T10:00:20.000Z"),
  "formatDate should format epoch-ms strings identically to equivalent ISO strings"
);
assert.equal(
  formatShortDate("1717927220000"),
  formatShortDate("2024-06-09T10:00:20.000Z"),
  "formatShortDate should format epoch-ms strings identically to equivalent ISO strings"
);
assert.equal(
  formatChatTimestamp("1717927220000"),
  formatChatTimestamp("2024-06-09T10:00:20.000Z"),
  "formatChatTimestamp should format epoch-ms strings identically to equivalent ISO strings"
);
assert.match(
  formatChatTimestamp("1717927220000"),
  /2024/,
  "formatChatTimestamp should include the year for numeric epoch-ms strings"
);
assert.equal(
  formatExportLabel({ name: "", modifiedAt: "1717927220000" }),
  "2024-06-09 10:00:20"
);

console.log("formatter tests passed");
