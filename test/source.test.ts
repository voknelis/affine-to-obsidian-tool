import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  createConsistentBackup,
  decodeAffineWorkspaceBackup,
  loadAffineWorkspace,
} from "../src/source.ts";
import {
  createSyntheticDatabase,
  createTextDocument,
  defaultWorkspaceMetadata,
  encodeWorkspaceMetadata,
} from "./fixtures.ts";

function temporaryDirectory(t: test.TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "affine-source-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}


test("creates an independent, consistent SQLite backup", async (t) => {
  const directory = temporaryDirectory(t);
  const source = join(directory, "source.db");
  const backup = join(directory, "backup.db");
  createSyntheticDatabase(source);

  await createConsistentBackup(source, backup);

  const sourceDatabase = new DatabaseSync(source);
  sourceDatabase
    .prepare("INSERT INTO snapshots (doc_id, data) VALUES (?, ?)")
    .run("later-document", encodeWorkspaceMetadata(null));
  sourceDatabase.close();

  const backupDatabase = new DatabaseSync(backup, { readOnly: true });
  try {
    assert.equal(
      backupDatabase.prepare("SELECT COUNT(*) AS count FROM snapshots").get()?.count,
      2,
    );
    assert.equal(
      backupDatabase.prepare("SELECT integrity_check FROM pragma_integrity_check()")
        .get()?.integrity_check,
      "ok",
    );
  } finally {
    backupDatabase.close();
  }
});

test("rejects a backup that fails SQLite integrity_check", async (t) => {
  const directory = temporaryDirectory(t);
  const source = join(directory, "source.db");
  createSyntheticDatabase(source);
  const database = new DatabaseSync(source);
  database.exec("CREATE TABLE filler (value TEXT)");
  for (let index = 0; index < 100; index += 1) {
    database.prepare("INSERT INTO filler VALUES (?)").run("x".repeat(1000));
  }
  const pageSize = database.prepare("PRAGMA page_size").get()?.page_size;
  const pageCount = database.prepare("PRAGMA page_count").get()?.page_count;
  database.close();
  if (typeof pageSize !== "number" || typeof pageCount !== "number") {
    throw new Error("Could not determine the synthetic SQLite page layout.");
  }
  const descriptor = openSync(source, "r+");
  try {
    writeSync(
      descriptor,
      Buffer.alloc(pageSize),
      0,
      pageSize,
      (pageCount - 1) * pageSize,
    );
  } finally {
    closeSync(descriptor);
  }

  await assert.rejects(
    loadAffineWorkspace(source, { tempRoot: directory }),
    /SQLite integrity check/i,
  );
  assert.deepEqual(readdirSync(directory), ["source.db"]);
});

test("loads typed workspace metadata, pages, tags, and block versions", async (t) => {
  const directory = temporaryDirectory(t);
  const source = join(directory, "source.db");
  createSyntheticDatabase(source);

  const workspace = await loadAffineWorkspace(source, { tempRoot: directory });
  t.after(() => workspace.destroy());

  assert.equal(workspace.workspaceId, "workspace-1");
  assert.deepEqual(workspace.metadata, defaultWorkspaceMetadata());
  assert.deepEqual([...workspace.documents.keys()].sort(), ["page-1", "workspace-1"]);
});

test("loads a snapshot with zero updates", async (t) => {
  const directory = temporaryDirectory(t);
  const source = join(directory, "source.db");
  createSyntheticDatabase(source, {
    documents: [createTextDocument("page-1", "snapshot only")],
  });

  const workspace = await loadAffineWorkspace(source, { tempRoot: directory });
  t.after(() => workspace.destroy());

  const document = workspace.documents.get("page-1");
  assert.ok(document);
  assert.equal(document.snapshotApplied, true);
  assert.equal(document.updateCount, 0);
  assert.equal(document.doc.getText("content").toJSON(), "snapshot only");
});

test("applies nonzero updates by created_at and then rowid", async (t) => {
  const directory = temporaryDirectory(t);
  const source = join(directory, "source.db");
  const document = createTextDocument("page-1", "A", [
    { text: "B", createdAt: "2026-01-01 00:00:01" },
    { text: "C", createdAt: "2026-01-01 00:00:01" },
    { text: "D", createdAt: "2026-01-01 00:00:02" },
  ]);
  assert.ok(document.updates);
  document.updates = [document.updates[2], document.updates[0], document.updates[1]]
    .filter((update) => update !== undefined);
  createSyntheticDatabase(source, { documents: [document] });

  const workspace = await loadAffineWorkspace(source, { tempRoot: directory });
  t.after(() => workspace.destroy());

  const loaded = workspace.documents.get("page-1");
  assert.ok(loaded);
  assert.equal(loaded.updateCount, 3);
  assert.equal(loaded.doc.getText("content").toJSON(), "ABCD");
});

test("rejects malformed snapshots and cleans temporary backup files", async (t) => {
  const directory = temporaryDirectory(t);
  const tempRoot = join(directory, "temporary");
  const source = join(directory, "source.db");
  createSyntheticDatabase(source, {
    documents: [{ id: "broken", snapshot: new Uint8Array([255, 255, 255, 255]) }],
  });

  await assert.rejects(
    loadAffineWorkspace(source, { tempRoot }),
    /snapshot.*broken|broken.*snapshot/i,
  );
  assert.deepEqual(readdirSync(tempRoot), []);
});

test("rejects missing workspace metadata and cleans temporary files", async (t) => {
  const directory = temporaryDirectory(t);
  const tempRoot = join(directory, "temporary");
  const source = join(directory, "source.db");
  createSyntheticDatabase(source, { metadata: null });

  await assert.rejects(
    loadAffineWorkspace(source, { tempRoot }),
    /workspace metadata/i,
  );
  assert.deepEqual(readdirSync(tempRoot), []);
});

test("opens the source read-only without changing bytes or creating sidecars", async (t) => {
  const directory = temporaryDirectory(t);
  const source = join(directory, "source.db");
  createSyntheticDatabase(source);
  const beforeHash = createHash("sha256").update(readFileSync(source)).digest("hex");
  const beforeMtime = statSync(source).mtimeMs;
  chmodSync(source, 0o444);

  const workspace = await loadAffineWorkspace(source, { tempRoot: directory });
  workspace.destroy();

  assert.equal(createHash("sha256").update(readFileSync(source)).digest("hex"), beforeHash);
  assert.equal(statSync(source).mtimeMs, beforeMtime);
  assert.equal(existsSync(`${source}-wal`), false);
  assert.equal(existsSync(`${source}-shm`), false);
});

test("removes its temporary backup directory after a successful load", async (t) => {
  const directory = temporaryDirectory(t);
  const tempRoot = join(directory, "temporary");
  const source = join(directory, "source.db");
  createSyntheticDatabase(source);

  const workspace = await loadAffineWorkspace(source, { tempRoot });
  workspace.destroy();

  assert.deepEqual(readdirSync(tempRoot), []);
});

test("decodes an existing verified backup without another temporary backup", async (t) => {
  const directory = temporaryDirectory(t);
  const source = join(directory, "source.db");
  const backup = join(directory, "backup.db");
  createSyntheticDatabase(source);
  await createConsistentBackup(source, backup);

  const workspace = await decodeAffineWorkspaceBackup(backup);
  t.after(() => workspace.destroy());

  assert.equal(workspace.workspaceId, "workspace-1");
  assert.deepEqual(workspace.metadata, defaultWorkspaceMetadata());
  assert.deepEqual(readdirSync(directory).sort(), ["backup.db", "source.db"]);
});
