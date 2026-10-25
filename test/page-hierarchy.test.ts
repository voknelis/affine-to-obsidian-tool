import type { AffineDocument, AffinePageMetadata, LoadedAffineWorkspace } from '../src/types.ts'
import assert from 'node:assert/strict'
import { it } from 'vitest'

import * as Y from 'yjs'
import { inferPageParents, PageHierarchyError } from '../src/page-hierarchy.ts'

function page(id: string, title = id): AffinePageMetadata {
  return { id, title, tags: [], trash: false }
}

function document(id: string, linkedPageIds: string[] = [], embeddedPageIds: string[] = []): AffineDocument {
  const doc = new Y.Doc({ guid: id })
  const blocks = doc.getMap<unknown>('blocks')
  linkedPageIds.forEach((targetId, index) => {
    const block = new Y.Map<unknown>()
    const text = new Y.Text()
    text.insert(0, targetId, { reference: { type: 'LinkedPage', pageId: targetId } })
    block.set('sys:flavour', 'affine:paragraph')
    block.set('prop:text', text)
    blocks.set(`link-${index}`, block)
  })
  embeddedPageIds.forEach((targetId, index) => {
    const block = new Y.Map<unknown>()
    block.set('sys:flavour', 'affine:embed-linked-doc')
    block.set('prop:pageId', targetId)
    blocks.set(`embed-${index}`, block)
  })
  return { id, doc, snapshotApplied: true, updateCount: 0 }
}

function workspace(
  pages: AffinePageMetadata[],
  documents: AffineDocument[],
): LoadedAffineWorkspace {
  return {
    workspaceId: 'workspace',
    metadata: { pages, tags: [], blockVersions: {} },
    documents: new Map(documents.map(entry => [entry.id, entry])),
    destroy: () => {
      for (const entry of documents) {
        entry.doc.destroy()
      }
    },
  }
}

it('chooses the earliest referencing page and includes embedded documents', () => {
  const ws = workspace(
    [page('root'), page('other'), page('child')],
    [
      document('other', ['child']),
      document('root', [], ['child']),
      document('child'),
    ],
  )
  try {
    assert.deepEqual([...inferPageParents(ws)], [['child', 'root']])
  }
  finally {
    ws.destroy()
  }
})

it('ignores self/unknown targets and keeps pages without parents at the root', () => {
  const ws = workspace(
    [page('root'), page('orphan')],
    [document('root', ['root', 'missing']), document('orphan')],
  )
  try {
    assert.deepEqual([...inferPageParents(ws)], [])
  }
  finally {
    ws.destroy()
  }
})

it('skips candidates that would close reference cycles', () => {
  const ws = workspace(
    [page('a'), page('b'), page('root')],
    [document('a', ['b']), document('b', ['a']), document('root', ['a'])],
  )
  try {
    const parents = inferPageParents(ws)
    assert.equal(parents.get('a'), 'root')
    assert.equal(parents.has('b'), false)
    assert.equal(parents.size, 1)
  }
  finally {
    ws.destroy()
  }
})

it('rejects missing page documents and blocks roots explicitly', () => {
  const missing = workspace([page('page')], [])
  assert.throws(() => inferPageParents(missing), PageHierarchyError)
  missing.destroy()

  const noBlocks = new Y.Doc()
  const ws = workspace(
    [page('page')],
    [{ id: 'page', doc: noBlocks, snapshotApplied: true, updateCount: 0 }],
  )
  try {
    assert.throws(() => inferPageParents(ws), /has no blocks root/)
  }
  finally {
    ws.destroy()
  }
})

it('discovers references in titles and nested database cells', () => {
  const root = document('root')
  const blocks = root.doc.getMap<unknown>('blocks')

  const frame = new Y.Map<unknown>()
  const title = new Y.Text()
  title.insert(0, 'title-child', { reference: { type: 'LinkedPage', pageId: 'title-child' } })
  frame.set('prop:title', title)
  blocks.set('frame', frame)

  const cellText = new Y.Text()
  cellText.insert(0, 'cell-child', { reference: { type: 'LinkedPage', pageId: 'cell-child' } })
  const cell = new Y.Map<unknown>()
  cell.set('value', cellText)
  const row = new Y.Map<unknown>()
  row.set('column', cell)
  const cells = new Y.Map<unknown>()
  cells.set('row', row)
  const database = new Y.Map<unknown>()
  database.set('prop:cells', cells)
  blocks.set('database', database)

  const ws = workspace(
    [page('root'), page('title-child'), page('cell-child')],
    [root, document('title-child'), document('cell-child')],
  )
  try {
    assert.deepEqual([...inferPageParents(ws)], [
      ['title-child', 'root'],
      ['cell-child', 'root'],
    ])
  }
  finally {
    ws.destroy()
  }
})
