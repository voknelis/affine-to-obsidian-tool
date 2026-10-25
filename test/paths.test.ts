import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeFilename, yamlString } from "../src/paths.ts";

test("preserves Cyrillic and normalizes filenames to Unicode NFC", () => {
  assert.equal(sanitizeFilename("Заметка о проекте", "document-id"), "Заметка о проекте");
  assert.equal(sanitizeFilename("Cafe\u0301", "document-id"), "Café");
});

test("gives empty and whitespace-only titles deterministic untitled names", () => {
  assert.equal(sanitizeFilename("", "abcdefgh-rest"), "Untitled--abcdefgh");
  assert.equal(sanitizeFilename("  . ", "abcdefgh-rest"), "Untitled--abcdefgh");
});

test("replaces path separators and Windows-forbidden characters", () => {
  assert.equal(sanitizeFilename("alpha/beta", "document-id"), "alpha-beta");
  assert.equal(sanitizeFilename("alpha\\beta", "document-id"), "alpha-beta");
  assert.equal(sanitizeFilename('a<b>c:d"e|f?g*h', "document-id"), "a-b-c-d-e-f-g-h");
  assert.equal(sanitizeFilename("name. ", "document-id"), "name");
  assert.equal(sanitizeFilename("name\u0000", "document-id"), "name-");
});

test("protects reserved Windows device names case-insensitively", () => {
  for (const name of ["CON", "con.txt", "PRN", "aux.md", "NUL", "COM1", "LPT9"]) {
    assert.equal(sanitizeFilename(name, "document-id"), `_${name}`);
  }
  assert.equal(sanitizeFilename("console", "document-id"), "console");
  assert.equal(sanitizeFilename("COM10", "document-id"), "COM10");
});

test("truncates by UTF-8 bytes at the exact component boundary", () => {
  const ascii = sanitizeFilename("a".repeat(400), "document-id", ".md");
  assert.equal(Buffer.byteLength(`${ascii}.md`, "utf8"), 255);
  assert.equal(ascii, "a".repeat(252));

  const suffix = "--abcdefghijkl.xlsx";
  const multibyte = sanitizeFilename("🙂".repeat(100), "document-id", suffix);
  assert.equal(Buffer.byteLength(`${multibyte}${suffix}`, "utf8"), 255);
  assert.equal(multibyte, "🙂".repeat(59));
  assert.ok(!multibyte.includes("\ufffd"));
});

test("keeps multibyte long names within the byte limit without splitting code points", () => {
  const result = sanitizeFilename("界".repeat(200), "document-id", ".md");
  assert.equal(result, "界".repeat(84));
  assert.equal(Buffer.byteLength(`${result}.md`, "utf8"), 255);
  assert.ok(Buffer.byteLength(`${result}界.md`, "utf8") > 255);
});

test("quotes YAML strings without allowing frontmatter injection", () => {
  assert.equal(yamlString('needs: "quotes"\nnext'), '"needs: \\"quotes\\"\\nnext"');
  assert.equal(yamlString("Кириллица #1"), '"Кириллица #1"');
});
