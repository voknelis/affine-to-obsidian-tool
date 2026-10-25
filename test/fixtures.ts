import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as Y from "yjs";

import type { AffineWorkspaceMetadata } from "../src/types.ts";

export interface SyntheticUpdate {
  data: Uint8Array;
  createdAt: string;
}

export interface SyntheticDocument {
  id: string;
  snapshot: Uint8Array;
  updates?: SyntheticUpdate[];
}

export interface SyntheticDatabaseOptions {
  workspaceId?: string;
  metadata?: AffineWorkspaceMetadata | null;
  workspaceSnapshot?: Uint8Array;
  documents?: SyntheticDocument[];
}

export function defaultWorkspaceMetadata(
  pageId = "page-1",
): AffineWorkspaceMetadata {
  return {
    name: "Synthetic workspace",
    pages: [
      {
        id: pageId,
        title: "First page",
        createDate: 1_700_000_000_000,
        updatedDate: 1_700_000_100_000,
        trash: false,
        primaryMode: "page",
        tags: ["tag-1"],
      },
      {
        id: "page-2",
        title: "Deleted page",
        createDate: 1_700_000_200_000,
        trash: true,
        trashDate: 1_700_000_300_000,
        tags: [],
      },
    ],
    tags: [
      {
        id: "tag-1",
        value: "Programming",
        color: "blue",
        createDate: 1_700_000_000_000,
        updateDate: 1_700_000_000_000,
      },
    ],
    workspaceVersion: 2,
    pageVersion: 2,
    blockVersions: { "affine:page": 2, "affine:paragraph": 1 },
  };
}

function setJsonValue(target: Y.Map<unknown>, key: string, value: unknown): void {
  if (Array.isArray(value)) {
    const array = new Y.Array<unknown>();
    target.set(key, array);
    for (const item of value) {
      if (item !== null && typeof item === "object") {
        const child = new Y.Map<unknown>();
        array.push([child]);
        for (const [childKey, childValue] of Object.entries(item)) {
          setJsonValue(child, childKey, childValue);
        }
      } else {
        array.push([item]);
      }
    }
    return;
  }

  if (value !== null && typeof value === "object") {
    const child = new Y.Map<unknown>();
    target.set(key, child);
    for (const [childKey, childValue] of Object.entries(value)) {
      setJsonValue(child, childKey, childValue);
    }
    return;
  }

  target.set(key, value);
}

export function encodeWorkspaceMetadata(
  metadata: AffineWorkspaceMetadata | null,
): Uint8Array {
  const doc = new Y.Doc();
  if (metadata !== null) {
    const meta = doc.getMap<unknown>("meta");
    const { tags, ...workspaceFields } = metadata;
    for (const [key, value] of Object.entries(workspaceFields)) {
      setJsonValue(meta, key, value);
    }
    setJsonValue(meta, "properties", { tags: { options: tags } });
  }
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

export function createTextDocument(
  id: string,
  snapshotText: string,
  updateSteps: ReadonlyArray<{ text: string; createdAt: string }> = [],
): SyntheticDocument {
  const doc = new Y.Doc({ guid: id });
  const text = doc.getText("content");
  text.insert(0, snapshotText);
  const snapshot = Y.encodeStateAsUpdate(doc);
  const updates: SyntheticUpdate[] = [];

  for (const step of updateSteps) {
    let data: Uint8Array | undefined;
    const capture = (update: Uint8Array) => {
      data = update;
    };
    doc.on("update", capture);
    text.insert(text.length, step.text);
    doc.off("update", capture);
    if (data === undefined) {
      throw new Error("The synthetic Yjs update was not captured.");
    }
    updates.push({ data, createdAt: step.createdAt });
  }

  doc.destroy();
  return { id, snapshot, updates };
}

export function createSyntheticDatabase(
  path: string,
  options: SyntheticDatabaseOptions = {},
): { path: string; workspaceId: string } {
  const workspaceId = options.workspaceId ?? "workspace-1";
  const metadata = options.metadata === undefined
    ? defaultWorkspaceMetadata()
    : options.metadata;
  const documents = options.documents ?? [createTextDocument("page-1", "snapshot")];
  mkdirSync(dirname(path), { recursive: true });

  const database = new DatabaseSync(path);
  try {
    database.exec(`
      CREATE TABLE meta (space_id TEXT NOT NULL);
      CREATE TABLE snapshots (
        doc_id TEXT PRIMARY KEY,
        data BLOB NOT NULL,
        created_at TEXT,
        updated_at TEXT
      );
      CREATE TABLE updates (
        doc_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        data BLOB NOT NULL
      );
    `);
    database.prepare("INSERT INTO meta (space_id) VALUES (?)").run(workspaceId);

    const insertSnapshot = database.prepare(
      "INSERT INTO snapshots (doc_id, data, created_at, updated_at) VALUES (?, ?, ?, ?)",
    );
    const insertUpdate = database.prepare(
      "INSERT INTO updates (doc_id, created_at, data) VALUES (?, ?, ?)",
    );
    const allDocuments = [
      {
        id: workspaceId,
        snapshot: options.workspaceSnapshot ?? encodeWorkspaceMetadata(metadata),
        updates: [],
      },
      ...documents,
    ];

    for (const document of allDocuments) {
      insertSnapshot.run(
        document.id,
        document.snapshot,
        "2026-01-01 00:00:00",
        "2026-01-01 00:00:00",
      );
      for (const update of document.updates ?? []) {
        insertUpdate.run(document.id, update.createdAt, update.data);
      }
    }
  } finally {
    database.close();
  }

  return { path, workspaceId };
}
