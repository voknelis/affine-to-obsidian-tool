import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { sanitizeFilename } from "./paths.ts";

const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  "application/json": "json",
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/zip": "zip",
  "audio/flac": "flac",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "image/bmp": "bmp",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/webp": "webp",
  "text/csv": "csv",
  "text/html": "html",
  "text/markdown": "md",
  "text/plain": "txt",
  "video/mp4": "mp4",
  "video/ogg": "ogv",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

export class AssetError extends Error {
  override readonly name = "AssetError";
}

export interface AssetSourceReference {
  readonly documentId: string;
  readonly blockId: string;
}

export interface MissingAssetReference extends AssetSourceReference {
  readonly sourceId: string;
}

export interface AssetRequest {
  readonly sourceId: string;
  readonly name: string;
  readonly reference?: AssetSourceReference;
}

export interface AssetBlob {
  readonly data: Uint8Array;
  readonly mime: string;
  readonly deletedAt?: string | null;
}

export interface AssetManifestEntry {
  readonly sourceId: string;
  readonly status: "available";
  readonly path: string;
  readonly bytes: number;
  readonly mime: string;
  readonly sha256: string;
}

export interface ApprovedMissingAsset {
  readonly sourceId: string;
  readonly status: "missing";
}

export type AssetReference = AssetManifestEntry | ApprovedMissingAsset;
export type AssetBlobReader = (sourceId: string) => AssetBlob | undefined;

export class AssetCollection {
  readonly entries: readonly AssetReference[];
  readonly missing: readonly ApprovedMissingAsset[];
  private readonly bySourceId: ReadonlyMap<string, AssetReference>;

  constructor(entries: Iterable<AssetReference>) {
    const ordered = [...entries].sort((left, right) => left.sourceId.localeCompare(right.sourceId));
    const bySourceId = new Map<string, AssetReference>();
    for (const entry of ordered) {
      if (bySourceId.has(entry.sourceId)) {
        throw new AssetError(`Duplicate asset manifest entry for sourceId "${entry.sourceId}".`);
      }
      bySourceId.set(entry.sourceId, entry);
    }
    this.entries = ordered;
    this.missing = ordered.filter((entry) => entry.status === "missing");
    this.bySourceId = bySourceId;
  }

  require(sourceId: string): AssetReference {
    const entry = this.bySourceId.get(sourceId);
    if (entry === undefined) {
      throw new AssetError(`Asset "${sourceId}" was omitted from asset extraction results.`);
    }
    return entry;
  }
}

export interface ExtractAssetsOptions {
  readonly outputDirectory: string;
  readonly readBlob: AssetBlobReader;
  readonly allowMissing?: Iterable<string>;
}

interface PreparedAsset {
  readonly reference: Omit<AssetManifestEntry, "path">;
  readonly normalizedMime: string;
  readonly data: Uint8Array;
  readonly candidates: readonly string[];
}

export function normalizeMimeType(mime: string): string {
  return mime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function hasPrefix(data: Uint8Array, expected: readonly number[]): boolean {
  return expected.every((byte, index) => data[index] === byte);
}

function validateSignature(sourceId: string, mime: string, data: Uint8Array): void {
  let valid = true;
  if (mime === "image/png") {
    valid = hasPrefix(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  } else if (mime === "image/jpeg") {
    valid = hasPrefix(data, [0xff, 0xd8, 0xff]);
  } else if (mime === "image/webp") {
    valid = hasPrefix(data, [0x52, 0x49, 0x46, 0x46])
      && data.byteLength >= 12
      && hasPrefix(data.subarray(8), [0x57, 0x45, 0x42, 0x50]);
  } else if (mime === "image/svg+xml") {
    valid = /<svg(?:\s|>)/iu.test(new TextDecoder().decode(data));
  } else if (mime === "application/pdf") {
    valid = hasPrefix(data, [0x25, 0x50, 0x44, 0x46, 0x2d]);
  } else if (mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
    valid = hasPrefix(data, [0x50, 0x4b, 0x03, 0x04])
      || hasPrefix(data, [0x50, 0x4b, 0x05, 0x06])
      || hasPrefix(data, [0x50, 0x4b, 0x07, 0x08]);
  } else if (mime === "text/html") {
    valid = /<!doctype\s+html(?:\s|>)|<html(?:\s|>)/iu.test(new TextDecoder().decode(data));
  }
  if (!valid) {
    throw new AssetError(`Asset "${sourceId}" has a ${mime} signature mismatch.`);
  }
}

function candidatePath(name: string, sourceId: string, extension: string, digest: string): string {
  const extensionStart = name.lastIndexOf(".");
  const withoutExtension = extensionStart > 0 ? name.slice(0, extensionStart) : name;
  const suffix = `--${digest.slice(0, 12)}.${extension}`;
  const stem = sanitizeFilename(withoutExtension.length === 0 ? "asset" : withoutExtension, sourceId, suffix);
  return `assets/${stem}${suffix}`;
}

/**
 * Validate every requested blob before writing. Repeated IDs are read once and
 * equal bytes of the same normalized media type share one canonical output path.
 */
export async function extractAssets(
  requests: readonly AssetRequest[],
  options: ExtractAssetsOptions,
): Promise<AssetCollection> {
  const namesBySourceId = new Map<string, Set<string>>();
  for (const request of requests) {
    if (typeof request.sourceId !== "string" || request.sourceId.length === 0) {
      throw new AssetError("Asset requests require a non-empty sourceId.");
    }
    if (typeof request.name !== "string") {
      throw new AssetError(`Asset "${request.sourceId}" requires a string name.`);
    }
    const names = namesBySourceId.get(request.sourceId) ?? new Set<string>();
    names.add(request.name);
    namesBySourceId.set(request.sourceId, names);
  }

  const allowMissing = new Set(options.allowMissing ?? []);
  const prepared = new Map<string, PreparedAsset>();
  const missing: ApprovedMissingAsset[] = [];
  for (const sourceId of [...namesBySourceId.keys()].sort()) {
    const blob = options.readBlob(sourceId);
    if (blob === undefined) {
      if (!allowMissing.has(sourceId)) throw new AssetError(`Asset "${sourceId}" is missing.`);
      missing.push({ sourceId, status: "missing" });
      continue;
    }
    if (blob.deletedAt !== undefined && blob.deletedAt !== null) {
      throw new AssetError(`Asset "${sourceId}" is deleted.`);
    }
    if (!(blob.data instanceof Uint8Array) || blob.data.byteLength === 0) {
      throw new AssetError(`Asset "${sourceId}" is zero-length or has invalid bytes.`);
    }
    if (typeof blob.mime !== "string" || blob.mime.trim().length === 0) {
      throw new AssetError(`Asset "${sourceId}" has no MIME type.`);
    }
    const mime = normalizeMimeType(blob.mime);
    const extension = MIME_EXTENSIONS[mime];
    if (extension === undefined) {
      throw new AssetError(`Asset "${sourceId}" has unsupported MIME type "${blob.mime}".`);
    }
    validateSignature(sourceId, mime, blob.data);
    const digest = createHash("sha256").update(blob.data).digest("hex");
    const candidates = [...(namesBySourceId.get(sourceId) ?? [])]
      .map((name) => candidatePath(name, sourceId, extension, digest))
      .sort();
    prepared.set(sourceId, {
      reference: {
        sourceId,
        status: "available",
        bytes: blob.data.byteLength,
        mime: blob.mime,
        sha256: digest,
      },
      normalizedMime: mime,
      data: blob.data,
      candidates,
    });
  }

  const groups = new Map<string, {
    path: string;
    readonly data: Uint8Array;
    readonly assets: PreparedAsset[];
  }>();
  for (const asset of prepared.values()) {
    const key = `${asset.reference.sha256}\0${asset.normalizedMime}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        path: asset.candidates[0] ?? "",
        data: asset.data,
        assets: [asset],
      });
      continue;
    }
    group.assets.push(asset);
    for (const candidate of asset.candidates) {
      if (candidate < group.path) group.path = candidate;
    }
  }

  const pathGroups = new Map<string, string>();
  const orderedGroups = [...groups.entries()].sort(([, left], [, right]) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  );
  const entries: AssetReference[] = [...missing];
  for (const [key, group] of orderedGroups) {
    if (group.path.length === 0) {
      throw new AssetError(`Could not allocate an asset path for "${group.assets[0]?.reference.sourceId ?? "unknown"}".`);
    }
    const existingGroup = pathGroups.get(group.path);
    if (existingGroup !== undefined && existingGroup !== key) {
      throw new AssetError(`Asset path collision at "${group.path}".`);
    }
    pathGroups.set(group.path, key);

    const destination = join(options.outputDirectory, group.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, group.data, { flag: "wx" });
    for (const asset of group.assets) {
      entries.push({ ...asset.reference, path: group.path });
    }
  }

  return new AssetCollection(entries);
}

export interface ExtractSqliteAssetsOptions {
  readonly outputDirectory: string;
  readonly allowMissing?: Iterable<string>;
}

/** Extract assets through AFFiNE's blob table without trusting its size column. */
export async function extractSqliteAssets(
  sourcePath: string,
  requests: readonly AssetRequest[],
  options: ExtractSqliteAssetsOptions,
): Promise<AssetCollection> {
  const database = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    const statement = database.prepare(
      "SELECT data, mime, deleted_at FROM blobs WHERE key = ?",
    );
    return await extractAssets(requests, {
      outputDirectory: options.outputDirectory,
      allowMissing: options.allowMissing ?? [],
      readBlob: (sourceId) => {
        const row = statement.get(sourceId) as Record<string, unknown> | undefined;
        if (row === undefined) return undefined;
        if (!(row.data instanceof Uint8Array) || typeof row.mime !== "string") {
          throw new AssetError(`Asset "${sourceId}" has malformed SQLite blob data.`);
        }
        if (row.deleted_at !== null && row.deleted_at !== undefined && typeof row.deleted_at !== "string") {
          throw new AssetError(`Asset "${sourceId}" has an invalid deleted_at value.`);
        }
        return {
          data: row.data,
          mime: row.mime,
          deletedAt: row.deleted_at as string | null | undefined ?? null,
        };
      },
    });
  } finally {
    database.close();
  }
}
