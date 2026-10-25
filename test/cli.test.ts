import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import * as Y from "yjs";

import { runCli } from "../src/cli.ts";
import { createSyntheticDatabase, defaultWorkspaceMetadata } from "./fixtures.ts";

function capture() {
  let value = "";
  return {
    stream: { write: (chunk: string) => { value += chunk; } },
    read: () => value,
  };
}

function cliFixture(root: string): string {
  const source = join(root, "storage.db");
  const doc = new Y.Doc({ guid: "page-1" });
  const blocks = doc.getMap<unknown>("blocks");
  const page = new Y.Map<unknown>();
  page.set("sys:id", "page-1");
  page.set("sys:flavour", "affine:page");
  const pageChildren = new Y.Array<string>();
  pageChildren.push(["note-1"]);
  page.set("sys:children", pageChildren);
  const title = new Y.Text();
  title.insert(0, "CLI page");
  page.set("prop:title", title);
  blocks.set("page-1", page);
  const note = new Y.Map<unknown>();
  note.set("sys:id", "note-1");
  note.set("sys:flavour", "affine:note");
  const noteChildren = new Y.Array<string>();
  noteChildren.push(["image-1"]);
  note.set("sys:children", noteChildren);
  blocks.set("note-1", note);
  const image = new Y.Map<unknown>();
  image.set("sys:id", "image-1");
  image.set("sys:flavour", "affine:image");
  image.set("sys:children", new Y.Array<string>());
  image.set("prop:sourceId", "cli-missing");
  image.set("prop:name", "missing");
  blocks.set("image-1", image);
  const snapshot = Y.encodeStateAsUpdate(doc);
  doc.destroy();

  const metadata = defaultWorkspaceMetadata();
  createSyntheticDatabase(source, {
    metadata: { ...metadata, pages: metadata.pages.slice(0, 1) },
    documents: [{ id: "page-1", snapshot }],
  });
  const database = new DatabaseSync(source);
  try {
    database.exec("CREATE TABLE blobs (key TEXT PRIMARY KEY, data BLOB NOT NULL, mime TEXT NOT NULL, deleted_at TEXT)");
  } finally {
    database.close();
  }
  return source;
}

async function sandbox(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "affine-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("help exits successfully and documents options and default target", async () => {
  const stdout = capture();
  const stderr = capture();

  const exitCode = await runCli(["--help"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    cwd: "/workspace",
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.read(), "");
  assert.match(stdout.read(), /Usage: affine-to-obsidian-tool/);
  assert.match(stdout.read(), /--source <path>/);
  assert.match(stdout.read(), /--target <path>/);
  assert.match(stdout.read(), /--allow-missing <source-id>/);
  assert.match(stdout.read(), /--allow-missing-group-child <documentId:surfaceId:groupId:childId>/);
  assert.match(stdout.read(), /--dry-run/);
  assert.match(stdout.read(), /default: .*from_affine/);
});

test("CLI migrates a synthetic workspace with explicit source, target and allow-missing", async (t) => {
  const root = await sandbox(t);
  const source = cliFixture(root);
  const target = join(root, "from_affine");
  const stdout = capture();
  const stderr = capture();

  const exitCode = await runCli([
    "--source", source,
    "--target", target,
    "--allow-missing", "cli-missing",
  ], { stdout: stdout.stream, stderr: stderr.stream, cwd: root });

  assert.equal(exitCode, 0, stderr.read());
  assert.equal(stderr.read(), "");
  assert.match(stdout.read(), /^Migrated 1 pages, 3 files, 0 asset files, 1 warnings\.\n$/u);
  assert.deepEqual((await readdir(target)).sort(), [
    "First page.md",
    "_affine-migration.json",
    "_affine-migration.md",
  ]);
  assert.match(await readFile(join(target, "First page.md"), "utf8"), /Missing AFFiNE image/u);
});

test("CLI dry-run validates and reports without creating or changing the target", async (t) => {
  const root = await sandbox(t);
  const source = cliFixture(root);
  const target = join(root, "from_affine");
  await mkdir(target);
  await writeFile(join(target, "keep.txt"), "unchanged");
  const stdout = capture();
  const stderr = capture();

  const exitCode = await runCli([
    "--source", source,
    "--target", target,
    "--allow-missing=cli-missing",
    "--dry-run",
  ], { stdout: stdout.stream, stderr: stderr.stream, cwd: root });

  assert.equal(exitCode, 0, stderr.read());
  assert.equal(stderr.read(), "");
  assert.match(stdout.read(), /^Dry run validated 1 pages, 3 files, 0 asset files, 1 warnings\.\n$/u);
  assert.deepEqual(await readdir(target), ["keep.txt"]);
  assert.equal(await readFile(join(target, "keep.txt"), "utf8"), "unchanged");
});

test("unsafe targets and migration failures exit with status 1 and concise stderr", async () => {
  for (const args of [
    [],
    ["--unknown"],
    ["--source"],
    ["--source", "/definitely/not/a/real/storage.db", "--target", "/output"],
  ]) {
    const stdout = capture();
    const stderr = capture();
    const exitCode = await runCli(args, {
      stdout: stdout.stream,
      stderr: stderr.stream,
      cwd: "/workspace",
    });

    assert.equal(exitCode, 1);
    assert.equal(stdout.read(), "");
    assert.match(stderr.read(), /^Error: .+\n/u);
  }
});

test("spawned executable failure preserves a valid target and cleans temporary files", async (t) => {
  const root = await sandbox(t);
  const source = join(root, "nonexistent.db");
  const target = join(root, "from_affine");
  await mkdir(target);
  await writeFile(join(target, "keep.txt"), "unchanged");
  const packageRoot = fileURLToPath(new URL("..", import.meta.url));

  const result = spawnSync(process.execPath, [
    "src/cli.ts",
    "--source", source,
    "--target", target,
  ], {
    cwd: packageRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^Error: .+\n$/u);
  assert.deepEqual(await readdir(root), ["from_affine"]);
  assert.deepEqual(await readdir(target), ["keep.txt"]);
  assert.equal(await readFile(join(target, "keep.txt"), "utf8"), "unchanged");
});

test("the executable entry point returns the documented help status", () => {
  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  const result = spawnSync(process.execPath, ["src/cli.ts", "--help"], {
    cwd: packageRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: affine-to-obsidian-tool/);
  assert.equal(result.stderr, "");
});
