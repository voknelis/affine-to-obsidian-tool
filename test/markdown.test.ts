import assert from "node:assert/strict";
import test from "node:test";

import {
  escapeInlineCode,
  escapeMarkdownInlineText,
  escapeMarkdownText,
  escapeMarkdownUrl,
  escapeWikilinkAlias,
  escapeWikilinkTarget,
  normalizeExternalUrl,
} from "../src/markdown.ts";

test("escapes Markdown punctuation without changing ordinary Unicode text", () => {
  assert.equal(
    escapeMarkdownText("Привет, \\ * _ [ ] < > ` # + - ! | ~ = { } ( )"),
    "Привет, \\\\ \\* \\_ \\[ \\] \\< \\> \\` \\# \\+ \\- \\! \\| \\~ \\= \\{ \\} \\( \\)",
  );
  assert.equal(escapeMarkdownText("ordinary.text: café"), "ordinary.text: café");
});

test("escapes ordered-list markers and block syntax after multiline breaks", () => {
  assert.equal(
    escapeMarkdownText("first\n# heading\n- item\n1. item\n> quote"),
    "first\n\\# heading\n\\- item\n1\\. item\n\\> quote",
  );
});

test("escapes math, comments, entities, and parenthesized ordered markers literally", () => {
  assert.equal(escapeMarkdownText("$x$ and %%hidden%% and &copy;"), "\\$x\\$ and \\%\\%hidden\\%\\% and \\&copy;");
  assert.equal(escapeMarkdownText("1) item\n22. item"), "1\\) item\n22\\. item");
});

test("encodes code-block indentation on initial and continuation lines", () => {
  assert.equal(
    escapeMarkdownText("    initial\nnext\n\tTabbed\n    final"),
    "&#32;   initial\nnext\n&#9;Tabbed\n&#32;   final",
  );
});

test("normalizes inline labels and external URL schemes", () => {
  assert.equal(escapeMarkdownInlineText("first\r\nsecond\n*third*"), "first second \\*third\\*");
  assert.equal(normalizeExternalUrl("example.com/docs"), "https://example.com/docs");
  assert.equal(normalizeExternalUrl("//example.com/docs"), "https://example.com/docs");
  assert.equal(normalizeExternalUrl("mailto:user@example.com"), "mailto:user@example.com");
});

test("uses safe code-span delimiters and renders embedded newlines as spaces", () => {
  assert.equal(escapeInlineCode("a * b"), "`a * b`");
  assert.equal(escapeInlineCode("a ` b"), "``a ` b``");
  assert.equal(escapeInlineCode("`tick`"), "`` `tick` ``");
  assert.equal(escapeInlineCode("first\nsecond"), "`first second`");
});

test("escapes external URL delimiters while retaining a valid destination", () => {
  assert.equal(
    escapeMarkdownUrl("https://example.com/a b_(c)?x=<tag>\\"),
    "<https://example.com/a b_(c)?x=%3Ctag%3E%5C>",
  );
});

test("escapes wikilink targets and aliases, including multiline aliases", () => {
  assert.equal(escapeWikilinkTarget("_trash/A#B[1].md"), "_trash/A\\#B\\[1\\]");
  assert.equal(escapeWikilinkAlias("a | b ]\nnext"), "a \\| b \\] next");
});
