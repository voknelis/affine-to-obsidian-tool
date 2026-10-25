import type { AffineBlock, BlockConversionContext } from '../src/converters/types.ts'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'vitest'

import * as Y from 'yjs'
import { AssetCollection } from '../src/assets.ts'
import { convertDatabaseBlock } from '../src/converters/database.ts'
import { convertPage } from '../src/converters/index.ts'
import {

  BlockConversionError,
} from '../src/converters/types.ts'
import { buildPageRegistry } from '../src/page-registry.ts'
import { writeMigrationReports } from '../src/report.ts'
import { validateOutput } from '../src/validate.ts'

interface ColumnSpec {
  id: string
  name?: string
  type: string
  data?: Record<string, unknown>
}

interface ViewSpec {
  id?: string
  name?: string
  mode?: string
  columns?: Array<{ id: string, hide?: boolean }>
  filter?: Record<string, unknown>
  groupBy?: { type: string, columnId: string, name: string }
  groupProperties?: unknown[]
  [key: string]: unknown
}

interface DatabaseSpec {
  columns?: ColumnSpec[]
  cells?: Record<string, Record<string, { columnId: string, value?: unknown } | undefined>>
  views?: ViewSpec[]
  title?: string
  rows?: Array<{ id: string, text?: string, flavour?: string, children?: string[] }>
}

const EMPTY_FILTER = { type: 'group', op: 'and', conditions: [] }

function tableView(columns: ViewSpec['columns'] = []): ViewSpec {
  return {
    id: 'table-view',
    name: 'Table View',
    mode: 'table',
    columns,
    filter: EMPTY_FILTER,
    header: { titleColumn: 'title' },
  }
}

function fixture(spec: DatabaseSpec): {
  block: AffineBlock
  context: BlockConversionContext
  doc: Y.Doc
  sourceBlocks: Y.Map<unknown>
} {
  const doc = new Y.Doc()
  const sourceBlocks = doc.getMap<unknown>('blocks')
  const blocks = new Map<string, AffineBlock>()
  const rows = spec.rows ?? [{ id: 'row-1', text: 'First' }]
  const databaseSource = new Y.Map<unknown>()
  sourceBlocks.set('database', databaseSource)
  const rowIds = rows.map(row => row.id)
  databaseSource.set('sys:id', 'database')
  databaseSource.set('sys:flavour', 'affine:database')
  const children = new Y.Array<string>()
  children.push(rowIds)
  databaseSource.set('sys:children', children)
  if (spec.title !== undefined) {
    databaseSource.set('prop:title', spec.title)
  }
  if (spec.columns !== undefined) {
    databaseSource.set('prop:columns', spec.columns)
  }
  if (spec.cells !== undefined) {
    databaseSource.set('prop:cells', spec.cells)
  }
  if (spec.views !== undefined) {
    databaseSource.set('prop:views', spec.views)
  }
  else { databaseSource.set('prop:views', [tableView()]) }
  const block: AffineBlock = {
    id: 'database',
    flavour: 'affine:database',
    children: rowIds,
    source: databaseSource,
  }
  blocks.set(block.id, block)

  for (const row of rows) {
    const source = new Y.Map<unknown>()
    sourceBlocks.set(row.id, source)
    source.set('sys:id', row.id)
    source.set('sys:flavour', row.flavour ?? 'affine:paragraph')
    const rowChildren = new Y.Array<string>()
    rowChildren.push(row.children ?? [])
    source.set('sys:children', rowChildren)
    if (row.text !== undefined) {
      const text = new Y.Text()
      text.insert(0, row.text)
      source.set('prop:text', text)
    }
    if (row.flavour === undefined || row.flavour === 'affine:paragraph') {
      source.set('prop:type', 'text')
    }
    blocks.set(row.id, {
      id: row.id,
      flavour: row.flavour ?? 'affine:paragraph',
      children: row.children ?? [],
      source,
    })
  }

  const pages = buildPageRegistry({
    pages: [
      { id: 'doc', title: 'Document', tags: [], trash: false },
      { id: 'deleted', title: 'Deleted', tags: [], trash: true },
    ],
    tags: [],
    blockVersions: {},
  })
  return {
    block,
    context: { documentId: 'doc', pages, blocks, losses: [], allowMissingGroupChildren: [] },
    doc,
    sourceBlocks,
  }
}

function convert(spec: DatabaseSpec) {
  const { block, context } = fixture(spec)
  return convertDatabaseBlock(block, context)
}

const COLUMNS: ColumnSpec[] = [
  { id: 'title', name: 'Name', type: 'title', data: {} },
  { id: 'notes', name: 'Notes', type: 'rich-text', data: {} },
  { id: 'score', name: 'Score', type: 'number', data: {} },
  {
    id: 'status',
    name: 'Status',
    type: 'select',
    data: { options: [{ id: 'doing', value: 'Doing', color: 'blue' }] },
  },
  {
    id: 'tags',
    name: 'Tags',
    type: 'multi-select',
    data: {
      options: [
        { id: 'one', value: 'One', color: 'red' },
        { id: 'two', value: 'Two', color: 'green' },
      ],
    },
  },
]

it('converts title, rich-text, number, select and multi-select columns into child rows', () => {
  const result = convert({
    title: 'Projects',
    columns: COLUMNS,
    rows: [
      { id: 'row-1', text: 'Alpha' },
      { id: 'row-2', text: 'Beta' },
    ],
    cells: {
      'row-1': {
        notes: { columnId: 'notes', value: 'Rich text' },
        score: { columnId: 'score', value: 8.5 },
        status: { columnId: 'status', value: 'doing' },
        tags: { columnId: 'tags', value: ['one', 'two'] },
      },
      'row-2': {
        notes: { columnId: 'notes', value: 'Second' },
        score: { columnId: 'score', value: 0 },
        status: { columnId: 'status', value: 'doing' },
        tags: { columnId: 'tags', value: [] },
      },
    },
  })

  assert.equal(result.markdown, [
    '### Projects',
    '',
    '#### Table View',
    '',
    '| Name | Notes | Score | Status | Tags |',
    '| --- | --- | --- | --- | --- |',
    '| Alpha | Rich text | 8.5 | Doing | One, Two |',
    '| Beta | Second | 0 | Doing |  |',
  ].join('\n'))
  assert.deepEqual(result.warnings, [])
})

it('renders formatted child titles and respects table view column order and visibility', () => {
  const { block, context } = fixture({
    columns: COLUMNS,
    rows: [{ id: 'row-1', text: 'Plain' }],
    views: [tableView([{ id: 'notes' }, { id: 'title' }, { id: 'score', hide: true }])],
    cells: { 'row-1': {
      notes: { columnId: 'notes', value: 'Visible' },
      score: { columnId: 'score', value: 7 },
    } },
  })
  const row = context.blocks.get('row-1')
  assert.ok(row !== undefined)
  const richTitle = row.source.get('prop:text')
  assert.ok(richTitle instanceof Y.Text)
  richTitle.delete(0, richTitle.length)
  richTitle.insert(0, 'Bold')
  richTitle.format(0, 4, { bold: true })

  const result = convertDatabaseBlock(block, context)
  assert.match(result.markdown, /\| Notes \| Name \|\n\| --- \| --- \|\n\| Visible \| \*\*Bold\*\* \|/u)
  assert.match(result.markdown, /#### All data\n\n\| Score \| Status \| Tags \|\n\| --- \| --- \| --- \|\n\| 7 \| {2}\| {2}\|/u)
})

it('renders rich-text database titles and omits empty rich-text titles', () => {
  const { block, context } = fixture({ columns: COLUMNS })
  const title = new Y.Text()
  title.insert(0, 'Projects')
  title.format(0, 8, { bold: true })
  block.source.set('prop:title', title)

  const result = convertDatabaseBlock(block, context)
  assert.match(result.markdown, /^### \*\*Projects\*\*/u)

  const empty = fixture({ columns: COLUMNS })
  empty.block.source.set('prop:title', new Y.Text())
  assert.doesNotMatch(convertDatabaseBlock(empty.block, empty.context).markdown, /^###(?!#)/u)
})

it('renders formatted Y.Text values in rich-text cells', () => {
  const { block, context } = fixture({
    columns: COLUMNS,
    views: [tableView([{ id: 'title' }, { id: 'notes' }])],
  })
  const cells = new Y.Map<unknown>()
  const row = new Y.Map<unknown>()
  const cell = new Y.Map<unknown>()
  const value = new Y.Text()
  cell.set('columnId', 'notes')
  cell.set('value', value)
  row.set('notes', cell)
  cells.set('row-1', row)
  block.source.set('prop:cells', cells)
  value.insert(0, 'Bold')
  value.format(0, 4, { bold: true })

  const result = convertDatabaseBlock(block, context)
  assert.match(result.markdown, /\| First \| \*\*Bold\*\* \|/u)
})

it('preserves every titleless-schema row title in All data with rendered coverage', () => {
  const { context, doc, sourceBlocks } = fixture({
    columns: [{ id: 'notes', name: 'Notes', type: 'rich-text' }],
    rows: [{ id: 'row-1', text: 'First row title' }, { id: 'row-2', text: 'Second row title' }],
    views: [{
      id: 'table-view',
      name: 'Table View',
      mode: 'table',
      columns: [{ id: 'notes' }],
      filter: EMPTY_FILTER,
    }],
    cells: {
      'row-1': { notes: { columnId: 'notes', value: 'First notes' } },
      'row-2': { notes: { columnId: 'notes', value: 'Second notes' } },
    },
  })
  const page = new Y.Map<unknown>()
  const children = new Y.Array<string>()
  children.push(['database'])
  page.set('sys:id', 'doc')
  page.set('sys:flavour', 'affine:page')
  page.set('sys:children', children)
  page.set('prop:title', new Y.Text('Document'))
  sourceBlocks.set('doc', page)

  const result = convertPage({ id: 'doc', doc, snapshotApplied: true, updateCount: 0 }, context.pages)
  assert.match(result.markdown, /#### Table View\n\n\| Notes \|\n\| --- \|\n\| First notes \|\n\| Second notes \|/u)
  assert.match(result.markdown, /#### All data\n\n\| Title \|\n\| --- \|\n\| First row title \|\n\| Second row title \|/u)
  const titleDeltas = result.coverage.items.filter(item =>
    item.kind === 'rich-text-delta' && (item.blockId === 'row-1' || item.blockId === 'row-2'))
  assert.equal(titleDeltas.length, 2)
  assert.ok(titleDeltas.every(item => item.disposition === 'rendered'))
})

it('preserves hidden rich-text cells and row titles through convertPage and staged validation', async (t) => {
  const { block, context, doc, sourceBlocks } = fixture({
    columns: COLUMNS.slice(0, 3),
    rows: [{ id: 'row-1', text: 'First' }],
    views: [tableView([{ id: 'title', hide: true }, { id: 'notes', hide: true }, { id: 'score' }])],
  })
  const title = context.blocks.get('row-1')?.source.get('prop:text')
  assert.ok(title instanceof Y.Text)
  title.delete(0, title.length)
  title.insert(0, 'Hidden title')
  title.format(0, title.length, { italic: true })

  const cells = new Y.Map<unknown>()
  const row = new Y.Map<unknown>()
  const notes = new Y.Map<unknown>()
  const score = new Y.Map<unknown>()
  const richNotes = new Y.Text()
  notes.set('columnId', 'notes')
  notes.set('value', richNotes)
  score.set('columnId', 'score')
  score.set('value', 4)
  row.set('notes', notes)
  row.set('score', score)
  cells.set('row-1', row)
  block.source.set('prop:cells', cells)
  richNotes.insert(0, 'Hidden notes')
  richNotes.format(0, richNotes.length, { bold: true })

  const page = new Y.Map<unknown>()
  const children = new Y.Array<string>()
  children.push(['database'])
  page.set('sys:id', 'doc')
  page.set('sys:flavour', 'affine:page')
  page.set('sys:children', children)
  page.set('prop:title', new Y.Text('Document'))
  sourceBlocks.set('doc', page)

  const pages = buildPageRegistry({
    pages: [{ id: 'doc', title: 'Document', tags: [], trash: false }],
    tags: [],
    blockVersions: {},
  })
  const result = convertPage({ id: 'doc', doc, snapshotApplied: true, updateCount: 0 }, pages)
  assert.match(result.markdown, /#### Table View\n\n\| Score \|\n\| --- \|\n\| 4 \|/u)
  assert.match(
    result.markdown,
    /#### All data\n\n\| Name \| Notes \|\n\| --- \| --- \|\n\| \*Hidden title\* \| \*\*Hidden notes\*\* \|/u,
  )
  const databaseDeltas = result.coverage.items.filter(item =>
    item.kind === 'rich-text-delta' && item.blockId !== 'doc',
  )
  assert.equal(databaseDeltas.length, 2)
  assert.ok(databaseDeltas.every(item => item.disposition === 'rendered'))
  const outputDirectory = await mkdtemp(join(tmpdir(), 'affine-database-stage-'))
  t.onTestFinished(async () => rm(outputDirectory, { recursive: true, force: true }))
  const assets = new AssetCollection([])
  await writeFile(join(outputDirectory, pages.requirePath('doc')), result.markdown, 'utf8')
  const conversionLosses = result.losses.map(loss => ({ documentId: 'doc', ...loss }))
  await writeMigrationReports(outputDirectory, {
    workspaceId: 'workspace',
    sourceFingerprint: 'a'.repeat(64),
    pages,
    assets,
    documents: [{
      documentId: 'doc',
      coverage: result.coverage,
      losses: result.losses,
      warnings: result.warnings,
    }],
  })

  assert.deepEqual(await validateOutput({
    outputDirectory,
    workspaceId: 'workspace',
    sourceFingerprint: 'a'.repeat(64),
    pages,
    assets,
    coverage: [result.coverage],
    expectedNotes: new Map([['doc', result.markdown]]),
    expectedDiagrams: new Map(),
    warnings: result.warnings,
    conversionLosses,
  }), { files: 3, pages: 1, assetFiles: 0, warnings: 0 })
  const saved = await readFile(join(outputDirectory, pages.requirePath('doc')), 'utf8')
  assert.match(saved, /\| \*Hidden title\* \| \*\*Hidden notes\*\* \|/u)
})

it('escapes wikilink alias pipes inside Markdown table cells', () => {
  const { block, context } = fixture({
    columns: COLUMNS,
    rows: [{ id: 'row-1', text: 'Alias' }],
    views: [tableView([{ id: 'title' }, { id: 'notes' }])],
  })
  const title = context.blocks.get('row-1')?.source.get('prop:text')
  assert.ok(title instanceof Y.Text)
  title.delete(0, title.length)
  title.insert(0, 'Alias', { reference: { type: 'LinkedPage', pageId: 'deleted' } })

  const result = convertDatabaseBlock(block, context)
  assert.match(result.markdown, /\[\[_trash\/Deleted\\\|Alias\]\]/u)
})

it('preserves table values and kanban groups across multiple views', () => {
  const result = convert({
    columns: COLUMNS,
    rows: [
      { id: 'row-1', text: 'Alpha' },
      { id: 'row-2', text: 'Beta' },
      { id: 'row-3', text: 'No status' },
    ],
    views: [
      tableView([{ id: 'title' }, { id: 'status' }]),
      {
        id: 'kanban-view',
        name: 'Kanban View',
        mode: 'kanban',
        columns: [{ id: 'title' }, { id: 'status' }],
        filter: EMPTY_FILTER,
        groupBy: { type: 'groupBy', columnId: 'status', name: 'select' },
        header: { titleColumn: 'title' },
        groupProperties: [],
      },
    ],
    cells: {
      'row-1': { status: { columnId: 'status', value: 'doing' } },
      'row-2': { status: { columnId: 'status', value: 'doing' } },
      'row-3': {},
    },
  })

  assert.match(result.markdown, /#### Table View[\s\S]*\| Alpha \| Doing \|\n\| Beta \| Doing \|\n\| No status \| {2}\|/u)
  assert.match(result.markdown, /#### Kanban View\n\n##### Doing\n\n\| Name \| Status \|[\s\S]*\| Alpha \| Doing \|\n\| Beta \| Doing \|/u)
  assert.match(result.markdown, /##### Ungrouped\n\n\| Name \| Status \|[\s\S]*\| No status \| {2}\|/u)
})

it('emits configured empty kanban lanes with tables, including an empty database', () => {
  const columns: ColumnSpec[] = [
    { id: 'title', name: 'Name', type: 'title' },
    { id: 'status', name: 'Status', type: 'select', data: { options: [
      { id: 'doing', value: 'Doing' },
      { id: 'empty', value: 'Empty' },
    ] } },
  ]
  const views: ViewSpec[] = [{
    id: 'board',
    name: 'Board',
    mode: 'kanban',
    columns: [{ id: 'title' }, { id: 'status' }],
    filter: EMPTY_FILTER,
    groupBy: { type: 'groupBy', columnId: 'status', name: 'select' },
  }]
  const result = convert({
    columns,
    rows: [{ id: 'row-1', text: 'Alpha' }, { id: 'row-2', text: 'No status' }],
    views,
    cells: { 'row-1': { status: { columnId: 'status', value: 'doing' } }, 'row-2': {} },
  })

  assert.equal(result.markdown, [
    '#### Board',
    '',
    '##### Doing',
    '',
    '| Name | Status |',
    '| --- | --- |',
    '| Alpha | Doing |',
    '',
    '##### Empty',
    '',
    '| Name | Status |',
    '| --- | --- |',
    '',
    '##### Ungrouped',
    '',
    '| Name | Status |',
    '| --- | --- |',
    '| No status |  |',
  ].join('\n'))

  const empty = convert({ columns, rows: [], views, cells: {} })
  assert.match(empty.markdown, /##### Doing\n\n\| Name \| Status \|\n\| --- \| --- \|\n\n##### Empty\n\n\| Name \| Status \|\n\| --- \| --- \|$/u)
  assert.doesNotMatch(empty.markdown, /Ungrouped/u)
})

it('escapes pipes and Markdown and converts all newline conventions to HTML breaks', () => {
  const result = convert({
    columns: COLUMNS,
    cells: {
      'row-1': {
        notes: { columnId: 'notes', value: 'A | B\r\nC\rD\nE *literal*' },
        status: { columnId: 'status', value: 'doing' },
      },
    },
  })
  assert.match(result.markdown, /\| First \| A \\\| B<br>C<br>D<br>E \\\*literal\\\* \|/u)
})

it('renders missing cells, values and empty option lists as empty values', () => {
  const result = convert({
    columns: [
      { id: 'title', name: 'Name', type: 'title' },
      { id: 'status', name: 'Status', type: 'select' },
      { id: 'tags', name: 'Tags', type: 'multi-select', data: { options: [] } },
      { id: 'score', name: 'Score', type: 'number' },
    ],
    rows: [{ id: 'row-1', text: 'Alpha' }, { id: 'row-2', text: 'Beta' }],
    cells: {
      'row-1': {
        status: { columnId: 'status' },
        tags: { columnId: 'tags', value: [] },
        score: { columnId: 'score', value: null },
      },
    },
  })
  assert.match(result.markdown, /\| Alpha \| {2}\| {2}\| {2}\|\n\| Beta \| {2}\| {2}\| {2}\|/u)
})

it('uses a stable fallback for a title column without a name', () => {
  const result = convert({
    columns: [{ id: 'title', type: 'title', data: {} }],
  })
  assert.match(result.markdown, /\| Title \|\n\| --- \|\n\| First \|/u)
})

it('rejects missing columns and unknown view column references', () => {
  assert.throws(() => convert({ cells: {} }), (error: unknown) => {
    assert.ok(error instanceof BlockConversionError)
    assert.match(error.message, /database.*prop:columns/iu)
    return true
  })
  assert.throws(
    () => convert({ columns: COLUMNS, views: [tableView([{ id: 'missing' }])], cells: {} }),
    /view.*unknown column.*missing/iu,
  )
})

it('rejects a referenced select option missing from column metadata', () => {
  assert.throws(
    () => convert({
      columns: COLUMNS,
      cells: { 'row-1': { status: { columnId: 'status', value: 'missing-option' } } },
    }),
    /status.*unknown select option.*missing-option/iu,
  )
  assert.throws(
    () => convert({
      columns: COLUMNS,
      cells: { 'row-1': { tags: { columnId: 'tags', value: ['one', 'missing-option'] } } },
    }),
    /tags.*unknown multi-select option.*missing-option/iu,
  )
})

it('rejects unknown column types even when no rows use them', () => {
  assert.throws(
    () => convert({ columns: [...COLUMNS, { id: 'date', name: 'Date', type: 'date' }], cells: {} }),
    /unsupported database column type.*date/iu,
  )
})

it('rejects malformed, missing and nested child rows', () => {
  const cases: Array<{ rows: NonNullable<DatabaseSpec['rows']>, message: RegExp }> = [
    { rows: [{ id: 'row-1', text: 'Alpha', flavour: 'affine:list' }], message: /row.*paragraph/iu },
    { rows: [{ id: 'row-1', text: 'Alpha', children: ['nested'] }], message: /row.*cannot have children/iu },
    { rows: [{ id: 'row-1' }], message: /row.*prop:text/iu },
  ]
  for (const item of cases) {
    assert.throws(() => convert({ columns: COLUMNS, rows: item.rows, cells: {} }), item.message)
  }

  const { block, context } = fixture({ columns: COLUMNS, cells: {} });
  (context.blocks as Map<string, AffineBlock>).delete('row-1')
  assert.throws(() => convertDatabaseBlock(block, context), /missing database row.*row-1/iu)
})

it('rejects orphan cell rows and cells referencing unknown columns', () => {
  assert.throws(
    () => convert({ columns: COLUMNS, cells: { orphan: {} } }),
    /cells.*unknown row.*orphan/iu,
  )
  assert.throws(
    () => convert({ columns: COLUMNS, cells: { 'row-1': { unknown: { columnId: 'unknown', value: 'x' } } } }),
    /row-1.*unknown column.*unknown/iu,
  )
})

it('reports filters and nonrepresentable view settings as structured warnings without dropping rows', () => {
  const filter = {
    type: 'group',
    op: 'and',
    conditions: [{ type: 'filter', left: { type: 'property', id: 'score' }, op: '>', right: 5 }],
  }
  const result = convert({
    columns: COLUMNS,
    views: [{ ...tableView(), filter, header: { titleColumn: 'title', iconColumn: 'type' }, sort: { columnId: 'score', desc: true } }],
    cells: { 'row-1': { score: { columnId: 'score', value: 1 } } },
  })

  assert.match(result.markdown, /\| First \| {2}\| 1 \| {2}\| {2}\|/u)
  assert.deepEqual(result.warnings, [
    {
      kind: 'database-view-filter',
      documentId: 'doc',
      blockId: 'database',
      viewId: 'table-view',
      setting: 'filter',
      value: filter,
      reason: 'Markdown tables include all rows; AFFiNE view filters are not applied.',
    },
    {
      kind: 'database-view-setting',
      documentId: 'doc',
      blockId: 'database',
      viewId: 'table-view',
      setting: 'header.iconColumn',
      value: 'type',
      reason: 'AFFiNE view setting is not representable in a Markdown table.',
    },
    {
      kind: 'database-view-setting',
      documentId: 'doc',
      blockId: 'database',
      viewId: 'table-view',
      setting: 'sort',
      value: { columnId: 'score', desc: true },
      reason: 'AFFiNE view setting is not representable in a Markdown table.',
    },
  ])
})

it('warns explicitly when a table view carries groupBy metadata', () => {
  const groupBy = { type: 'groupBy', columnId: 'status', name: 'select' }
  const result = convert({
    columns: COLUMNS,
    views: [{ ...tableView(), groupBy }],
    cells: { 'row-1': { status: { columnId: 'status', value: 'doing' } } },
  })

  assert.match(result.markdown, /\| First \| {2}\| {2}\| Doing \| {2}\|/u)
  assert.deepEqual(result.warnings, [{
    kind: 'database-view-setting',
    documentId: 'doc',
    blockId: 'database',
    viewId: 'table-view',
    setting: 'groupBy',
    value: groupBy,
    reason: 'AFFiNE table grouping is not representable; the Markdown table includes all rows without grouping.',
  }])
})

it('validates cell value shapes and kanban grouping metadata', () => {
  assert.throws(
    () => convert({ columns: COLUMNS, cells: { 'row-1': { score: { columnId: 'score', value: '8' } } } }),
    /score.*number/iu,
  )
  assert.throws(
    () => convert({ columns: COLUMNS, cells: { 'row-1': { tags: { columnId: 'tags', value: 'one' } } } }),
    /tags.*array/iu,
  )
  assert.throws(
    () => convert({
      columns: COLUMNS,
      cells: {},
      views: [{
        ...tableView(),
        id: 'kanban',
        mode: 'kanban',
        groupBy: { type: 'groupBy', columnId: 'notes', name: 'rich-text' },
      }],
    }),
    /kanban.*groupBy.*select/iu,
  )
})
