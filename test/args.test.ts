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
    dryRun: false,
  });
});

test("parses the explicit dry-run flag", () => {
  assert.deepEqual(parseArgs(["--source", "storage.db", "--dry-run"], cwd), {
    help: false,
    source: resolve(cwd, "storage.db"),
    target: resolve(cwd, "from_affine"),
    allowMissing: [],
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
