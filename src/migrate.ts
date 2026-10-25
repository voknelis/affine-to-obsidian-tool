import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename as fsRename,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, parse, relative, resolve, sep } from "node:path";
import * as Y from "yjs";

import { extractSqliteAssets, type AssetRequest } from "./assets.ts";
import {
  assertSupportedFlavours,
  BlockConversionError,
  CONVERTER_REGISTRY,
  convertPage,
  mediaAssetRequest,
} from "./converters/index.ts";
import type { DiagramAsset } from "./converters/types.ts";
import { REPORT_FILES } from "./migration-policy.ts";
import { inferPageParents } from "./page-hierarchy.ts";
import { buildPageRegistry } from "./page-registry.ts";
import { targetPathError } from "./path-guard.ts";
import { writeMigrationReports, type DocumentReportInput } from "./report.ts";
import { createConsistentBackup, decodeAffineWorkspaceBackup } from "./source.ts";
import type { AffineDocument, LoadedAffineWorkspace } from "./types.ts";
import {
  validateOutput,
  type OutputValidationSummary,
  type ValidateOutputOptions,
} from "./validate.ts";

export interface MigrateWorkspaceOptions {
  readonly source: string;
  readonly target: string;
  readonly allowMissing?: Iterable<string>;
  readonly dryRun: boolean;
}

export interface MigrationResult extends OutputValidationSummary {
  readonly dryRun: boolean;
}

/** Test seams for validating the real staging tree and injecting commit failures. */
export interface MigrateWorkspaceHooks {
  readonly validate?: (options: ValidateOutputOptions) => Promise<OutputValidationSummary>;
  readonly rename?: (oldPath: string, newPath: string) => Promise<void>;
}


async function canonicalPath(path: string): Promise<string> {
  const missingComponents: string[] = [];
  let current = path;
  for (;;) {
    try {
      const existingAncestor = await realpath(current);
      return resolve(existingAncestor, ...missingComponents.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missingComponents.push(basename(current));
      current = parent;
    }
  }
}

async function checkTargetComponents(target: string): Promise<void> {
  const root = parse(target).root;
  let current = root;
  for (const component of relative(root, target).split(sep)) {
    if (component.length === 0) continue;
    current = join(current, component);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) {
        throw new Error("Unsafe target path: symbolic link parents and targets are forbidden.");
      }
      if (current === target && !metadata.isDirectory()) {
        throw new Error("Unsafe target path: the existing target is not a directory.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function guardTarget(source: string, target: string): Promise<void> {
  if (basename(target) !== "from_affine") {
    throw new Error(`Unsafe target path: only a target named from_affine may be replaced.`);
  }
  const lexicalError = targetPathError(source, target, process.cwd(), homedir());
  if (lexicalError !== undefined) throw new Error(lexicalError);

  await checkTargetComponents(target);
  const [canonicalSource, canonicalTarget] = await Promise.all([
    canonicalPath(source),
    canonicalPath(target),
  ]);
  const canonicalError = targetPathError(canonicalSource, canonicalTarget, process.cwd(), homedir());
  if (canonicalError !== undefined) throw new Error(canonicalError);
}

function requireDocument(workspace: LoadedAffineWorkspace, id: string): AffineDocument {
  const document = workspace.documents.get(id);
  if (document === undefined) throw new Error(`AFFiNE page document ${id} is missing.`);
  return document;
}

/** Reject unknown flavours and collect media before creating any output files. */
function collectAssetRequests(workspace: LoadedAffineWorkspace, pageIds: readonly string[]): AssetRequest[] {
  const requests: AssetRequest[] = [];
  for (const pageId of pageIds) {
    const document = requireDocument(workspace, pageId);
    assertSupportedFlavours(document);
    for (const [key, value] of document.doc.getMap<unknown>("blocks").entries()) {
      if (!(value instanceof Y.Map)) continue;
      const flavour = value.get("sys:flavour");
      if (typeof flavour === "string" && !CONVERTER_REGISTRY.has(flavour)) {
        throw new BlockConversionError(
          `Unsupported AFFiNE block flavour "${flavour}" in document ${pageId}.`,
        );
      }
      if (flavour !== "affine:image" && flavour !== "affine:attachment") continue;
      const id = value.get("sys:id");
      const children = value.get("sys:children");
      if (typeof id !== "string" || id !== key || !(children instanceof Y.Array)) continue;
      requests.push({
        ...mediaAssetRequest({
          id,
          flavour,
          children: children.toArray().filter((child): child is string => typeof child === "string"),
          source: value,
        }),
        reference: { documentId: pageId, blockId: id },
      });
    }
  }
  return requests;
}

async function writeConvertedFile(root: string, path: string, contents: string | Uint8Array): Promise<void> {
  const destination = join(root, path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, contents, { flag: "wx" });
}

async function makeFilesDeterministic(root: string, paths: Iterable<string>): Promise<void> {
  const epoch = new Date(0);
  for (const path of paths) await utimes(join(root, path), epoch, epoch);
}

class RollbackFailureError extends AggregateError {
  constructor(commitError: unknown, rollbackError: unknown, recoveryPath: string) {
    super(
      [commitError, rollbackError],
      `Target replacement failed and the previous target could not be restored. Previous target remains recoverable at "${recoveryPath}".`,
    );
    this.name = "RollbackFailureError";
  }
}

async function commitStaging(
  staging: string,
  target: string,
  previousTarget: string,
  targetExists: boolean,
  rename: (oldPath: string, newPath: string) => Promise<void>,
): Promise<void> {
  if (!targetExists) {
    await rename(staging, target);
    return;
  }

  await rename(target, previousTarget);
  try {
    await rename(staging, target);
  } catch (commitError) {
    try {
      await rename(previousTarget, target);
    } catch (rollbackError) {
      throw new RollbackFailureError(commitError, rollbackError, previousTarget);
    }
    throw commitError;
  }
}

export async function migrateWorkspace(
  options: MigrateWorkspaceOptions,
  hooks: MigrateWorkspaceHooks = {},
): Promise<MigrationResult> {
  const source = resolve(options.source);
  const target = resolve(options.target);
  await guardTarget(source, target);

  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  const workRoot = await mkdtemp(join(parent, ".from_affine-migration-"));
  const staging = join(workRoot, "staging");
  const backup = join(workRoot, "backup.db");
  const previousTarget = join(workRoot, "previous-target");
  let workspace: LoadedAffineWorkspace | undefined;
  let preserveWorkRoot = false;

  try {
    await createConsistentBackup(source, backup);
    const sourceFingerprint = createHash("sha256").update(await readFile(backup)).digest("hex");
    workspace = await decodeAffineWorkspaceBackup(backup);
    const parents = inferPageParents(workspace);
    const pages = buildPageRegistry(workspace.metadata, parents);
    const pageIds = pages.pages.map((page) => page.id);
    const assetRequests = collectAssetRequests(workspace, pageIds);
    await mkdir(staging);
    const assets = await extractSqliteAssets(backup, assetRequests, {
      outputDirectory: staging,
      allowMissing: options.allowMissing ?? [],
    });
    const missingIds = new Set(assets.missing.map((asset) => asset.sourceId));
    const missingAssetReferences = assetRequests.flatMap((request) =>
      request.reference !== undefined && missingIds.has(request.sourceId)
        ? [{ ...request.reference, sourceId: request.sourceId }]
        : []);
    const documents: DocumentReportInput[] = [];
    const diagrams: DiagramAsset[] = [];
    const outputPaths: string[] = [];
    const expectedNotes = new Map<string, string>();
    for (const asset of assets.entries) {
      if (asset.status === "available") outputPaths.push(asset.path);
    }

    for (const page of pages.pages) {
      const converted = convertPage(requireDocument(workspace, page.id), pages, { assets });
      await writeConvertedFile(staging, page.outputPath, converted.markdown);
      expectedNotes.set(page.id, converted.markdown);
      outputPaths.push(page.outputPath);
      for (const diagram of converted.diagrams) {
        await writeConvertedFile(staging, diagram.path, diagram.contents);
        outputPaths.push(diagram.path);
        diagrams.push(diagram);
      }
      documents.push({
        documentId: page.id,
        coverage: converted.coverage,
        losses: converted.losses,
        warnings: converted.warnings,
      });
    }

    const report = await writeMigrationReports(staging, {
      workspaceId: workspace.workspaceId,
      sourceFingerprint,
      pages,
      assets,
      documents,
    });
    outputPaths.push(...REPORT_FILES);
    const validation = await (hooks.validate ?? validateOutput)({
      outputDirectory: staging,
      pages,
      assets,
      workspaceId: workspace.workspaceId,
      sourceFingerprint,
      coverage: documents.map((document) => document.coverage),
      expectedNotes,
      conversionLosses: documents.flatMap((document) =>
        document.losses.map((loss) => ({ documentId: document.documentId, ...loss }))),
      expectedDiagrams: new Map(diagrams.map((diagram) => [diagram.path, diagram.contents])),
      allowMissing: options.allowMissing ?? [],
      warnings: documents.flatMap((document) => document.warnings),
      missingAssetReferences,
    });
    await makeFilesDeterministic(staging, outputPaths);

    if (!options.dryRun) {
      await guardTarget(source, target);
      let targetExists = true;
      try {
        await lstat(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        targetExists = false;
      }
      await commitStaging(staging, target, previousTarget, targetExists, hooks.rename ?? fsRename);
    }

    return { ...validation, dryRun: options.dryRun, warnings: report.counts.warnings };
  } catch (error) {
    if (error instanceof RollbackFailureError) preserveWorkRoot = true;
    throw error;
  } finally {
    workspace?.destroy();
    if (!preserveWorkRoot) await rm(workRoot, { recursive: true, force: true });
  }
}
