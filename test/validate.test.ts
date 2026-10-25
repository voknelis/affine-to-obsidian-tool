import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import { AssetCollection } from "../src/assets.ts";
import type { ConversionWarning } from "../src/converters/types.ts";
import type { DocumentCoverage } from "../src/coverage.ts";
import { buildPageRegistry, PageRegistry } from "../src/page-registry.ts";
import { validateOutput, type ValidateOutputOptions } from "../src/validate.ts";
import { writeMigrationReports, type DocumentConversionLoss } from "../src/report.ts";

const IMAGE = new TextEncoder().encode("image bytes");
const IMAGE_HASH = createHash("sha256").update(IMAGE).digest("hex");

function pages() {
  return buildPageRegistry({
    pages: [
      {
        id: "doc",
        title: "Doc",
        tags: ["tag"],
        trash: false,
        createDate: 0,
        updatedDate: 1000,
        primaryMode: "page",
      },
      { id: "deleted", title: "Deleted", tags: [], trash: true, trashDate: 2000, primaryMode: "edgeless" },
    ],
    tags: [{ id: "tag", value: "important" }],
    blockVersions: {},
  });
}

function coverage(documentId: string, blockIds: string[], approvedLossBlocks: readonly string[] = []): DocumentCoverage {
  const approved = new Set(approvedLossBlocks);
  return {
    documentId,
    blocks: {
      total: blockIds.length,
      rendered: blockIds.length - approved.size,
      structuralMetadataOnly: 0,
      approvedLoss: approved.size,
    },
    richTextDeltas: { total: 0, rendered: 0, structuralMetadataOnly: 0, approvedLoss: 0 },
    items: blockIds.map((blockId) => ({
      kind: "block",
      blockId,
      disposition: approved.has(blockId) ? "approved-loss" : "rendered",
      ...(approved.has(blockId) ? {
        reason: blockId === "attachment" ? "Approved missing asset approved-missing" : "Approved conversion warning",
      } : {}),
    })),
  };
}

function assets() {
  return new AssetCollection([
    {
      sourceId: "image-source",
      status: "available",
      path: "assets/image--abc.png",
      bytes: IMAGE.byteLength,
      mime: "image/png",
      sha256: IMAGE_HASH,
    },
    { sourceId: "approved-missing", status: "missing" },
  ]);
}

function warnings(): ConversionWarning[] {
  return [{
    kind: "missing-asset",
    documentId: "doc",
    blockId: "attachment",
    sourceId: "approved-missing",
    reason: "Approved missing AFFiNE asset",
  }];
}
function missingReferences(...blockIds: readonly string[]) {
  return blockIds.map((blockId) => ({
    documentId: "doc",
    blockId,
    sourceId: "approved-missing",
  }));
}


async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "affine-validate-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function put(root: string, path: string, contents: string | Uint8Array): Promise<void> {
  const destination = join(root, path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, contents);
}

function note(id: string, body = "Content"): string {
  const page = pages().require(id);
  return `${page.frontmatter}\n# ${page.title}\n\n${body}\n`;
}

async function writeReports(options: ValidateOutputOptions): Promise<void> {
  const conversionLosses = options.conversionLosses ?? [];
  await writeMigrationReports(options.outputDirectory, {
    workspaceId: options.workspaceId,
    sourceFingerprint: options.sourceFingerprint,
    pages: options.pages,
    assets: options.assets,
    documents: options.coverage.map((documentCoverage) => ({
      documentId: documentCoverage.documentId,
      coverage: documentCoverage,
      losses: conversionLosses
        .filter((loss) => loss.documentId === documentCoverage.documentId)
        .map(({ documentId: _documentId, ...loss }) => {
          void _documentId;
          return loss;
        }),
      warnings: (options.warnings ?? []).filter((warning) => warning.documentId === documentCoverage.documentId),
    })),
  });
}

async function validOptions(t: TestContext): Promise<ValidateOutputOptions> {
  const outputDirectory = await temporaryDirectory(t);
  const docMarkdown = note("doc", [
    "[[_trash/Deleted|deleted]]",
    "![[assets/image--abc.png]]",
    "![[assets/diagrams/doc--surface.svg]]",
    "> [!warning] Missing AFFiNE attachment",
    "> Document: `doc`",
    "> Source ID: `approved-missing`",
  ].join("\n\n"));
  const deletedMarkdown = note("deleted");
  await put(outputDirectory, "Doc.md", docMarkdown);
  await put(outputDirectory, "_trash/Deleted.md", deletedMarkdown);
  await put(outputDirectory, "assets/image--abc.png", IMAGE);
  await put(outputDirectory, "assets/diagrams/doc--surface.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>");
  const options: ValidateOutputOptions = {
    outputDirectory,
    workspaceId: "workspace",
    sourceFingerprint: "a".repeat(64),
    pages: pages(),
    assets: assets(),
    coverage: [
      coverage("doc", ["paragraph", "surface", "attachment"], ["attachment"]),
      coverage("deleted", ["deleted"]),
    ],
    expectedNotes: new Map([["doc", docMarkdown], ["deleted", deletedMarkdown]]),
    expectedDiagrams: new Map([["assets/diagrams/doc--surface.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"]]),
    allowMissing: ["approved-missing"],
    warnings: warnings(),
    missingAssetReferences: missingReferences("attachment"),
  };
  await writeReports(options);
  return options;
}

async function replaceExpectedNote(options: ValidateOutputOptions, id: string, markdown: string): Promise<void> {
  await put(options.outputDirectory, options.pages.requirePath(id), markdown);
  (options.expectedNotes as Map<string, string>).set(id, markdown);
}

test("reconciles pages, all wikilink/embed targets, asset hashes, and approved warnings", async (t) => {
  const options = await validOptions(t);
  const result = await validateOutput(options);
  assert.deepEqual(result, {
    files: 6,
    pages: 2,
    assetFiles: 2,
    warnings: 1,
  });
});

test("requires exactly the expected diagrams and rejects missing, unexpected, and corrupted nonempty SVGs", async (t) => {
  const missing = await validOptions(t);
  await rm(join(missing.outputDirectory, "assets/diagrams/doc--surface.svg"));
  await assert.rejects(validateOutput(missing), /missing diagram.*doc--surface\.svg/iu);

  const unexpected = await validOptions(t);
  await put(unexpected.outputDirectory, "assets/diagrams/unexpected.svg", "<svg>unexpected</svg>");
  await assert.rejects(validateOutput(unexpected), /unexpected output file.*unexpected\.svg/iu);

  for (const contents of ["<svg>truncated", "<svg xmlns=\"http://www.w3.org/2000/svg\">stale</svg>"]) {
    const corrupted = await validOptions(t);
    await put(corrupted.outputDirectory, "assets/diagrams/doc--surface.svg", contents);
    await assert.rejects(validateOutput(corrupted), /diagram content mismatch.*doc--surface\.svg/iu);
  }
});

test("rejects truncated note bodies and omitted required callouts against converted Markdown", async (t) => {
  for (const markdown of [
    `${pages().require("doc").frontmatter}\n`,
    note("doc", "unrelated surviving content"),
  ]) {
    const options = await validOptions(t);
    await put(options.outputDirectory, "Doc.md", markdown);
    await assert.rejects(validateOutput(options), /note Doc\.md content mismatch.*converted Markdown/iu);
  }

  const omittedCalloutOnly = await validOptions(t);
  const expected = omittedCalloutOnly.expectedNotes.get("doc");
  assert.ok(expected !== undefined);
  const callout = [
    "> [!warning] Missing AFFiNE attachment",
    "> Document: `doc`",
    "> Source ID: `approved-missing`",
  ].join("\n\n");
  await put(omittedCalloutOnly.outputDirectory, "Doc.md", expected.replace(`\n\n${callout}`, ""));
  await assert.rejects(validateOutput(omittedCalloutOnly), /content mismatch.*converted Markdown/iu);
});

test("requires exactly one expected converted note per registered page", async (t) => {
  const options = await validOptions(t);
  (options.expectedNotes as Map<string, string>).delete("doc");
  await assert.rejects(validateOutput(options), /missing expected converted note.*doc/iu);

  const extra = await validOptions(t);
  (extra.expectedNotes as Map<string, string>).set("unknown", "unexpected");
  await assert.rejects(validateOutput(extra), /unexpected expected converted note.*unknown/iu);
});

test("missing, extra, and mismatched notes fail page reconciliation", async (t) => {
  const missing = await validOptions(t);
  await rm(join(missing.outputDirectory, "Doc.md"));
  await assert.rejects(validateOutput(missing), /missing note.*Doc\.md/iu);

  const extra = await validOptions(t);
  await put(extra.outputDirectory, "Unexpected.md", "unexpected");
  await assert.rejects(validateOutput(extra), /unexpected output file.*Unexpected\.md/iu);

  const mismatched = await validOptions(t);
  await put(mismatched.outputDirectory, "Doc.md", note("doc").replace('affine_id: "doc"', 'affine_id: "other"'));
  await assert.rejects(validateOutput(mismatched), /frontmatter mismatch/iu);
});

test("every internal wikilink and embed target must resolve to a declared output", async (t) => {
  for (const target of ["Absent note", "assets/absent.png", "assets/diagrams/absent.svg"]) {
    const options = await validOptions(t);
    await replaceExpectedNote(options, "doc", note("doc", `![[${target}]]`));
    await assert.rejects(validateOutput(options), /unresolved internal target.*Absent note|unresolved internal target.*absent/iu);
  }
});

test("relative Markdown links and image embeds are validated", async (t) => {
  const valid = await validOptions(t);
  await replaceExpectedNote(valid, "doc", note("doc", "[deleted](_trash/Deleted.md)\n\n![image](assets/image--abc.png)\n\n| [[_trash/Deleted\\|deleted]] |\n| --- |"));
  await assert.doesNotReject(validateOutput(valid));

  const broken = await validOptions(t);
  await replaceExpectedNote(broken, "doc", note("doc", "![missing](assets/absent.png)"));
  await assert.rejects(validateOutput(broken), /unresolved internal target.*absent\.png/iu);
});

test("literal links in frontmatter, generated fences, and inline code are ignored", async (t) => {
  const options = await validOptions(t);
  const frontmatterPages = new PageRegistry(options.pages.pages.map((page) => page.id === "doc"
    ? {
        ...page,
        frontmatter: page.frontmatter.replace('title: "Doc"', 'title: "Doc [[missing]] [x](missing.md)"'),
      }
    : page));
  const frontmatterMarkdown = `${frontmatterPages.require("doc").frontmatter}\nContent\n`;
  const withFrontmatter = {
    ...options,
    pages: frontmatterPages,
    expectedNotes: new Map([["doc", frontmatterMarkdown], ["deleted", options.expectedNotes.get("deleted")!]]),
  };
  await put(withFrontmatter.outputDirectory, "Doc.md", frontmatterMarkdown);
  await assert.doesNotReject(validateOutput(withFrontmatter));

  const code = await validOptions(t);
  await replaceExpectedNote(code, "doc", note("doc", [
    "```markdown",
    "[[missing]]",
    "[x](missing.md)",
    "```",
    "`[[missing]]` and ``[x](missing.md)``",
    "[[_trash/Deleted]] and [deleted](_trash/Deleted.md)",
  ].join("\n\n")));
  await assert.doesNotReject(validateOutput(code));
});

test("real links adjacent to literal code links remain validated", async (t) => {
  for (const body of [
    "`[[ignored]]` [[missing]]",
    "```md\n[x](ignored.md)\n```\n\n[x](missing.md)",
  ]) {
    const options = await validOptions(t);
    await replaceExpectedNote(options, "doc", note("doc", body));
    await assert.rejects(validateOutput(options), /unresolved internal target.*missing/iu);
  }
});

test("asset existence, actual length, SHA-256, and unexpected files are validated", async (t) => {
  const missing = await validOptions(t);
  await rm(join(missing.outputDirectory, "assets/image--abc.png"));
  await assert.rejects(validateOutput(missing), /missing asset.*image--abc/iu);

  const changed = await validOptions(t);
  await put(changed.outputDirectory, "assets/image--abc.png", "changed");
  await assert.rejects(validateOutput(changed), /asset.*(?:length|SHA-256).*image--abc/iu);

  const unexpected = await validOptions(t);
  await put(unexpected.outputDirectory, "assets/unexpected.txt", "unexpected");
  await assert.rejects(validateOutput(unexpected), /unexpected output file.*unexpected\.txt/iu);
});

test("an output with zero files is fatal", async (t) => {
  const options = await validOptions(t);
  await rm(options.outputDirectory, { recursive: true, force: true });
  await mkdir(options.outputDirectory, { recursive: true });
  await assert.rejects(validateOutput(options), /zero files/iu);
});

test("zero-length notes, assets, diagrams, and reports are fatal", async (t) => {
  for (const path of [
    "Doc.md",
    "assets/image--abc.png",
    "assets/diagrams/doc--surface.svg",
    "_affine-migration.json",
    "_affine-migration.md",
  ]) {
    const options = await validOptions(t);
    await put(options.outputDirectory, path, "");
    await assert.rejects(validateOutput(options), /zero-length output file/iu);
  }
});

test("both saved migration reports are required", async (t) => {
  for (const path of ["_affine-migration.json", "_affine-migration.md"]) {
    const options = await validOptions(t);
    await rm(join(options.outputDirectory, path));
    await assert.rejects(validateOutput(options), new RegExp(`missing required report.*${path.replace(".", "\\.")}`, "iu"));
  }
});

test("approved missing assets pass while unapproved missing assets and warnings fail", async (t) => {
  const approved = await validOptions(t);
  await assert.doesNotReject(validateOutput(approved));

  const unapproved = await validOptions(t);
  await assert.rejects(
    validateOutput({ ...unapproved, allowMissing: [] }),
    /unapproved missing asset.*approved-missing/iu,
  );

  const unknownWarning = await validOptions(t);
  const invalid = { kind: "new-unreviewed-loss", documentId: "doc" } as unknown as ConversionWarning;
  await assert.rejects(
    validateOutput({ ...unknownWarning, warnings: [...warnings(), invalid] }),
    /unapproved conversion warning.*new-unreviewed-loss/iu,
  );
});

test("approved-loss blocks and warnings must have matching dispositions and identities", async (t) => {
  const missingMismatch = await validOptions(t);
  await assert.rejects(validateOutput({
    ...missingMismatch,
    coverage: [coverage("doc", ["paragraph", "surface", "attachment"]), missingMismatch.coverage[1]!],
  }), /missing-asset.*requires approved-loss/iu);

  const databaseMismatch = await validOptions(t);
  const databaseWarning: ConversionWarning = {
    kind: "database-view-setting",
    documentId: "doc",
    blockId: "surface",
    viewId: "view",
    setting: "layout",
    value: "table",
    reason: "Not representable",
  };
  await assert.rejects(
    validateOutput({ ...databaseMismatch, warnings: [...warnings(), databaseWarning] }),
    /database-view-setting.*requires approved-loss/iu,
  );

  const unexplainedBlock = await validOptions(t);
  await assert.rejects(validateOutput({
    ...unexplainedBlock,
    coverage: [
      coverage("doc", ["paragraph", "surface", "attachment"], ["attachment", "surface"]),
      unexplainedBlock.coverage[1]!,
    ],
  }), /unexplained approved-loss block.*surface/iu);
});

test("missing-asset losses require their specific warning kind and source identity", async (t) => {
  const omitted = await validOptions(t);
  await assert.rejects(
    validateOutput({ ...omitted, warnings: [] }),
    /missing-asset loss.*approved-missing.*specific missing-asset warning/iu,
  );

  const renderedWithoutWarning = await validOptions(t);
  await assert.rejects(validateOutput({
    ...renderedWithoutWarning,
    coverage: [coverage("doc", ["paragraph", "surface", "attachment"]), renderedWithoutWarning.coverage[1]!],
    warnings: [],
  }), /missing asset.*approved-missing.*missing-asset warning/iu);

  const wrongKind = await validOptions(t);
  const databaseWarning: ConversionWarning = {
    kind: "database-view-setting",
    documentId: "doc",
    blockId: "attachment",
    viewId: "view",
    setting: "layout",
    value: "table",
    reason: "Not representable",
  };
  await assert.rejects(
    validateOutput({ ...wrongKind, warnings: [databaseWarning] }),
    /missing-asset loss.*approved-missing.*specific missing-asset warning/iu,
  );

  const wrongSource = await validOptions(t);
  const otherAssets = new AssetCollection([
    ...wrongSource.assets.entries,
    { sourceId: "other-missing", status: "missing" },
  ]);
  await assert.rejects(validateOutput({
    ...wrongSource,
    assets: otherAssets,
    allowMissing: ["approved-missing", "other-missing"],
    warnings: [{
      kind: "missing-asset",
      documentId: "doc",
      blockId: "attachment",
      sourceId: "other-missing",
      reason: "Approved missing AFFiNE asset",
    }],
  }), /missing-asset loss.*approved-missing.*specific missing-asset warning/iu);
});
test("every repeated-source missing reference requires its own warning and approved loss", async (t) => {
  const base = await validOptions(t);
  const repeatedDocument = coverage("doc", ["paragraph", "surface", "attachment", "attachment-2"], ["attachment", "attachment-2"]);
  const repeatedCoverage: DocumentCoverage = {
    ...repeatedDocument,
    items: repeatedDocument.items.map((item) => item.blockId === "attachment-2"
      ? { ...item, reason: "Approved missing asset approved-missing" }
      : item),
  };
  const repeatedWarnings = [...warnings(), { ...warnings()[0]!, blockId: "attachment-2" }];
  const repeated: ValidateOutputOptions = {
    ...base,
    coverage: [repeatedCoverage, base.coverage[1]!],
    warnings: repeatedWarnings,
    missingAssetReferences: missingReferences("attachment", "attachment-2"),
  };
  await writeReports(repeated);
  await assert.doesNotReject(validateOutput(repeated));

  const omittedDocument: DocumentCoverage = {
    ...repeatedCoverage,
    blocks: {
      ...repeatedCoverage.blocks,
      rendered: repeatedCoverage.blocks.rendered + 1,
      approvedLoss: repeatedCoverage.blocks.approvedLoss - 1,
    },
    items: repeatedCoverage.items.map((item) => item.blockId === "attachment-2"
      ? { kind: "block", blockId: item.blockId, disposition: "rendered" }
      : item),
  };
  const omitted: ValidateOutputOptions = {
    ...repeated,
    coverage: [omittedDocument, base.coverage[1]!],
    warnings: [repeatedWarnings[0]!],
  };
  await writeReports(omitted);
  await assert.rejects(
    validateOutput(omitted),
    /missing asset.*approved-missing.*doc\/attachment-2.*exactly one.*received 0/iu,
  );
});

test("only own-property coverage dispositions are accepted and authorized", async (t) => {
  for (const disposition of ["constructor", "toString"]) {
    const base = await validOptions(t);
    const document = base.coverage[0]!;
    const inherited: DocumentCoverage = {
      ...document,
      blocks: {
        ...document.blocks,
        rendered: document.blocks.rendered - 1,
        approvedLoss: document.blocks.approvedLoss + 1,
      },
      items: document.items.map((item) => item.blockId === "paragraph"
        ? { ...item, disposition: disposition as DocumentCoverage["items"][number]["disposition"] }
        : item),
    };
    const options = { ...base, coverage: [inherited, base.coverage[1]!] };
    await writeReports(options);
    await assert.rejects(validateOutput(options), /unknown disposition/iu, disposition);
  }
});

test("rich-text approved losses reconcile exactly with structured conversion losses", async (t) => {
  const loss: DocumentConversionLoss = {
    documentId: "doc",
    kind: "visual-color",
    attribute: "color",
    value: "red",
    text: "source",
    blockId: "paragraph",
    property: "prop:text",
    deltaIndex: 0,
  };
  const unexplained = await validOptions(t);
  await assert.rejects(
    validateOutput({ ...unexplained, conversionLosses: [loss] }),
    /conversion losses.*reconcile/iu,
  );

  const base = await validOptions(t);
  const document = base.coverage[0]!;
  const withDelta: DocumentCoverage = {
    ...document,
    richTextDeltas: { total: 1, rendered: 0, structuralMetadataOnly: 0, approvedLoss: 1 },
    items: [...document.items, {
      kind: "rich-text-delta",
      blockId: "paragraph",
      property: "prop:text",
      deltaIndex: 0,
      disposition: "approved-loss",
      reason: "visual-color:color",
    }],
  };
  await assert.rejects(
    validateOutput({ ...base, coverage: [withDelta, base.coverage[1]!] }),
    /conversion losses.*reconcile/iu,
  );

  const authorized = { ...base, coverage: [withDelta, base.coverage[1]!], conversionLosses: [loss] };
  await writeReports(authorized);
  await assert.doesNotReject(validateOutput(authorized));
  await assert.rejects(
    validateOutput({ ...authorized, conversionLosses: [{ ...loss, deltaIndex: 1 }] }),
    /conversion losses.*reconcile/iu,
  );
  const { blockId: _blockId, ...missingIdentity } = loss;
  void _blockId;
  await assert.rejects(
    validateOutput({ ...authorized, conversionLosses: [missingIdentity] }),
    /missing.*source identity/iu,
  );
});

test("accepts only explicitly allowed missing native group child tuples", async (t) => {
  const base = await validOptions(t);
  const documentId = "document-id";
  const registry = buildPageRegistry({
    pages: [
      { id: documentId, title: "Doc", tags: [], trash: false },
      { id: "deleted", title: "Deleted", tags: [], trash: true },
    ],
    tags: [],
    blockVersions: {},
  });
  for (const page of registry.pages) {
    await put(base.outputDirectory, page.outputPath, `${page.frontmatter}\nContent\n`);
  }
  const warning: ConversionWarning = {
    kind: "edgeless-missing-group-child",
    documentId,
    blockId: "surface-id",
    groupId: "group-id",
    childId: "child-id",
    reason: "Approved stale native reference",
  };
  const options: ValidateOutputOptions = {
    ...base,
    pages: registry,
    coverage: [coverage(documentId, [warning.blockId]), coverage("deleted", ["deleted"])],
    assets: new AssetCollection(base.assets.entries.filter((asset) => asset.status === "available")),
    allowMissing: [],
    allowMissingGroupChildren: [{
      documentId,
      surfaceId: warning.blockId,
      groupId: warning.groupId,
      childId: warning.childId,
    }],
    warnings: [warning],
    missingAssetReferences: [],
    expectedNotes: new Map(registry.pages.map((page) => [page.id, `${page.frontmatter}\nContent\n`])),
  };
  await writeReports(options);
  await assert.doesNotReject(validateOutput(options));
  await assert.rejects(
    validateOutput({ ...options, allowMissingGroupChildren: [] }),
    /unapproved edgeless/iu,
  );

  for (const [field, value] of Object.entries({
    documentId: "other-document",
    blockId: "other-surface",
    groupId: "other-group",
    childId: "other-child",
  })) {
    await assert.rejects(
      validateOutput({ ...options, warnings: [{ ...warning, [field]: value }] }),
      /unapproved edgeless|unknown document|uncovered block/iu,
    );
  }
});

test("coverage must reconcile exactly one complete summary per registered page", async (t) => {
  const options = await validOptions(t);
  await assert.rejects(
    validateOutput({ ...options, coverage: options.coverage.slice(1) }),
    /missing coverage.*doc/iu,
  );
  await assert.rejects(
    validateOutput({ ...options, coverage: [...options.coverage, options.coverage[0]!] }),
    /duplicate coverage.*doc/iu,
  );
  const inconsistent = structuredClone(options.coverage[0]!);
  const inconsistentBlocks = { ...inconsistent.blocks, total: inconsistent.blocks.total + 1 };
  const inconsistentCoverage = { ...inconsistent, blocks: inconsistentBlocks };
  await assert.rejects(
    validateOutput({ ...options, coverage: [inconsistentCoverage, options.coverage[1]!] }),
    /coverage.*doc.*counts/iu,
  );
});

test("saved JSON ledger rejects corruption and stale pages, assets, coverage, warnings, and losses", async (t) => {
  type SavedManifest = {
    workspaceId: string;
    sourceFingerprint: string;
    pages: Record<string, string>;
    assets: Array<{ sha256: string }>;
    coverage: { blocks: { total: number } };
    warnings: Array<{ reason: string }>;
    conversionLosses: unknown[];
  };
  const mutations: ReadonlyArray<readonly [string, (manifest: SavedManifest) => void]> = [
    ["workspace ID", (manifest) => { manifest.workspaceId = "stale-workspace"; }],
    ["source fingerprint", (manifest) => { manifest.sourceFingerprint = "b".repeat(64); }],
    ["pages", (manifest) => { manifest.pages.doc = "Stale.md"; }],
    ["assets", (manifest) => { manifest.assets[0]!.sha256 = "0".repeat(64); }],
    ["coverage", (manifest) => { manifest.coverage.blocks.total += 1; }],
    ["warnings", (manifest) => { manifest.warnings[0]!.reason = "stale"; }],
    ["conversion losses", (manifest) => { manifest.conversionLosses.push({ kind: "visual-color" }); }],
  ];
  for (const [description, mutate] of mutations) {
    const options = await validOptions(t);
    const path = join(options.outputDirectory, "_affine-migration.json");
    const manifest = JSON.parse(await readFile(path, "utf8")) as SavedManifest;
    mutate(manifest);
    await put(options.outputDirectory, "_affine-migration.json", JSON.stringify(manifest));
    await assert.rejects(validateOutput(options), new RegExp(`JSON report.*stale.*conversion results`, "iu"), description);
  }

  for (const contents of ["{", "null", JSON.stringify({ workspaceId: "workspace", sourceFingerprint: "bad" })]) {
    const options = await validOptions(t);
    await put(options.outputDirectory, "_affine-migration.json", contents);
    await assert.rejects(validateOutput(options), /JSON report.*(?:corrupt|object|identity)/iu);
  }

  const markdown = await validOptions(t);
  await put(markdown.outputDirectory, "_affine-migration.md", "stale report\n");
  await assert.rejects(validateOutput(markdown), /Markdown report.*stale/iu);
});

test("complete saved frontmatter must match title, id, dates, trash, mode, and tags", async (t) => {
  const mutations = [
    ["Doc.md", "doc", 'title: "Doc"', 'title: "Wrong"'],
    ["Doc.md", "doc", 'affine_id: "doc"', 'affine_id: "wrong"'],
    ["Doc.md", "doc", "created: 1970-01-01T00:00:00.000Z", "created: 1971-01-01T00:00:00.000Z"],
    ["Doc.md", "doc", "updated: 1970-01-01T00:00:01.000Z", "updated: 1971-01-01T00:00:01.000Z"],
    ["Doc.md", "doc", "trash: false", "trash: true"],
    ["_trash/Deleted.md", "deleted", "trash_date: 1970-01-01T00:00:02.000Z", "trash_date: 1971-01-01T00:00:02.000Z"],
    ["Doc.md", "doc", 'affine_primary_mode: "page"', 'affine_primary_mode: "edgeless"'],
    ["Doc.md", "doc", 'tags: ["important"]', 'tags: ["wrong"]'],
  ] as const;
  for (const [path, id, original, replacement] of mutations) {
    const options = await validOptions(t);
    const changed = note(id).replace(original, replacement);
    assert.notEqual(changed, note(id), original);
    await put(options.outputDirectory, path, changed);
    await assert.rejects(validateOutput(options), /frontmatter mismatch/iu, original);
  }
});
