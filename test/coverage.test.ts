import type { AffineBlock } from '../src/converters/types.ts'
import type { AffineDocument } from '../src/types.ts'
import assert from 'node:assert/strict'

import { it } from 'vitest'
import * as Y from 'yjs'
import { AssetCollection } from '../src/assets.ts'
import { convertPage } from '../src/converters/index.ts'
import { CoverageError, DocumentCoverageLedger } from '../src/coverage.ts'
import { buildPageRegistry } from '../src/page-registry.ts'
import { renderRichText } from '../src/richtext.ts'

function sourceBlock(
  doc: Y.Doc,
  id: string,
  flavour: string,
  children: string[] = [],
  text?: Y.Text,
  title?: Y.Text,
): AffineBlock {
  const source = new Y.Map<unknown>()
  source.set('sys:id', id)
  source.set('sys:flavour', flavour)
  const childArray = new Y.Array<string>()
  childArray.push(children)
  source.set('sys:children', childArray)
  if (text !== undefined) {
    source.set('prop:text', text)
  }
  if (title !== undefined) {
    source.set('prop:title', title)
  }
  doc.getMap<unknown>('blocks').set(id, source)
  return { id, flavour, children, source }
}

function registry(...ids: string[]) {
  return buildPageRegistry({
    pages: ids.map(id => ({ id, title: id, tags: [], trash: false })),
    tags: [],
    blockVersions: {},
  })
}

it('accounts for blocks and every rich-text delta with all three dispositions', () => {
  const doc = new Y.Doc()
  const title = new Y.Text('Title')
  const text = new Y.Text()
  const root = sourceBlock(doc, 'doc', 'affine:page', ['paragraph', 'missing'], undefined, title)
  const paragraph = sourceBlock(doc, 'paragraph', 'affine:paragraph', [], text)
  text.insert(0, 'plainred')
  text.format(5, 3, { color: 'red' })
  const missing = sourceBlock(doc, 'missing', 'affine:attachment')
  const ledger = new DocumentCoverageLedger('doc', [root, paragraph, missing])
  const pages = registry('doc')

  ledger.recordBlock('doc', 'structural/metadata-only')
  ledger.recordRichText(title, 'structural/metadata-only')
  ledger.recordBlock('paragraph', 'rendered')
  const rendered = renderRichText(text, pages, ledger)
  ledger.recordBlock('missing', 'approved-loss', 'Approved missing asset')

  assert.equal(rendered.markdown, 'plainred')
  const coverage = ledger.complete()
  assert.deepEqual(coverage.blocks, {
    total: 3,
    rendered: 1,
    structuralMetadataOnly: 1,
    approvedLoss: 1,
  })
  assert.deepEqual(coverage.richTextDeltas, {
    total: 3,
    rendered: 1,
    structuralMetadataOnly: 1,
    approvedLoss: 1,
  })
  assert.equal(coverage.items.length, 6)
  assert.deepEqual(coverage.items.find(item => item.kind === 'rich-text-delta' && item.deltaIndex === 1), {
    kind: 'rich-text-delta',
    blockId: 'paragraph',
    property: 'prop:text',
    deltaIndex: 1,
    disposition: 'approved-loss',
    reason: 'visual-color:color',
  })
})

it('silent block and rich-text delta skips are fatal when the ledger is completed', () => {
  const doc = new Y.Doc()
  const text = new Y.Text()
  const root = sourceBlock(doc, 'doc', 'affine:page', ['paragraph'])
  const paragraph = sourceBlock(doc, 'paragraph', 'affine:paragraph', [], text)
  text.insert(0, 'firstsecond')
  text.format(5, 6, { bold: true })

  const missingBlock = new DocumentCoverageLedger('doc', [root, paragraph])
  missingBlock.recordBlock('doc', 'structural/metadata-only')
  assert.throws(() => missingBlock.complete(), /unaccounted block.*paragraph/iu)

  const missingDelta = new DocumentCoverageLedger('doc', [root, paragraph])
  missingDelta.recordBlock('doc', 'structural/metadata-only')
  missingDelta.recordBlock('paragraph', 'rendered')
  missingDelta.recordRichTextDelta(text, 0, 'rendered')
  assert.throws(() => missingDelta.complete(), /unaccounted rich-text delta.*prop:text.*1/iu)
})

it('duplicate block and delta processing fails immediately', () => {
  const doc = new Y.Doc()
  const text = new Y.Text('content')
  const root = sourceBlock(doc, 'doc', 'affine:page', ['paragraph'])
  const paragraph = sourceBlock(doc, 'paragraph', 'affine:paragraph', [], text)
  const ledger = new DocumentCoverageLedger('doc', [root, paragraph])

  ledger.recordBlock('doc', 'structural/metadata-only')
  assert.throws(
    () => ledger.recordBlock('doc', 'rendered'),
    (error: unknown) => error instanceof CoverageError && /duplicate block.*doc/iu.test(error.message),
  )
  ledger.recordRichTextDelta(text, 0, 'rendered')
  assert.throws(() => ledger.recordRichTextDelta(text, 0, 'rendered'), /duplicate rich-text delta/iu)
})
it('colliding rich-text property paths are rejected during census', () => {
  const doc = new Y.Doc()
  const root = sourceBlock(doc, 'doc', 'affine:page')
  root.source.set('a.b', new Y.Text('root'))
  const nested = new Y.Map<unknown>()
  nested.set('b', new Y.Text('nested'))
  root.source.set('a', nested)

  assert.throws(
    () => new DocumentCoverageLedger('doc', [root]),
    (error: unknown) => error instanceof CoverageError
      && /duplicate rich-text source identity.*a\.b/iu.test(error.message),
  )
})

it('convertPage builds a complete ledger for structural, rendered, and code text', () => {
  const doc = new Y.Doc()
  sourceBlock(doc, 'doc', 'affine:page', ['note'], undefined, new Y.Text('Source title'))
  sourceBlock(doc, 'note', 'affine:note', ['paragraph', 'code'])
  const paragraphBlock = sourceBlock(doc, 'paragraph', 'affine:paragraph', [], new Y.Text('Paragraph'))
  paragraphBlock.source.set('prop:type', 'text')
  const code = sourceBlock(doc, 'code', 'affine:code', [], new Y.Text('const value = 1;'))
  code.source.set('prop:language', 'typescript')
  const document: AffineDocument = { id: 'doc', doc, snapshotApplied: true, updateCount: 0 }

  const result = convertPage(document, registry('doc'))
  assert.equal(result.coverage.documentId, 'doc')
  assert.deepEqual(result.coverage.blocks, {
    total: 4,
    rendered: 2,
    structuralMetadataOnly: 2,
    approvedLoss: 0,
  })
  assert.equal(result.coverage.richTextDeltas.total, 3)
  assert.equal(result.coverage.items.length, 7)
})

it('database child rows and approved missing assets are accounted during conversion', () => {
  const databaseDoc = new Y.Doc()
  sourceBlock(databaseDoc, 'doc', 'affine:page', ['database'], undefined, new Y.Text('Database'))
  const database = sourceBlock(databaseDoc, 'database', 'affine:database', ['row'])
  database.source.set('prop:columns', [{ id: 'title', name: 'Name', type: 'title', data: {} }])
  database.source.set('prop:views', [{ id: 'view', name: 'Table', mode: 'table', columns: [{ id: 'title' }] }])
  database.source.set('prop:cells', {})
  const row = sourceBlock(databaseDoc, 'row', 'affine:paragraph', [], new Y.Text('Row'))
  row.source.set('prop:type', 'text')

  const convertedDatabase = convertPage(
    { id: 'doc', doc: databaseDoc, snapshotApplied: true, updateCount: 0 },
    registry('doc'),
  )
  assert.equal(convertedDatabase.coverage.blocks.total, 3)
  assert.equal(convertedDatabase.coverage.blocks.rendered, 2)
  assert.match(convertedDatabase.markdown, /\| Row \|/u)

  const mediaDoc = new Y.Doc()
  sourceBlock(mediaDoc, 'doc', 'affine:page', ['attachment'], undefined, new Y.Text('Missing'))
  const attachment = sourceBlock(mediaDoc, 'attachment', 'affine:attachment')
  attachment.source.set('prop:sourceId', 'approved-missing')
  attachment.source.set('prop:name', 'missing.html')
  const convertedMedia = convertPage(
    { id: 'doc', doc: mediaDoc, snapshotApplied: true, updateCount: 0 },
    registry('doc'),
    { assets: new AssetCollection([{ sourceId: 'approved-missing', status: 'missing' }]) },
  )
  assert.equal(convertedMedia.coverage.blocks.approvedLoss, 1)
  assert.deepEqual(convertedMedia.warnings, [{
    kind: 'missing-asset',
    documentId: 'doc',
    blockId: 'attachment',
    sourceId: 'approved-missing',
    reason: 'Approved missing AFFiNE asset',
  }])
})

it('geometry-less edgeless rich text is visibly rendered and accounted exactly once', () => {
  const document = new Y.Doc()
  sourceBlock(document, 'doc', 'affine:page', ['surface'], undefined, new Y.Text('Canvas'))
  const surface = sourceBlock(document, 'surface', 'affine:surface', ['edgeless'])
  surface.source.set('prop:elements', { type: '$blocksuite:internal:native$', value: {} })
  const edgeless = sourceBlock(document, 'edgeless', 'affine:edgeless-text', [], new Y.Text('Recovered **canvas** text'))
  edgeless.source.set('prop:index', 'a1')
  const result = convertPage(
    { id: 'doc', doc: document, snapshotApplied: true, updateCount: 0 },
    registry('doc'),
  )
  assert.match(result.markdown, /Recovered \\\*\\\*canvas\\\*\\\* text/u)
  const deltas = result.coverage.items.filter(item => item.kind === 'rich-text-delta' && item.blockId === 'edgeless')
  assert.equal(deltas.length, 1)
  assert.equal(deltas[0]?.disposition, 'rendered')
})
