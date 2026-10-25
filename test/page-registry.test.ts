import assert from "node:assert/strict";
import test from "node:test";

import { buildPageRegistry } from "../src/page-registry.ts";
import type { AffinePageMetadata, AffineWorkspaceMetadata } from "../src/types.ts";

function page(
  id: string,
  title: string,
  overrides: Partial<AffinePageMetadata> = {},
): AffinePageMetadata {
  return { id, title, tags: [], trash: false, ...overrides };
}

function workspace(
  pages: AffinePageMetadata[],
  tags: AffineWorkspaceMetadata["tags"] = [],
): AffineWorkspaceMetadata {
  return { pages, tags, blockVersions: {} };
}

test("resolves duplicate titles and post-sanitization collisions by stable document ID", () => {
  const registry = buildPageRegistry(workspace([
    page("slash-id", "alpha/beta"),
    page("active-b", "Same"),
    page("trash-id", "Same", { trash: true }),
    page("backslash", "alpha\\beta"),
    page("active-a", "Same"),
  ]));

  assert.equal(registry.requirePath("active-a"), "Same.md");
  assert.equal(registry.requirePath("active-b"), "Same--active-b.md");
  assert.equal(registry.requirePath("backslash"), "alpha-beta.md");
  assert.equal(registry.requirePath("slash-id"), "alpha-beta--slash-id.md");
  assert.equal(registry.requirePath("trash-id"), "_trash/Same.md");
});

test("reserves report filenames case-insensitively with deterministic document-ID suffixes", () => {
  const registry = buildPageRegistry(workspace([
    page("report-b", "_AFFINE-MIGRATION"),
    page("report-json", "_affine-migration.json"),
    page("trash-report", "_affine-migration", { trash: true }),
    page("report-a", "_affine-migration"),
  ]));

  assert.equal(registry.requirePath("report-a"), "_affine-migration--report-a.md");
  assert.equal(registry.requirePath("report-b"), "_AFFINE-MIGRATION--report-b.md");
  assert.equal(registry.requirePath("report-json"), "_affine-migration.json.md");
  assert.equal(registry.requirePath("trash-report"), "_trash/_affine-migration.md");
  assert.ok(!registry.pages.map((page) => page.outputPath).some((path) =>
    path.toLowerCase() === "_affine-migration.md" || path.toLowerCase() === "_affine-migration.json"
  ));
});

test("bounds long note names while preserving collision suffixes and extensions", () => {
  const title = "界".repeat(200);
  const registry = buildPageRegistry(workspace([
    page("same-prefix-b", title),
    page("same-prefix-a", title),
    page("same-prefix-c", title),
  ]));

  for (const page of registry.pages) {
    const basename = page.outputPath.split("/").at(-1) ?? "";
    assert.ok(Buffer.byteLength(basename, "utf8") <= 255);
    assert.ok(basename.endsWith(".md"));
    assert.ok(!basename.includes("\ufffd"));
  }
  assert.ok(registry.requirePath("same-prefix-b").endsWith("--same-pre.md"));
  assert.ok(registry.requirePath("same-prefix-c").endsWith("--same-prefix-c.md"));
});

test("routes only deleted pages to flat _trash output", () => {
  const registry = buildPageRegistry(workspace([
    page("active", "Folder/Child"),
    page("deleted", "Folder/Child", { trash: true }),
  ]));

  assert.deepEqual(registry.pages.map(({ id, outputPath, trash }) => ({ id, outputPath, trash })), [
    { id: "active", outputPath: "Folder-Child.md", trash: false },
    { id: "deleted", outputPath: "_trash/Folder-Child.md", trash: true },
  ]);
});

test("preserves source dates, primary mode, trash dates, and resolved tag labels", () => {
  const registry = buildPageRegistry(workspace(
    [page("page-id", "A: page", {
      createDate: 0,
      updatedDate: 86_400_000,
      trash: true,
      trashDate: 172_800_000,
      primaryMode: "edgeless",
      tags: ["tag-2", "tag-1"],
    })],
    [
      { id: "tag-1", value: "Programming" },
      { id: "tag-2", value: 'needs: "review"' },
    ],
  ));

  assert.equal(registry.require("page-id").frontmatter, [
    "---",
    'title: "A: page"',
    'affine_id: "page-id"',
    "created: 1970-01-01T00:00:00.000Z",
    "updated: 1970-01-02T00:00:00.000Z",
    "trash: true",
    "trash_date: 1970-01-03T00:00:00.000Z",
    'affine_primary_mode: "edgeless"',
    'tags: ["needs: \\"review\\"", "Programming"]',
    "---",
    "",
  ].join("\n"));
});

test("omits absent optional frontmatter fields and emits an empty tag list", () => {
  const registry = buildPageRegistry(workspace([page("page-id", "")]));
  const frontmatter = registry.require("page-id").frontmatter;

  assert.match(frontmatter, /^---\ntitle: ""\naffine_id: "page-id"\ntrash: false\ntags: \[\]\n---\n$/);
  assert.equal(registry.requirePath("page-id"), "Untitled--page-id.md");
});

test("registry paths and iteration order are independent of source page order", () => {
  const pages = [
    page("page-c", "Café"),
    page("page-a", "Same"),
    page("page-b", "Same"),
  ];
  const forward = buildPageRegistry(workspace(pages));
  const reversed = buildPageRegistry(workspace([...pages].reverse()));

  assert.deepEqual(forward.pages, reversed.pages);
  assert.deepEqual(
    forward.pages.map((page) => [page.id, page.outputPath]),
    reversed.pages.map((page) => [page.id, page.outputPath]),
  );
  assert.deepEqual(forward.pages.map((entry) => entry.id), ["page-a", "page-b", "page-c"]);
});

test("rejects unknown page IDs and unknown source tag IDs explicitly", () => {
  const registry = buildPageRegistry(workspace([page("known", "Known")]));
  assert.throws(() => registry.requirePath("missing"), /Unknown AFFiNE page ID: missing/);
  assert.throws(
    () => buildPageRegistry(workspace([page("known", "Known", { tags: ["missing-tag"] })])),
    /Unknown AFFiNE tag ID: missing-tag/,
  );
});

test("allocates container notes and leaves from the inferred hierarchy", () => {
  const registry = buildPageRegistry(workspace([
    page("orphan", "Orphan"),
    page("leaf", "Leaf"),
    page("child", "Child"),
    page("root", "Root"),
  ]), new Map([
    ["leaf", "child"],
    ["child", "root"],
  ]));

  assert.equal(registry.requirePath("root"), "Root/Root.md");
  assert.equal(registry.requirePath("child"), "Root/Child/Child.md");
  assert.equal(registry.requirePath("leaf"), "Root/Child/Leaf.md");
  assert.equal(registry.requirePath("orphan"), "Orphan.md");
});

test("deduplicates only siblings and reuses titles in different directories", () => {
  const registry = buildPageRegistry(workspace([
    page("root-b", "B"),
    page("third", "Same"),
    page("second", "Same"),
    page("root-a", "A"),
    page("first", "Same"),
  ]), new Map([
    ["first", "root-a"],
    ["second", "root-a"],
    ["third", "root-b"],
  ]));

  assert.equal(registry.requirePath("first"), "A/Same.md");
  assert.equal(registry.requirePath("second"), "A/Same--second.md");
  assert.equal(registry.requirePath("third"), "B/Same.md");
});

test("mirrors ancestry inside trash without mixing active and deleted notes", () => {
  const registry = buildPageRegistry(workspace([
    page("active-child", "Active", { trash: false }),
    page("trash-parent", "TrashParent", { trash: true }),
    page("trash-child", "Deleted", { trash: true }),
    page("active-parent", "ActiveParent", { trash: false }),
  ]), new Map([
    ["active-child", "trash-parent"],
    ["trash-child", "active-parent"],
  ]));

  assert.equal(registry.requirePath("active-parent"), "ActiveParent/ActiveParent.md");
  assert.equal(registry.requirePath("trash-child"), "_trash/ActiveParent/Deleted.md");
  assert.equal(registry.requirePath("trash-parent"), "_trash/TrashParent/TrashParent.md");
  assert.equal(registry.requirePath("active-child"), "TrashParent/Active.md");
});

test("reserves output directory names for root container pages", () => {
  const registry = buildPageRegistry(workspace([
    page("assets", "assets"),
    page("child-a", "Child"),
    page("trash", "_trash"),
    page("child-b", "Child"),
  ]), new Map([
    ["child-a", "assets"],
    ["child-b", "trash"],
  ]));

  assert.equal(registry.requirePath("assets"), "assets--assets/assets--assets.md");
  assert.equal(registry.requirePath("child-a"), "assets--assets/Child.md");
  assert.equal(registry.requirePath("trash"), "_trash--trash/_trash--trash.md");
  assert.equal(registry.requirePath("child-b"), "_trash--trash/Child.md");
});

test("rejects unknown and cyclic explicit parent relationships", () => {
  const pages = [page("a", "A"), page("b", "B")];
  assert.throws(
    () => buildPageRegistry(workspace(pages), new Map([["a", "missing"]])),
    /unknown parent page ID: missing/,
  );
  assert.throws(
    () => buildPageRegistry(workspace(pages), new Map([["a", "b"], ["b", "a"]])),
    /hierarchy contains a cycle/,
  );
  assert.throws(
    () => buildPageRegistry(workspace(pages), new Map([["missing", "a"]])),
    /unknown child page ID: missing/,
  );
});

test("nested paths are independent of parent-map insertion order", () => {
  const pages = [page("root", "Root"), page("child", "Child"), page("leaf", "Leaf")];
  const forward = buildPageRegistry(workspace(pages), new Map([["child", "root"], ["leaf", "child"]]));
  const reversed = buildPageRegistry(workspace(pages), new Map([["leaf", "child"], ["child", "root"]]));
  assert.deepEqual(forward.pages, reversed.pages);
});

test("reserves a container note path against a same-title child", () => {
  const registry = buildPageRegistry(workspace([
    page("parent", "Root"),
    page("child", "Root"),
  ]), new Map([["child", "parent"]]));

  assert.equal(registry.requirePath("parent"), "Root/Root.md");
  assert.equal(registry.requirePath("child"), "Root/Root--child.md");
});

test("strips trailing dots and spaces after adding container ID suffixes", () => {
  const registry = buildPageRegistry(workspace([
    page("0-root", "Root"),
    page("abcdefg.", "Root"),
    page("child-a", "A"),
    page("child-b", "B"),
  ]), new Map([
    ["child-a", "0-root"],
    ["child-b", "abcdefg."],
  ]));

  const path = registry.requirePath("abcdefg.");
  assert.equal(path, "Root--abcdefg/Root--abcdefg.md");
  assert.ok(!path.split("/").some((component) => /[. ]$/u.test(component)));
});

test("separates parent note filenames from child directory names", () => {
  const registry = buildPageRegistry(workspace([
    page("parent", "Root"),
    page("child", "Root.md"),
    page("leaf", "Leaf"),
  ]), new Map([
    ["child", "parent"],
    ["leaf", "child"],
  ]));

  assert.equal(registry.requirePath("parent"), "Root/Root.md");
  assert.equal(registry.requirePath("child"), "Root/Root.md--child/Root.md--child.md");
  assert.equal(registry.requirePath("leaf"), "Root/Root.md--child/Leaf.md");
});

test("detects file-directory collisions between different sibling titles", () => {
  const registry = buildPageRegistry(workspace([
    page("parent", "Parent"),
    page("a-leaf", "Root"),
    page("b-container", "Root.md"),
    page("child", "Child"),
  ]), new Map([
    ["a-leaf", "parent"],
    ["b-container", "parent"],
    ["child", "b-container"],
  ]));

  assert.equal(registry.requirePath("a-leaf"), "Parent/Root.md");
  assert.equal(registry.requirePath("b-container"), "Parent/Root.md--b-contai/Root.md--b-contai.md");
});
