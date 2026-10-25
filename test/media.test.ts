import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";

import { AssetCollection, AssetError, type AssetReference } from "../src/assets.ts";
import { convertMediaBlock, mediaAssetRequest } from "../src/converters/media.ts";
import { BlockConversionError, type AffineBlock, type BlockConversionContext } from "../src/converters/types.ts";
import { buildPageRegistry, PageRegistryError, type PageRegistry } from "../src/page-registry.ts";
import type { AffinePageMetadata } from "../src/types.ts";

function page(id: string, title: string, trash = false): AffinePageMetadata {
  return { id, title, tags: [], trash };
}

function registry(...pages: AffinePageMetadata[]): PageRegistry {
  return buildPageRegistry({ pages, tags: [], blockVersions: {} });
}

function block(
  flavour: string,
  properties: Readonly<Record<string, unknown>>,
  id = "media",
): AffineBlock {
  const document = new Y.Doc();
  const source = document.getMap<unknown>("blocks");
  source.set("sys:id", id);
  source.set("sys:flavour", flavour);
  source.set("sys:children", new Y.Array<string>());
  for (const [key, value] of Object.entries(properties)) source.set(key, value);
  return { id, flavour, children: [], source };
}

function context(pages: PageRegistry, documentId = "doc"): BlockConversionContext {
  return { documentId, pages, blocks: new Map(), losses: [] };
}

function assets(...entries: AssetReference[]): AssetCollection {
  return new AssetCollection(entries);
}

function available(sourceId: string, path: string, mime: string): AssetReference {
  return {
    sourceId,
    status: "available",
    path,
    bytes: 10,
    mime,
    sha256: "a".repeat(64),
  };
}

test("creates deterministic image requests and Obsidian embeds with optional captions", () => {
  const pages = registry(page("doc", "Document"));
  const image = block("affine:image", { "prop:sourceId": "image-id", "prop:caption": "" });
  const captioned = block("affine:image", {
    "prop:sourceId": "image-id",
    "prop:caption": "A [caption]",
  });
  const resolved = assets(available("image-id", "assets/image--0123456789ab.png", "image/png"));

  assert.deepEqual(mediaAssetRequest(image), { sourceId: "image-id", name: "image" });
  assert.equal(convertMediaBlock(image, context(pages), resolved), "![[assets/image--0123456789ab.png]]");
  assert.equal(
    convertMediaBlock(captioned, context(pages), resolved),
    "![[assets/image--0123456789ab.png|A \\[caption\\]]]",
  );
});

test("uses sanitized attachment names and selects embeds only for Obsidian-supported media", () => {
  const pages = registry(page("doc", "Document"));
  const cases = [
    ["application/pdf", "assets/report--0123456789ab.pdf", "![[assets/report--0123456789ab.pdf]]"],
    ["image/png", "assets/preview--0123456789ab.png", "![[assets/preview--0123456789ab.png]]"],
    ["audio/mpeg", "assets/sound--0123456789ab.mp3", "![[assets/sound--0123456789ab.mp3]]"],
    ["video/mp4", "assets/movie--0123456789ab.mp4", "![[assets/movie--0123456789ab.mp4]]"],
    ["text/html; charset=utf-8", "assets/saved--0123456789ab.html", "[[assets/saved--0123456789ab.html|saved.html]]"],
    ["application/json", "assets/layout--0123456789ab.json", "[[assets/layout--0123456789ab.json|layout.json]]"],
    ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "assets/sheet--0123456789ab.xlsx", "[[assets/sheet--0123456789ab.xlsx|sheet.xlsx]]"],
  ] as const;

  for (const [mime, path, expected] of cases) {
    const name = expected.includes("saved") ? "saved.html" : expected.includes("layout") ? "layout.json" : expected.includes("sheet") ? "sheet.xlsx" : "attachment";
    const attachment = block("affine:attachment", { "prop:sourceId": "asset-id", "prop:name": name });
    assert.deepEqual(mediaAssetRequest(attachment), { sourceId: "asset-id", name });
    assert.equal(
      convertMediaBlock(attachment, context(pages), assets(available("asset-id", path, mime))),
      expected,
    );
  }
});

test("renders the approved missing attachment as a warning callout without a broken link", () => {
  const approved = "smjDCoUasPTP7xbGv6P71V5ZCmvIl5Q2AR-85qlSVEw=";
  const pages = registry(page("doc", "Document"));
  const attachment = block("affine:attachment", { "prop:sourceId": approved, "prop:name": "saved.html" });

  const markdown = convertMediaBlock(
    attachment,
    context(pages, "opPyQsMhbrA-SL08aSBkz"),
    assets({ sourceId: approved, status: "missing" }),
  );

  assert.equal(markdown, [
    "> [!warning] Missing AFFiNE attachment",
    "> Document: `opPyQsMhbrA-SL08aSBkz`",
    `> Source ID: \`${approved}\``,
  ].join("\n"));
  assert.ok(!markdown.includes("[["));
});

test("rejects asset references omitted from extraction instead of emitting broken links", () => {
  const pages = registry(page("doc", "Document"));
  const image = block("affine:image", { "prop:sourceId": "unregistered" });

  assert.throws(
    () => convertMediaBlock(image, context(pages), assets()),
    (error: unknown) => error instanceof AssetError && /unregistered.*extraction/i.test(error.message),
  );
});

test("converts bookmarks and YouTube blocks to titled external links with caption fallback", () => {
  const pages = registry(page("doc", "Document"));
  const bookmark = block("affine:bookmark", {
    "prop:url": "https://example.com/a(b)?x=1",
    "prop:title": "A *bookmark*",
    "prop:caption": "Unused caption",
  });
  const youtube = block("affine:embed-youtube", {
    "prop:url": "https://www.youtube.com/watch?v=abc",
    "prop:title": null,
    "prop:caption": "Video caption",
  });
  const fallback = block("affine:embed-youtube", {
    "prop:url": "https://youtu.be/abc",
    "prop:title": "",
    "prop:caption": null,
  });

  assert.equal(
    convertMediaBlock(bookmark, context(pages), assets()),
    "[A \\*bookmark\\*](<https://example.com/a(b)?x=1>)",
  );
  assert.equal(
    convertMediaBlock(youtube, context(pages), assets()),
    "[Video caption](<https://www.youtube.com/watch?v=abc>)",
  );
  assert.equal(
    convertMediaBlock(fallback, context(pages), assets()),
    "[https://youtu.be/abc](<https://youtu.be/abc>)",
  );
});

test("normalizes bookmark and YouTube URLs and keeps labels on one line", () => {
  const pages = registry(page("doc", "Document"));
  const bookmark = block("affine:bookmark", {
    "prop:url": "example.com/docs",
    "prop:title": "First\n*Second*",
  });
  const youtube = block("affine:embed-youtube", {
    "prop:url": "//www.youtube.com/watch?v=test",
    "prop:caption": "Video\r\ncaption",
  });

  assert.equal(
    convertMediaBlock(bookmark, context(pages), assets()),
    "[First \\*Second\\*](<https://example.com/docs>)",
  );
  assert.equal(
    convertMediaBlock(youtube, context(pages), assets()),
    "[Video caption](<https://www.youtube.com/watch?v=test>)",
  );
});

test("converts linked documents through final active and trash registry paths", () => {
  const pages = registry(
    page("doc", "Document"),
    page("target", "Target"),
    page("deleted", "Archived", true),
  );
  const linked = block("affine:embed-linked-doc", { "prop:pageId": "target", "prop:caption": null });
  const captioned = block("affine:embed-linked-doc", {
    "prop:pageId": "deleted",
    "prop:caption": "Deleted [page]",
  });

  assert.equal(convertMediaBlock(linked, context(pages), assets()), "![[Target]]");
  assert.equal(
    convertMediaBlock(captioned, context(pages), assets()),
    "![[_trash/Archived|Deleted \\[page\\]]]",
  );
});

test("rejects malformed media properties, children, unsupported flavours, and unresolved pages", () => {
  const pages = registry(page("doc", "Document"));
  const malformed = [
    block("affine:image", { "prop:sourceId": "" }),
    block("affine:attachment", { "prop:sourceId": "id", "prop:name": 42 }),
    block("affine:bookmark", { "prop:url": undefined, "prop:title": "title" }),
    block("affine:embed-youtube", { "prop:url": "https://youtu.be/abc", "prop:caption": 42 }),
    block("affine:embed-linked-doc", { "prop:pageId": "unknown" }),
    block("affine:unknown", {}),
  ];
  const withChildren = block("affine:image", { "prop:sourceId": "id" });
  const invalidChildren = { ...withChildren, children: ["child"] };

  for (const value of [...malformed, invalidChildren]) {
    assert.throws(
      () => convertMediaBlock(value, context(pages), assets(available("id", "assets/image--a.png", "image/png"))),
      (error: unknown) => error instanceof BlockConversionError || error instanceof PageRegistryError,
    );
  }
});
