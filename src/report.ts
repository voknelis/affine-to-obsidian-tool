import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AssetCollection, AssetReference, AssetSourceReference } from "./assets.ts";
import type { ConversionWarning } from "./converters/types.ts";
import type { CoverageCounts, DocumentCoverage } from "./coverage.ts";
import { escapeInlineCode } from "./markdown.ts";
import { JSON_REPORT_FILENAME, MARKDOWN_REPORT_FILENAME } from "./migration-policy.ts";
import type { PageRegistry } from "./page-registry.ts";
import type { RichTextLoss } from "./richtext.ts";

export interface DocumentReportInput {
  readonly documentId: string;
  readonly coverage: DocumentCoverage;
  readonly losses: readonly RichTextLoss[];
  readonly warnings: readonly ConversionWarning[];
}

export interface MigrationReportInput {
  readonly workspaceId: string;
  readonly sourceFingerprint: string;
  readonly pages: PageRegistry;
  readonly assets: AssetCollection;
  readonly documents: readonly DocumentReportInput[];
}

export interface DocumentConversionLoss extends RichTextLoss {
  readonly documentId: string;
}


export interface MissingAssetReportEntry {
  readonly sourceId: string;
  readonly approved: true;
  readonly references: readonly AssetSourceReference[];
}

export interface MigrationReport {
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly sourceFingerprint: string;
  readonly pages: Readonly<Record<string, string>>;
  readonly assets: readonly AssetReference[];
  readonly coverage: {
    readonly documents: readonly DocumentCoverage[];
    readonly blocks: CoverageCounts;
    readonly richTextDeltas: CoverageCounts;
  };
  readonly warnings: readonly ConversionWarning[];
  readonly conversionLosses: readonly DocumentConversionLoss[];
  readonly missingAssets: readonly MissingAssetReportEntry[];
  readonly counts: {
    readonly pages: number;
    readonly activePages: number;
    readonly trashPages: number;
    readonly assetReferences: number;
    readonly assetFiles: number;
    readonly blocks: number;
    readonly richTextDeltas: number;
    readonly warnings: number;
    readonly conversionLosses: number;
  };
}

export class MigrationReportError extends Error {
  override readonly name = "MigrationReportError";
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new MigrationReportError("Reports cannot contain non-finite numbers.");
    return value;
  }
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => compare(left, right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  throw new MigrationReportError(`Reports cannot contain ${typeof value} values.`);
}

function normalizedWarning(warning: ConversionWarning): ConversionWarning {
  if (warning.kind === "missing-asset" || warning.kind === "edgeless-missing-group-child") {
    return { ...warning };
  }
  return { ...warning, value: stableValue(warning.value) };
}

function warningKey(warning: ConversionWarning): string {
  return JSON.stringify(normalizedWarning(warning));
}

function addCounts(target: { total: number; rendered: number; structuralMetadataOnly: number; approvedLoss: number }, counts: CoverageCounts): void {
  target.total += counts.total;
  target.rendered += counts.rendered;
  target.structuralMetadataOnly += counts.structuralMetadataOnly;
  target.approvedLoss += counts.approvedLoss;
}

export function createMigrationReport(input: MigrationReportInput): MigrationReport {
  if (input.workspaceId.trim().length === 0) throw new MigrationReportError("Workspace ID is required.");
  if (!/^[a-f0-9]{64}$/u.test(input.sourceFingerprint)) {
    throw new MigrationReportError("Source fingerprint must be a lowercase SHA-256 hex digest.");
  }
  const documents = [...input.documents].sort((left, right) => compare(left.documentId, right.documentId));
  const seen = new Set<string>();
  for (const document of documents) {
    if (seen.has(document.documentId)) {
      throw new MigrationReportError(`Duplicate report document "${document.documentId}".`);
    }
    seen.add(document.documentId);
    input.pages.require(document.documentId);
    if (document.coverage.documentId !== document.documentId) {
      throw new MigrationReportError(`Coverage document mismatch for "${document.documentId}".`);
    }
  }
  for (const page of input.pages.pages) {
    if (!seen.has(page.id)) throw new MigrationReportError(`Missing report document "${page.id}".`);
  }

  const coverageDocuments = documents.map((document) => document.coverage);
  const blocks = { total: 0, rendered: 0, structuralMetadataOnly: 0, approvedLoss: 0 };
  const richTextDeltas = { total: 0, rendered: 0, structuralMetadataOnly: 0, approvedLoss: 0 };
  for (const coverage of coverageDocuments) {
    addCounts(blocks, coverage.blocks);
    addCounts(richTextDeltas, coverage.richTextDeltas);
  }
  const warnings = documents.flatMap((document) => document.warnings)
    .map(normalizedWarning)
    .sort((left, right) => compare(warningKey(left), warningKey(right)));
  const conversionLosses = documents.flatMap((document) => document.losses.map((loss) => ({
    documentId: document.documentId,
    ...loss,
  }))).sort((left, right) => compare(JSON.stringify(left), JSON.stringify(right)));
  const assets = input.assets.entries.map((entry) => ({ ...entry }));
  const missingAssets = input.assets.missing.map((asset): MissingAssetReportEntry => ({
    sourceId: asset.sourceId,
    approved: true,
    references: warnings.filter((warning) => warning.kind === "missing-asset" && warning.sourceId === asset.sourceId)
      .map((warning) => ({ documentId: warning.documentId, blockId: warning.blockId }))
      .sort((left, right) => compare(left.documentId, right.documentId) || compare(left.blockId, right.blockId)),
  }));
  const missingIds = new Set(input.assets.missing.map((asset) => asset.sourceId));
  for (const warning of warnings) {
    if (warning.kind === "missing-asset" && !missingIds.has(warning.sourceId)) {
      throw new MigrationReportError(`Missing-asset warning "${warning.sourceId}" has no missing manifest entry.`);
    }
  }
  const pageEntries: Array<[string, string]> = input.pages.pages.map((page) => [page.id, page.outputPath]);
  const pages = Object.fromEntries(pageEntries.sort(([left], [right]) => compare(left, right)));
  const assetFiles = new Set(assets.filter((entry) => entry.status === "available").map((entry) => entry.path)).size;

  return {
    schemaVersion: 1,
    workspaceId: input.workspaceId,
    sourceFingerprint: input.sourceFingerprint,
    pages,
    assets,
    coverage: { documents: coverageDocuments, blocks, richTextDeltas },
    warnings,
    conversionLosses,
    missingAssets,
    counts: {
      pages: input.pages.pages.length,
      activePages: input.pages.pages.filter((page) => !page.trash).length,
      trashPages: input.pages.pages.filter((page) => page.trash).length,
      assetReferences: assets.length,
      assetFiles,
      blocks: blocks.total,
      richTextDeltas: richTextDeltas.total,
      warnings: warnings.length,
      conversionLosses: conversionLosses.length,
    },
  };
}

export function renderMigrationJson(report: MigrationReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}



function tableCell(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\r\n?|\n/gu, " ");
}

function warningDescription(warning: ConversionWarning): string {
  if (warning.kind === "missing-asset") {
    return `${escapeInlineCode(warning.kind)} — ${escapeInlineCode(warning.documentId)} / ${escapeInlineCode(warning.blockId)}, source ${escapeInlineCode(warning.sourceId)}: ${warning.reason}`;
  }
  if (warning.kind === "edgeless-missing-group-child") {
    return `${escapeInlineCode(warning.kind)} — ${escapeInlineCode(warning.documentId)} / ${escapeInlineCode(warning.blockId)}, group ${escapeInlineCode(warning.groupId)}, missing child ${escapeInlineCode(warning.childId)}: ${warning.reason}`;
  }
  return `${escapeInlineCode(warning.kind)} — ${escapeInlineCode(warning.documentId)} / ${escapeInlineCode(warning.blockId)}, view ${escapeInlineCode(warning.viewId)}, setting ${escapeInlineCode(warning.setting)}: ${warning.reason}; value ${escapeInlineCode(JSON.stringify(warning.value))}`;
}

export function renderMigrationMarkdown(report: MigrationReport): string {
  const lines = [
    "# AFFiNE migration report",
    "",
    `- Workspace ID: ${escapeInlineCode(report.workspaceId)}`,
    `- Source fingerprint: ${escapeInlineCode(report.sourceFingerprint)}`,
    `- Pages: ${report.counts.pages} (${report.counts.activePages} active, ${report.counts.trashPages} trash)`,
    `- Assets: ${report.counts.assetFiles} files from ${report.counts.assetReferences} source references`,
    `- Source coverage: ${report.counts.blocks} blocks and ${report.counts.richTextDeltas} rich-text deltas`,
    `- Conversion losses: ${report.counts.conversionLosses}; warnings: ${report.counts.warnings}`,
    "",
    "## Per-document coverage",
    "",
    "| Document | Blocks | Rendered | Structural/metadata-only | Approved loss | Rich-text deltas |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const document of report.coverage.documents) {
    lines.push(`| ${tableCell(document.documentId)} | ${document.blocks.total} | ${document.blocks.rendered} | ${document.blocks.structuralMetadataOnly} | ${document.blocks.approvedLoss} | ${document.richTextDeltas.total} |`);
  }
  lines.push("", "## Missing assets", "");
  if (report.missingAssets.length === 0) {
    lines.push("None.");
  } else {
    lines.push("| Source ID | Approved | Document / block references |", "| --- | --- | --- |");
    for (const asset of report.missingAssets) {
      const references = asset.references.length === 0
        ? "No converted reference"
        : asset.references.map((reference) => `${escapeInlineCode(reference.documentId)} / ${escapeInlineCode(reference.blockId)}`).join(", ");
      lines.push(`| ${escapeInlineCode(asset.sourceId)} | yes | ${references} |`);
    }
  }
  lines.push("", "## Conversion losses and warnings", "");
  if (report.conversionLosses.length === 0 && report.warnings.length === 0) {
    lines.push("None.");
  } else {
    for (const loss of report.conversionLosses) {
      lines.push(`- ${escapeInlineCode(loss.kind)} — ${escapeInlineCode(loss.documentId)}: ${loss.attribute} ${escapeInlineCode(loss.value)} on ${escapeInlineCode(loss.text)}`);
    }
    for (const warning of report.warnings) lines.push(`- ${warningDescription(warning)}`);
  }
  lines.push("");
  return lines.join("\n");
}

export async function writeMigrationReports(
  outputDirectory: string,
  input: MigrationReportInput,
): Promise<MigrationReport> {
  const report = createMigrationReport(input);
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(join(outputDirectory, JSON_REPORT_FILENAME), renderMigrationJson(report), "utf8"),
    writeFile(join(outputDirectory, MARKDOWN_REPORT_FILENAME), renderMigrationMarkdown(report), "utf8"),
  ]);
  return report;
}
