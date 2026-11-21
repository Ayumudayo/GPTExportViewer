import React, { memo, useEffect, useRef, useState } from "react";
import { copyMessageText } from "./chatReaderHelpers.js";

const h = React.createElement;
const INLINE_TOKEN_PATTERN_SOURCE =
  "(`[^`\\n]+`|\\*\\*[^*\\n]+?\\*\\*|~~[^~\\n]+?~~|!\\[([^\\]\\n]*)\\]\\(([^)\\s]+)\\)|\\[([^\\]\\n]+)\\]\\(([^)\\s]+)\\)|\\*[^*\\n]+?\\*|(?:^|(?<=[\\s(\\[\"']))_[^_\\n]+?_(?=$|[\\s)\\]\"'.,!?;:]))";

function countTextOccurrences(text, lowerQuery) {
  if (!text || !lowerQuery) return 0;
  const source = String(text);
  const lowerText = source.toLowerCase();
  if (!lowerText.includes(lowerQuery)) return 0;

  let cursor = 0;
  let count = 0;
  while (cursor < source.length) {
    const found = lowerText.indexOf(lowerQuery, cursor);
    if (found < 0) break;
    count += 1;
    cursor = found + lowerQuery.length;
  }
  return count;
}

function renderHighlightedText(text, highlightQuery, keyPrefix, matchState = null) {
  if (!text) return null;
  const query = typeof highlightQuery === "string" ? highlightQuery.trim() : "";
  if (!query) return text;

  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  if (!lowerQuery || !lowerText.includes(lowerQuery)) return text;

  const nodes = [];
  let cursor = 0;
  let matchIndex = 0;

  while (cursor < text.length) {
    const found = lowerText.indexOf(lowerQuery, cursor);
    if (found < 0) {
      nodes.push(text.slice(cursor));
      break;
    }
    if (found > cursor) {
      nodes.push(text.slice(cursor, found));
    }
    const ordinal = matchState ? matchState.index++ : -1;
    const isActive = Boolean(matchState && ordinal === matchState.activeIndex);
    nodes.push(
      h(
        "mark",
        {
          key: `${keyPrefix}-hl-${matchIndex}`,
          className: isActive ? "search-highlight active" : "search-highlight",
          "data-active-match": isActive ? "true" : undefined
        },
        text.slice(found, found + query.length)
      )
    );
    matchIndex += 1;
    cursor = found + query.length;
  }

  return nodes;
}

function isSafeLinkHref(href) {
  if (typeof href !== "string") return false;
  const trimmed = href.trim();
  if (!trimmed) return false;
  return /^(https?:|mailto:)/i.test(trimmed);
}

function isBlockedMediaScheme(src) {
  if (typeof src !== "string") return true;
  return /^(?:javascript|data|vbscript):/i.test(src.trim());
}

function countInlineTokenMatches(text, lowerQuery) {
  if (!text || !lowerQuery) return 0;
  const source = String(text);
  const tokenPattern = new RegExp(INLINE_TOKEN_PATTERN_SOURCE, "g");
  let cursor = 0;
  let count = 0;

  for (const match of source.matchAll(tokenPattern)) {
    const full = match[0];
    const start = match.index ?? 0;
    if (start > cursor) {
      count += countTextOccurrences(source.slice(cursor, start), lowerQuery);
    }

    if (full.startsWith("`") && full.endsWith("`")) {
      count += countTextOccurrences(full.slice(1, -1), lowerQuery);
    } else if (full.startsWith("**") && full.endsWith("**")) {
      count += countInlineTokenMatches(full.slice(2, -2), lowerQuery);
    } else if (full.startsWith("~~") && full.endsWith("~~")) {
      count += countInlineTokenMatches(full.slice(2, -2), lowerQuery);
    } else if ((full.startsWith("*") && full.endsWith("*")) || (full.startsWith("_") && full.endsWith("_"))) {
      count += countInlineTokenMatches(full.slice(1, -1), lowerQuery);
    } else if (match[2] !== undefined && match[3] !== undefined) {
      const alt = match[2];
      const src = match[3];
      const label = isSafeLinkHref(src) ? (alt || "Image") : isBlockedMediaScheme(src) ? full : (alt || src);
      count += countTextOccurrences(label, lowerQuery);
    } else if (match[4] !== undefined && match[5] !== undefined) {
      const label = match[4];
      const href = match[5];
      count += countTextOccurrences(isSafeLinkHref(href) ? label : full, lowerQuery);
    } else {
      count += countTextOccurrences(full, lowerQuery);
    }

    cursor = start + full.length;
  }

  if (cursor < source.length) {
    count += countTextOccurrences(source.slice(cursor), lowerQuery);
  }

  return count;
}

function renderInlineTokens(text, highlightQuery, keyPrefix, matchState = null) {
  if (!text) return null;
  const nodes = [];
  const tokenPattern = new RegExp(INLINE_TOKEN_PATTERN_SOURCE, "g");
  let cursor = 0;
  let tokenIndex = 0;

  for (const match of text.matchAll(tokenPattern)) {
    const full = match[0];
    const start = match.index ?? 0;
    if (start > cursor) {
      nodes.push(
        h(
          React.Fragment,
          { key: `${keyPrefix}-txt-${tokenIndex}` },
          renderHighlightedText(text.slice(cursor, start), highlightQuery, `${keyPrefix}-txt-${tokenIndex}`, matchState)
        )
      );
      tokenIndex += 1;
    }

    const tokenKey = `${keyPrefix}-tok-${tokenIndex}`;
    tokenIndex += 1;

    if (full.startsWith("`") && full.endsWith("`")) {
      const codeText = full.slice(1, -1);
      nodes.push(
        h(
          "code",
          { key: tokenKey, className: "md-inline-code" },
          renderHighlightedText(codeText, highlightQuery, tokenKey, matchState)
        )
      );
    } else if (full.startsWith("**") && full.endsWith("**")) {
      nodes.push(h("strong", { key: tokenKey }, renderInlineTokens(full.slice(2, -2), highlightQuery, tokenKey, matchState)));
    } else if (full.startsWith("~~") && full.endsWith("~~")) {
      nodes.push(h("del", { key: tokenKey }, renderInlineTokens(full.slice(2, -2), highlightQuery, tokenKey, matchState)));
    } else if ((full.startsWith("*") && full.endsWith("*")) || (full.startsWith("_") && full.endsWith("_"))) {
      nodes.push(h("em", { key: tokenKey }, renderInlineTokens(full.slice(1, -1), highlightQuery, tokenKey, matchState)));
    } else if (match[2] !== undefined && match[3] !== undefined) {
      const alt = match[2];
      const src = match[3];
      if (isSafeLinkHref(src)) {
        nodes.push(
          h(
            "a",
            {
              key: tokenKey,
              className: "md-link md-image-link",
              href: src,
              target: "_blank",
              rel: "noreferrer noopener"
            },
            renderHighlightedText(alt || "Image", highlightQuery, tokenKey, matchState)
          )
        );
      } else if (isBlockedMediaScheme(src)) {
        nodes.push(
          h(
            React.Fragment,
            { key: tokenKey },
            renderHighlightedText(full, highlightQuery, tokenKey, matchState)
          )
        );
      } else {
        nodes.push(
          h(
            "em",
            { key: tokenKey, className: "md-image-placeholder" },
            renderHighlightedText(alt || src, highlightQuery, tokenKey, matchState)
          )
        );
      }
    } else if (match[4] !== undefined && match[5] !== undefined) {
      const label = match[4];
      const href = match[5];
      if (isSafeLinkHref(href)) {
        nodes.push(
          h(
            "a",
            {
              key: tokenKey,
              className: "md-link",
              href,
              target: "_blank",
              rel: "noreferrer noopener"
            },
            renderHighlightedText(label, highlightQuery, tokenKey, matchState)
          )
        );
      } else {
        nodes.push(
          h(
            React.Fragment,
            { key: tokenKey },
            renderHighlightedText(full, highlightQuery, tokenKey, matchState)
          )
        );
      }
    } else {
      nodes.push(
        h(
          React.Fragment,
          { key: tokenKey },
          renderHighlightedText(full, highlightQuery, tokenKey, matchState)
        )
      );
    }

    cursor = start + full.length;
  }

  if (cursor < text.length) {
    nodes.push(
      h(
        React.Fragment,
        { key: `${keyPrefix}-tail` },
        renderHighlightedText(text.slice(cursor), highlightQuery, `${keyPrefix}-tail`, matchState)
      )
    );
  }

  return nodes;
}

function renderLinesWithBreaks(lines, highlightQuery, keyPrefix, matchState = null) {
  return lines.map((line, index) =>
    h(
      React.Fragment,
      { key: `${keyPrefix}-ln-${index}` },
      index > 0 ? h("br") : null,
      renderInlineTokens(line, highlightQuery, `${keyPrefix}-ln-${index}`, matchState)
    )
  );
}

function splitTableCells(line) {
  const trimmed = line.trim();
  const stripped = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  return stripped.split("|").map((cell) => cell.trim());
}

function isTableSeparatorLine(line, expectedColumns) {
  if (!line || !line.includes("|")) return false;
  const cells = splitTableCells(line);
  if (cells.length === 0) return false;
  if (expectedColumns && cells.length !== expectedColumns) return false;
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function parseTableAlignments(line) {
  return splitTableCells(line).map((cell) => {
    if (cell.startsWith(":") && cell.endsWith(":")) return "center";
    if (cell.endsWith(":")) return "right";
    if (cell.startsWith(":")) return "left";
    return undefined;
  });
}

function isHorizontalRule(line) {
  return /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line);
}

function parseHeading(line) {
  const match = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
  if (!match) return null;
  return { level: match[1].length, text: match[2] };
}

function parseListItem(line) {
  const unordered = line.match(/^(\s*)[-*+]\s+(.*)$/);
  if (unordered) {
    return { ordered: false, text: unordered[2] };
  }
  const ordered = line.match(/^(\s*)\d+[.)]\s+(.*)$/);
  if (ordered) {
    return { ordered: true, text: ordered[2] };
  }
  return null;
}

function parseFenceOpen(line) {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!match) return null;
  const marker = match[1];
  const info = match[2].trim();
  if (marker[0] === "`" && info.includes("`")) return null;
  return { markerChar: marker[0], markerLength: marker.length, language: info.split(/\s+/)[0] || "" };
}

function isFenceClose(line, openFence) {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
  if (!match) return false;
  return match[1][0] === openFence.markerChar && match[1].length >= openFence.markerLength;
}

function parseMarkdownBlocks(source) {
  const normalized = String(source ?? "").replace(/\r\n?/g, "\n");
  if (!normalized) return [];

  const lines = normalized.split("\n");
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = parseFenceOpen(line);
    if (fence) {
      index += 1;
      const codeLines = [];
      while (index < lines.length && !isFenceClose(lines[index], fence)) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      blocks.push({ type: "code", language: fence.language, content: codeLines.join("\n") });
      continue;
    }

    if (isHorizontalRule(line)) {
      blocks.push({ type: "hr" });
      index += 1;
      continue;
    }

    const heading = parseHeading(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading.level, text: heading.text });
      index += 1;
      continue;
    }

    if (line.includes("|") && index + 1 < lines.length) {
      const headers = splitTableCells(line);
      if (headers.length >= 2 && isTableSeparatorLine(lines[index + 1], headers.length)) {
        const alignments = parseTableAlignments(lines[index + 1]);
        index += 2;
        const rows = [];
        while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
          if (parseFenceOpen(lines[index])) break;
          rows.push(splitTableCells(lines[index]));
          index += 1;
        }
        blocks.push({ type: "table", headers, alignments, rows });
        continue;
      }
    }

    if (/^ {0,3}>\s?/.test(line)) {
      const quoteLines = [];
      while (index < lines.length && /^ {0,3}>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^ {0,3}>\s?/, ""));
        index += 1;
      }
      blocks.push({ type: "blockquote", lines: quoteLines });
      continue;
    }

    const firstList = parseListItem(line);
    if (firstList) {
      const ordered = firstList.ordered;
      const items = [firstList.text];
      index += 1;
      while (index < lines.length) {
        const current = lines[index];
        if (!current.trim()) break;
        const nextItem = parseListItem(current);
        if (nextItem && nextItem.ordered === ordered) {
          items.push(nextItem.text);
          index += 1;
        } else if (/^\s{2,}\S/.test(current) && !parseFenceOpen(current)) {
          items[items.length - 1] = `${items[items.length - 1]}\n${current.trim()}`;
          index += 1;
        } else {
          break;
        }
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    const paragraphLines = [line];
    index += 1;
    while (index < lines.length) {
      const nextLine = lines[index];
      if (
        !nextLine.trim() ||
        parseFenceOpen(nextLine) ||
        isHorizontalRule(nextLine) ||
        parseHeading(nextLine) ||
        parseListItem(nextLine) ||
        /^ {0,3}>\s?/.test(nextLine)
      ) {
        break;
      }
      if (nextLine.includes("|") && index + 1 < lines.length) {
        const maybeHeaders = splitTableCells(nextLine);
        if (maybeHeaders.length >= 2 && isTableSeparatorLine(lines[index + 1], maybeHeaders.length)) {
          break;
        }
      }
      paragraphLines.push(nextLine);
      index += 1;
    }
    blocks.push({ type: "paragraph", lines: paragraphLines });
  }

  return blocks;
}

export function countMarkdownHighlightMatches(text, highlightQuery) {
  if (!text) return 0;
  const query = typeof highlightQuery === "string" ? highlightQuery.trim() : "";
  if (!query) return 0;
  const lowerQuery = query.toLowerCase();
  const blocks = parseMarkdownBlocks(text);
  let total = 0;

  for (const block of blocks) {
    if (block.type === "code") {
      total += countTextOccurrences(block.content, lowerQuery);
    } else if (block.type === "heading") {
      total += countInlineTokenMatches(block.text, lowerQuery);
    } else if (block.type === "blockquote") {
      for (const line of block.lines) {
        total += countInlineTokenMatches(line, lowerQuery);
      }
    } else if (block.type === "list") {
      for (const item of block.items) {
        for (const line of item.split("\n")) {
          total += countInlineTokenMatches(line, lowerQuery);
        }
      }
    } else if (block.type === "table") {
      for (const header of block.headers) {
        total += countInlineTokenMatches(header, lowerQuery);
      }
      for (const row of block.rows) {
        for (let colIndex = 0; colIndex < block.headers.length; colIndex += 1) {
          total += countInlineTokenMatches(row[colIndex] || "", lowerQuery);
        }
      }
    } else if (block.type !== "hr") {
      for (const line of block.lines) {
        total += countInlineTokenMatches(line, lowerQuery);
      }
    }
  }

  return total;
}

function CodeBlock({ language, content, highlightQuery, activeMatchIndex = -1 }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    []
  );

  async function handleCopy() {
    const ok = await copyMessageText(content);
    if (!ok) return;
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 1600);
  }

  const codeMatchState = { index: 0, activeIndex: activeMatchIndex };

  return h(
    "div",
    { className: "code-block" },
    h(
      "div",
      { className: "code-head" },
      h("span", null, language || "code"),
      h("button", { type: "button", className: "code-copy-button", onClick: handleCopy }, copied ? "Copied" : "Copy code")
    ),
    h("pre", null, h("code", null, renderHighlightedText(content, highlightQuery, "code", codeMatchState)))
  );
}

export const MarkdownContent = memo(function MarkdownContent({ text, collapsed = false, highlightQuery = "", activeMatchIndex = -1 }) {
  const blocks = parseMarkdownBlocks(text);
  if (blocks.length === 0) return null;

  const query = typeof highlightQuery === "string" ? highlightQuery.trim() : "";
  const lowerQuery = query.toLowerCase();
  const matchState = { index: 0, activeIndex: activeMatchIndex };

  return h(
    "div",
    { className: collapsed ? "message-markdown collapsed" : "message-markdown" },
    blocks.map((block, index) => {
      const blockKey = `block-${index}`;

      if (block.type === "code") {
        const codeMatchCount = lowerQuery ? countTextOccurrences(block.content, lowerQuery) : 0;
        const blockStart = matchState.index;
        matchState.index += codeMatchCount;
        const activeInCode =
          activeMatchIndex >= blockStart && activeMatchIndex < blockStart + codeMatchCount
            ? activeMatchIndex - blockStart
            : -1;
        return h(CodeBlock, {
          key: blockKey,
          language: block.language,
          content: block.content,
          highlightQuery,
          activeMatchIndex: activeInCode
        });
      }

      if (block.type === "heading") {
        const Tag = `h${Math.min(6, Math.max(1, block.level))}`;
        return h(
          Tag,
          { key: blockKey, className: `md-heading md-h${block.level}` },
          renderInlineTokens(block.text, highlightQuery, blockKey, matchState)
        );
      }

      if (block.type === "blockquote") {
        return h(
          "blockquote",
          { key: blockKey, className: "md-quote" },
          renderLinesWithBreaks(block.lines, highlightQuery, blockKey, matchState)
        );
      }

      if (block.type === "list") {
        const ListTag = block.ordered ? "ol" : "ul";
        return h(
          ListTag,
          { key: blockKey, className: "md-list" },
          block.items.map((item, itemIndex) =>
            h(
              "li",
              { key: `${blockKey}-item-${itemIndex}` },
              renderLinesWithBreaks(item.split("\n"), highlightQuery, `${blockKey}-item-${itemIndex}`, matchState)
            )
          )
        );
      }

      if (block.type === "table") {
        return h(
          "div",
          { key: blockKey, className: "md-table-wrap" },
          h(
            "table",
            { className: "md-table" },
            h(
              "thead",
              null,
              h(
                "tr",
                null,
                block.headers.map((header, colIndex) =>
                  h(
                    "th",
                    {
                      key: `${blockKey}-h-${colIndex}`,
                      style: block.alignments[colIndex] ? { textAlign: block.alignments[colIndex] } : undefined
                    },
                    renderInlineTokens(header, highlightQuery, `${blockKey}-h-${colIndex}`, matchState)
                  )
                )
              )
            ),
            h(
              "tbody",
              null,
              block.rows.map((row, rowIndex) =>
                h(
                  "tr",
                  { key: `${blockKey}-r-${rowIndex}` },
                  block.headers.map((_, colIndex) =>
                    h(
                      "td",
                      {
                        key: `${blockKey}-r-${rowIndex}-c-${colIndex}`,
                        style: block.alignments[colIndex] ? { textAlign: block.alignments[colIndex] } : undefined
                      },
                      renderInlineTokens(row[colIndex] || "", highlightQuery, `${blockKey}-r-${rowIndex}-c-${colIndex}`, matchState)
                    )
                  )
                )
              )
            )
          )
        );
      }

      if (block.type === "hr") {
        return h("hr", { key: blockKey, className: "md-hr" });
      }

      return h(
        "p",
        {
          key: blockKey,
          className: collapsed && blocks.length === 1 ? "message-text collapsed" : "message-text"
        },
        renderLinesWithBreaks(block.lines, highlightQuery, blockKey, matchState)
      );
    })
  );
});
