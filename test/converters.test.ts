import type { AffineDocument } from '../src/types.ts'
import assert from 'node:assert/strict'
import { it } from 'vitest'

import * as Y from 'yjs'
import { CONVERTER_REGISTRY, convertPage } from '../src/converters/index.ts'
import { buildPageRegistry } from '../src/page-registry.ts'

const DISCOVERED_FLAVOURS = [
  'affine:paragraph',
  'affine:list',
  'affine:note',
  'affine:page',
  'affine:surface',
  'affine:image',
  'affine:edgeless-text',
  'affine:code',
  'affine:attachment',
  'affine:bookmark',
  'affine:divider',
  'affine:embed-youtube',
  'affine:database',
  'affine:surface-ref',
  'affine:frame',
  'affine:embed-linked-doc',
]

function documentWithFlavour(flavour: string): AffineDocument {
  const doc = new Y.Doc()
  const blocks = doc.getMap<unknown>('blocks')
  for (const [id, blockFlavour, children] of [
    ['doc', 'affine:page', ['note']],
    ['note', 'affine:note', ['unknown']],
    ['unknown', flavour, []],
  ] as const) {
    const block = new Y.Map<unknown>()
    block.set('sys:id', id)
    block.set('sys:flavour', blockFlavour)
    const childArray = new Y.Array<string>()
    childArray.push([...children])
    block.set('sys:children', childArray)
    if (id === 'doc') {
      const title = new Y.Text()
      title.insert(0, 'Document')
      block.set('prop:title', title)
    }
    blocks.set(id, block)
  }
  return { id: 'doc', doc, snapshotApplied: true, updateCount: 0 }
}

function pages() {
  return buildPageRegistry({
    pages: [{ id: 'doc', title: 'Document', tags: [], trash: false }],
    tags: [],
    blockVersions: {},
  })
}

it('registry covers exactly all sixteen discovered AFFiNE flavours', () => {
  assert.deepEqual([...CONVERTER_REGISTRY.keys()].sort(), [...DISCOVERED_FLAVOURS].sort())
})

it('unknown flavours fail during preflight before conversion creates artifacts', () => {
  assert.throws(
    () => convertPage(documentWithFlavour('affine:new-format'), pages()),
    /Unsupported AFFiNE block flavour.*affine:new-format/iu,
  )
})

it('registry conversion preserves existing basic page behavior', () => {
  const document = documentWithFlavour('affine:divider')
  const result = convertPage(document, pages())
  assert.match(result.markdown, /# Document\n\n---\n$/u)
  assert.deepEqual(result.diagrams, [])
  assert.deepEqual(result.warnings, [])
})

it('convertPage preserves plain code and rejects links, references, unknown attributes, and embeds', () => {
  const plain = documentWithFlavour('affine:code')
  const plainBlock = plain.doc.getMap<Y.Map<unknown>>('blocks').get('unknown')
  const plainText = new Y.Text()
  plainText.insert(0, 'const literal = true;')
  plainBlock?.set('prop:text', plainText)
  plainBlock?.set('prop:language', 'typescript')
  const converted = convertPage(plain, pages())
  assert.match(converted.markdown, /```typescript\nconst literal = true;\n```/u)
  assert.deepEqual(converted.coverage.richTextDeltas, {
    total: 2,
    rendered: 1,
    structuralMetadataOnly: 1,
    approvedLoss: 0,
  })

  for (const attributes of [
    { italic: 1 },
    { link: 'https://example.com' },
    { reference: { type: 'LinkedPage', pageId: 'doc' } },
    { future: true },
  ]) {
    const document = documentWithFlavour('affine:code')
    const block = document.doc.getMap<Y.Map<unknown>>('blocks').get('unknown')
    const text = new Y.Text()
    block?.set('prop:text', text)
    text.insert(0, 'plain\n')
    text.insert(text.length, 'formatted', attributes)
    block?.set('prop:language', null)
    assert.throws(() => convertPage(document, pages()), /code block unknown.*(?:unsupported rich-text attribute|must be true)/u)
  }

  const embedded = documentWithFlavour('affine:code')
  const embeddedText = new Y.Text()
  embeddedText.insertEmbed(0, { literal: 'not text' })
  embedded.doc.getMap<Y.Map<unknown>>('blocks').get('unknown')?.set('prop:text', embeddedText)
  assert.throws(() => convertPage(embedded, pages()), /code block unknown.*insert must be a string/u)
})

it('convertPage preserves code text while recording exact visual-color and formatting losses', () => {
  const document = documentWithFlavour('affine:code')
  const block = document.doc.getMap<Y.Map<unknown>>('blocks').get('unknown')
  const text = new Y.Text()
  block?.set('prop:text', text)
  text.insert(0, 'plain ')
  text.insert(text.length, 'highlighted', { color: 'yellow' })
  text.insert(text.length, ' bold', { bold: true })

  const converted = convertPage(document, pages())
  assert.match(converted.markdown, /plain highlighted bold/)
  assert.deepEqual(converted.losses, [{
    kind: 'visual-color',
    attribute: 'color',
    value: 'yellow',
    text: 'highlighted',
    blockId: 'unknown',
    property: 'prop:text',
    deltaIndex: 1,
  }, {
    kind: 'visual-formatting',
    attribute: 'bold',
    value: 'true',
    text: ' bold',
    blockId: 'unknown',
    property: 'prop:text',
    deltaIndex: 2,
  }])
  assert.deepEqual(converted.coverage.richTextDeltas, {
    total: 4,
    rendered: 1,
    structuralMetadataOnly: 1,
    approvedLoss: 2,
  })
  assert.ok(converted.coverage.items.some(item => item.kind === 'rich-text-delta'
    && item.blockId === 'unknown' && item.deltaIndex === 1
    && item.disposition === 'approved-loss' && item.reason === 'visual-color:color'))
  assert.ok(converted.coverage.items.some(item => item.kind === 'rich-text-delta'
    && item.blockId === 'unknown' && item.deltaIndex === 2
    && item.disposition === 'approved-loss' && item.reason === 'visual-formatting:bold'))
})

it('convertPage normalizes external media URLs and single-line labels', () => {
  const bookmark = documentWithFlavour('affine:bookmark')
  const bookmarkBlock = bookmark.doc.getMap<Y.Map<unknown>>('blocks').get('unknown')
  bookmarkBlock?.set('prop:url', 'example.com/docs')
  bookmarkBlock?.set('prop:title', 'Bookmark\ntitle')
  assert.match(
    convertPage(bookmark, pages()).markdown,
    /\[Bookmark title\]\(<https:\/\/example\.com\/docs>\)/u,
  )

  const youtube = documentWithFlavour('affine:embed-youtube')
  const youtubeBlock = youtube.doc.getMap<Y.Map<unknown>>('blocks').get('unknown')
  youtubeBlock?.set('prop:url', '//www.youtube.com/watch?v=test')
  youtubeBlock?.set('prop:title', 'YouTube\r\nvideo')
  assert.match(
    convertPage(youtube, pages()).markdown,
    /\[YouTube video\]\(<https:\/\/www\.youtube\.com\/watch\?v=test>\)/u,
  )
})
