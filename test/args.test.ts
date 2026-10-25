import assert from "node:assert/strict";
import { homedir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { parseArgs } from "../src/args.ts";

const cwd = "/workspace";

test("parses absolute source and target paths", () => {
  assert.deepEqual(
    parseArgs(["--source", "/data/storage.db", "--target", "/output"], cwd),
    {
      help: false,
      source: "/data/storage.db",
      target: "/output",
      allowMissing: [],
      allowMissingGroupChildren: [],
      dryRun: false,
    },
  );
});

test("resolves relative paths and defaults target to from_affine", () => {
  assert.deepEqual(parseArgs(["--source", "data/storage.db"], cwd), {
    help: false,
    source: resolve(cwd, "data/storage.db"),
    target: resolve(cwd, "from_affine"),
    allowMissing: [],
    allowMissingGroupChildren: [],
    dryRun: false,
  });
});

test("collects repeatable allow-missing values in order", () => {
  const result = parseArgs(
    [
      "--source=storage.db",
      "--target=result",
      "--allow-missing",
      "first-id",
      "--allow-missing=second-id",
    ],
    cwd,
  );

  assert.deepEqual(result, {
    help: false,
    source: resolve(cwd, "storage.db"),
    target: resolve(cwd, "result"),
    allowMissing: ["first-id", "second-id"],
    allowMissingGroupChildren: [],
    dryRun: false,
  });
});

test("parses repeatable structured missing-group-child exceptions", () => {
  const result = parseArgs([
    "--source", "storage.db",
    "--allow-missing-group-child", "document:surface:group:child",
    "--allow-missing-group-child=document-2:surface-2:group-2:child-2",
  ], cwd);
  assert.deepEqual(result.help === false ? result.allowMissingGroupChildren : [], [
    { documentId: "document", surfaceId: "surface", groupId: "group", childId: "child" },
    { documentId: "document-2", surfaceId: "surface-2", groupId: "group-2", childId: "child-2" },
  ]);
});

test("rejects malformed missing-group-child exceptions", () => {
  for (const value of ["", "a:b:c", "a:b:c:d:e", "a::c:d", ":b:c:d", "a:b:c:"]) {
    assert.throws(
      () => parseArgs(["--source", "storage.db", `--allow-missing-group-child=${value}`], cwd),
      /allow-missing-group-child.*four|allow-missing-group-child.*non-empty|requires a value/iu,
    );
  }
});

test("parses the explicit dry-run flag", () => {
  assert.deepEqual(parseArgs(["--source", "storage.db", "--dry-run"], cwd), {
    help: false,
    source: resolve(cwd, "storage.db"),
    target: resolve(cwd, "from_affine"),
    allowMissing: [],
    allowMissingGroupChildren: [],
    dryRun: true,
  });
});

test("help does not require source", () => {
  assert.deepEqual(parseArgs(["--help"], cwd), { help: true });
  assert.deepEqual(parseArgs(["-h"], cwd), { help: true });
});

for (const args of [
  [],
  ["--target", "output"],
  ["--source"],
  ["--target"],
  ["--source", "storage.db", "--allow-missing"],
  ["--source", "storage.db", "--allow-missing="],
  ["--source", "storage.db", "--unknown"],
  ["--source", "storage.db", "unexpected"],
]) {
  test(`rejects missing, empty, or unknown arguments: ${JSON.stringify(args)}`, () => {
    assert.throws(() => parseArgs(args, cwd), { name: "CliUsageError" });
  });
}

test("rejects identical source and target after path normalization", () => {
  assert.throws(
    () =>
      parseArgs(
        ["--source", "data/storage.db", "--target", "data/../data/storage.db"],
        cwd,
      ),
    /source and target must be different/i,
  );
});

test("rejects filesystem root, working directory, and home as targets", () => {
  for (const target of ["/", cwd, homedir()]) {
    assert.throws(
      () => parseArgs(["--source", "/data/storage.db", "--target", target], cwd),
      /unsafe target/i,
    );
  }
});

test("rejects a target that contains the source database", () => {
  assert.throws(
    () => parseArgs(["--source", "/data/work/storage.db", "--target", "/data"], cwd),
    /unsafe target.*source/i,
  );
});
