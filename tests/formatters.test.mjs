import assert from "node:assert/strict";
import { formatChatTimestamp, formatExportLabel } from "../src/data/formatters.js";

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

console.log("formatter tests passed");
