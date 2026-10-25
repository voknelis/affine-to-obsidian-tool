import type { TestContext } from 'vitest'
import type { ConversionWarning } from '../src/converters/types.ts'
import type { DocumentCoverage } from '../src/coverage.ts'
import type { MigrationReportInput } from '../src/report.ts'
import assert from 'node:assert/strict'

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'vitest'
import { AssetCollection } from '../src/assets.ts'
import { buildPageRegistry } from '../src/page-registry.ts'
import {
  createMigrationReport,

  renderMigrationJson,
  renderMigrationMarkdown,
  writeMigrationReports,
} from '../src/report.ts'

const FINGERPRINT = 'a'.repeat(64)
const OTHER_FINGERPRINT = 'b'.repeat(64)

function coverage(documentId: string, blockIds: string[]): DocumentCoverage {
  return {
    documentId,
    blocks: {
      total: blockIds.length,
      rendered: Math.max(0, blockIds.length - 1),
      structuralMetadataOnly: 0,
      approvedLoss: Math.min(1, blockIds.length),
    },
    richTextDeltas: { total: 2, rendered: 1, structuralMetadataOnly: 0, approvedLoss: 1 },
    items: blockIds.map((blockId, index) => ({
      kind: 'block',
      blockId,
      disposition: index === 0 ? 'approved-loss' : 'rendered',
    })),
  }
}

function input(): MigrationReportInput {
  const pages = buildPageRegistry({
    pages: [
      { id: 'doc', title: 'Doc', tags: [], trash: false },
      { id: 'deleted', title: 'Deleted', tags: [], trash: true },
    ],
    tags: [],
    blockVersions: {},
  })
  const assets = new AssetCollection([
    { sourceId: 'missing-source', status: 'missing' },
    {
      sourceId: 'image-source',
      status: 'available',
      path: 'assets/image--abc.png',
      bytes: 11,
      mime: 'image/png',
      sha256: 'c'.repeat(64),
    },
  ])
  const missing: ConversionWarning = {
    kind: 'missing-asset',
    documentId: 'doc',
    blockId: 'attachment',
    sourceId: 'missing-source',
    reason: 'Approved missing AFFiNE asset',
  }
  const database: ConversionWarning = {
    kind: 'database-view-setting',
    documentId: 'doc',
    blockId: 'database',
    viewId: 'view',
    setting: 'layout',
    value: { z: 1, a: 2 },
    reason: 'Not representable',
  }
  const edgeless: ConversionWarning = {
    kind: 'edgeless-missing-group-child',
    documentId: 'doc',
    blockId: 'surface',
    groupId: 'group',
    childId: 'stale',
    reason: 'All existing elements are retained',
  }
  return {
    workspaceId: 'workspace-id',
    sourceFingerprint: FINGERPRINT,
    pages,
    assets,
    documents: [
      {
        documentId: 'deleted',
        coverage: coverage('deleted', ['deleted']),
        losses: [],
        warnings: [],
      },
      {
        documentId: 'doc',
        coverage: coverage('doc', ['attachment', 'paragraph', 'database', 'surface']),
        losses: [{ kind: 'visual-color', attribute: 'color', value: 'red', text: 'source text' }],
        warnings: [missing, database, edgeless],
      },
    ],
  }
}

it('json and Markdown reports are deterministic and summarize each document', () => {
  const first = createMigrationReport(input())
  const secondInput = input()
  const documents = [...secondInput.documents].reverse().map(document => ({
    ...document,
    warnings: [...document.warnings].reverse(),
  }))
  const second = createMigrationReport({ ...secondInput, documents })

  const json = renderMigrationJson(first)
  const markdown = renderMigrationMarkdown(first)
  assert.equal(json, renderMigrationJson(second))
  assert.equal(markdown, renderMigrationMarkdown(second))
  assert.ok(json.endsWith('\n'))
  assert.ok(markdown.endsWith('\n'))
  assert.equal(first.schemaVersion, 1)
  assert.equal(first.sourceFingerprint, FINGERPRINT)
  assert.deepEqual(first.pages, { deleted: '_trash/Deleted.md', doc: 'Doc.md' })
  assert.deepEqual(first.counts, {
    pages: 2,
    activePages: 1,
    trashPages: 1,
    assetReferences: 2,
    assetFiles: 1,
    blocks: 5,
    richTextDeltas: 4,
    warnings: 3,
    conversionLosses: 1,
  })
  assert.equal(first.coverage.documents.length, 2)
  assert.match(markdown, /\| doc \| 4 \| 3 \| 0 \| 1 \| 2 \|/u)
  assert.match(markdown, /## Missing assets[\s\S]*missing-source[\s\S]*doc.*attachment/u)
  assert.match(markdown, /## Conversion losses and warnings[\s\S]*visual-color[\s\S]*database-view-setting[\s\S]*edgeless-missing-group-child/u)
  assert.match(json, /"a": 2,\n\s+"z": 1/u)
})

it('source fingerprint is stable and is the only report change when it changes', () => {
  const original = createMigrationReport(input())
  const changedInput = { ...input(), sourceFingerprint: OTHER_FINGERPRINT }
  const changed = createMigrationReport(changedInput)

  assert.equal(renderMigrationJson(original), renderMigrationJson(createMigrationReport(input())))
  const originalWithoutFingerprint = structuredClone(original) as unknown as Record<string, unknown>
  const changedWithoutFingerprint = structuredClone(changed) as unknown as Record<string, unknown>
  delete originalWithoutFingerprint.sourceFingerprint
  delete changedWithoutFingerprint.sourceFingerprint
  assert.deepEqual(changedWithoutFingerprint, originalWithoutFingerprint)
  assert.equal(
    renderMigrationMarkdown(changed),
    renderMigrationMarkdown(original).replaceAll(FINGERPRINT, OTHER_FINGERPRINT),
  )
})

it('report writer emits only deterministic JSON/Markdown without runtime metadata', async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'affine-report-'))
  t.onTestFinished(async () => rm(directory, { recursive: true, force: true }))
  const report = await writeMigrationReports(directory, input())

  const json = await readFile(join(directory, '_affine-migration.json'), 'utf8')
  const markdown = await readFile(join(directory, '_affine-migration.md'), 'utf8')
  assert.equal(json, renderMigrationJson(report))
  assert.equal(markdown, renderMigrationMarkdown(report))
  assert.deepEqual(report.missingAssets, [{
    sourceId: 'missing-source',
    approved: true,
    references: [{ documentId: 'doc', blockId: 'attachment' }],
  }])
  for (const output of [json, markdown]) {
    assert.doesNotMatch(output, /generatedAt|generationTimestamp|cookie|accessToken|clientSecret/iu)
    assert.ok(!output.includes(directory))
  }
})

it('inline code uses dynamic delimiters for runs and leading or trailing backticks', () => {
  const base = input()
  const report = createMigrationReport({
    ...base,
    workspaceId: '`leading',
    documents: base.documents.map(document => document.documentId === 'doc'
      ? {
          ...document,
          losses: [{ kind: 'visual-color', attribute: 'color', value: 'trailing`', text: 'two``ticks' }],
        }
      : document),
  })
  const markdown = renderMigrationMarkdown(report)
  assert.match(markdown, /Workspace ID: `` `leading ``/u)
  assert.match(markdown, /`` trailing` ``/u)
  assert.match(markdown, /```two``ticks```/u)
  assert.doesNotMatch(markdown, /\\`/u)
})
