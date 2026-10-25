import type { TestContext } from 'vitest'
import type { SyntheticDocument } from './fixtures.ts'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { it } from 'vitest'

import * as Y from 'yjs'
import { migrateWorkspace } from '../src/migrate.ts'
import { validateOutput } from '../src/validate.ts'
import {
  createSyntheticDatabase,
  defaultWorkspaceMetadata,

} from './fixtures.ts'

interface BlockSpec {
  readonly id: string
  readonly flavour: string
  readonly children?: readonly string[]
  readonly title?: string
  readonly text?: string
  readonly type?: string
  readonly sourceId?: string
  readonly name?: string
  readonly pageId?: string
  readonly url?: string
  readonly props?: Readonly<Record<string, unknown>>
}

function pageDocument(id: string, blocks: readonly BlockSpec[]): SyntheticDocument {
  const doc = new Y.Doc({ guid: id })
  const blockMap = doc.getMap<unknown>('blocks')
  for (const spec of blocks) {
    const block = new Y.Map<unknown>()
    block.set('sys:id', spec.id)
    block.set('sys:flavour', spec.flavour)
    const children = new Y.Array<string>()
    children.push([...spec.children ?? []])
    block.set('sys:children', children)
    for (const [property, value] of [['prop:title', spec.title], ['prop:text', spec.text]] as const) {
      if (value !== undefined) {
        const text = new Y.Text()
        text.insert(0, value)
        block.set(property, text)
      }
    }
    if (spec.type !== undefined) {
      block.set('prop:type', spec.type)
    }
    if (spec.sourceId !== undefined) {
      block.set('prop:sourceId', spec.sourceId)
    }
    if (spec.name !== undefined) {
      block.set('prop:name', spec.name)
    }
    if (spec.pageId !== undefined) {
      block.set('prop:pageId', spec.pageId)
    }
    if (spec.url !== undefined) {
      block.set('prop:url', spec.url)
    }
    for (const [property, value] of Object.entries(spec.props ?? {})) {
      block.set(property, value)
    }
    blockMap.set(spec.id, block)
  }
  const snapshot = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return { id, snapshot }
}

type AssetState = 'available' | 'missing' | 'deleted' | 'zero-length' | 'signature-mismatch'

interface FixtureOptions {
  readonly unknownFlavour?: boolean
  readonly assetState?: AssetState
  readonly pageTitle?: string
  readonly externalLinks?: boolean
  readonly diagram?: boolean
}

async function fixture(root: string, options: FixtureOptions = {}): Promise<string> {
  const source = join(root, 'storage.db')
  const assetState = options.assetState ?? 'available'
  const assetId = assetState === 'missing' ? 'approved-missing' : 'image-source'
  const defaultMetadata = defaultWorkspaceMetadata()
  const metadata = {
    ...defaultMetadata,
    pages: defaultMetadata.pages.map(page => page.id === 'page-1' && options.pageTitle !== undefined
      ? { ...page, title: options.pageTitle }
      : page),
  }
  const externalChildren = options.externalLinks === true ? ['bookmark-1', 'youtube-1'] : []
  const externalBlocks: readonly BlockSpec[] = options.externalLinks === true
    ? [
        { id: 'bookmark-1', flavour: 'affine:bookmark', url: 'example.com/docs' },
        { id: 'youtube-1', flavour: 'affine:embed-youtube', url: '//www.youtube.com/watch?v=test' },
      ]
    : []
  const diagramChildren = options.diagram === true ? ['surface-1'] : []
  const diagramBlocks: readonly BlockSpec[] = options.diagram === true
    ? [{
        id: 'surface-1',
        flavour: 'affine:surface',
        props: {
          'prop:elements': {
            type: '$blocksuite:internal:native$',
            value: {
              shape: { id: 'shape', type: 'shape', shapeType: 'rect', xywh: '[0,0,100,80]' },
            },
          },
        },
      }]
    : []
  createSyntheticDatabase(source, {
    metadata,
    documents: [
      pageDocument('page-1', [
        {
          id: 'page-1',
          flavour: 'affine:page',
          title: options.pageTitle ?? 'First page',
          children: ['note-1', ...diagramChildren],
        },
        {
          id: 'note-1',
          flavour: 'affine:note',
          children: ['paragraph-1', 'image-1', 'linked-1', ...externalChildren],
        },
        {
          id: 'paragraph-1',
          flavour: options.unknownFlavour === true ? 'affine:future' : 'affine:paragraph',
          type: 'text',
          text: 'Converted from a consistent backup',
        },
        { id: 'image-1', flavour: 'affine:image', sourceId: assetId, name: 'pixel' },
        { id: 'linked-1', flavour: 'affine:embed-linked-doc', pageId: 'page-2' },
        ...externalBlocks,
        ...diagramBlocks,
      ]),
      pageDocument('page-2', [
        { id: 'page-2', flavour: 'affine:page', title: 'Deleted page', children: ['note-2'] },
        { id: 'note-2', flavour: 'affine:note', children: ['paragraph-2'] },
        { id: 'paragraph-2', flavour: 'affine:paragraph', type: 'text', text: 'Trash content' },
      ]),
    ],
  })
  const database = new DatabaseSync(source)
  try {
    database.exec('CREATE TABLE blobs (key TEXT PRIMARY KEY, data BLOB NOT NULL, mime TEXT NOT NULL, deleted_at TEXT)')
    if (assetState !== 'missing') {
      const data = assetState === 'zero-length'
        ? new Uint8Array()
        : assetState === 'signature-mismatch'
          ? new Uint8Array([0, 1, 2, 3])
          : new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1])
      const deletedAt = assetState === 'deleted' ? '2026-01-01 00:00:00' : null
      database.prepare('INSERT INTO blobs (key, data, mime, deleted_at) VALUES (?, ?, ?, ?)')
        .run(assetId, data, 'image/png', deletedAt)
    }
  }
  finally {
    database.close()
  }
  return Promise.resolve(source)
}

function collisionFixture(root: string): string {
  const source = join(root, 'storage.db')
  const defaultMetadata = defaultWorkspaceMetadata()
  const document = (id: string, parentId?: string): SyntheticDocument => pageDocument(id, [
    { id, flavour: 'affine:page', title: id.includes('parent') ? 'Root' : 'Same', children: ['note'] },
    {
      id: 'note',
      flavour: 'affine:note',
      children: parentId === undefined ? ['paragraph'] : ['paragraph', 'linked'],
    },
    { id: 'paragraph', flavour: 'affine:paragraph', type: 'text', text: `${id} content` },
    ...parentId === undefined
      ? []
      : [{ id: 'linked', flavour: 'affine:embed-linked-doc', pageId: parentId }],
  ])
  createSyntheticDatabase(source, {
    metadata: {
      ...defaultMetadata,
      pages: [
        { id: 'active-parent', title: 'Root', tags: [], trash: false },
        { id: 'trash-parent', title: 'Root', tags: [], trash: true },
        { id: 'child-a', title: 'Same', tags: [], trash: false },
        { id: 'child-b', title: 'Same', tags: [], trash: false },
      ],
    },
    documents: [
      document('active-parent', 'child-a'),
      document('trash-parent', 'child-b'),
      document('child-a'),
      document('child-b'),
    ],
  })
  const database = new DatabaseSync(source)
  try {
    database.exec('CREATE TABLE blobs (key TEXT PRIMARY KEY, data BLOB NOT NULL, mime TEXT NOT NULL, deleted_at TEXT)')
  }
  finally {
    database.close()
  }
  return source
}

async function sandbox(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'affine-migrate-'))
  t.onTestFinished(async () => rm(root, { recursive: true, force: true }))
  return root
}

interface FileSnapshot {
  readonly sha256: string
  readonly size: number
  readonly mtimeMs: number
}

async function tree(root: string): Promise<Record<string, FileSnapshot>> {
  const result: Record<string, FileSnapshot> = {}
  async function visit(directory: string, prefix = ''): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name)
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        await visit(path, relative)
      }
      else {
        const [bytes, metadata] = await Promise.all([readFile(path), stat(path)])
        result[relative] = {
          sha256: createHash('sha256').update(bytes).digest('hex'),
          size: bytes.byteLength,
          mtimeMs: metadata.mtimeMs,
        }
      }
    }
  }
  await visit(root)
  return result
}

async function digest(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function assertNoMigrationArtifacts(root: string): Promise<void> {
  const entries = await readdir(root)
  assert.deepEqual(entries.filter(entry => entry.includes('migration-') || entry.includes('staging') || entry.includes('backup')), [])
}

it('runs backup, decode, conversion, reports, validation, staging, and target replacement', async (t) => {
  const root = await sandbox(t)
  const source = await fixture(root)
  const target = join(root, 'from_affine')
  await mkdir(target)
  await writeFile(join(target, 'stale.txt'), 'old target')
  const sourceBefore = await digest(source)

  const result = await migrateWorkspace({ source, target, allowMissing: [], dryRun: false })

  assert.equal(result.dryRun, false)
  assert.equal(result.pages, 2)
  assert.equal(result.files, 5)
  assert.deepEqual(Object.keys(await tree(target)).sort(), [
    'First page/First page.md',
    '_affine-migration.json',
    '_affine-migration.md',
    '_trash/First page/Deleted page.md',
    expectAssetPath(await tree(target)),
  ].sort())
  const notePath = join(target, 'First page/First page.md')
  assert.match(await readFile(notePath, 'utf8'), /Converted from a consistent backup/u)
  assert.match(await readFile(notePath, 'utf8'), /!\[\[_trash\/First page\/Deleted page\]\]/u)
  assert.equal(await digest(source), sourceBefore)
  await assertNoMigrationArtifacts(root)
})

it('migrates active children of same-named active and trash containers without collisions', async (t) => {
  const root = await sandbox(t)
  const source = collisionFixture(root)
  const target = join(root, 'from_affine')

  await migrateWorkspace({ source, target, allowMissing: [], dryRun: false })

  const files = await tree(target)
  assert.deepEqual(Object.keys(files).sort(), [
    'Root/Root.md',
    'Root/Same.md',
    'Root/Same--child-b.md',
    '_trash/Root/Root.md',
    '_affine-migration.json',
    '_affine-migration.md',
  ].sort())
  assert.match(await readFile(join(target, 'Root/Same.md'), 'utf8'), /child\\-a content/u)
  assert.match(await readFile(join(target, 'Root/Same--child-b.md'), 'utf8'), /child\\-b content/u)
  await assertNoMigrationArtifacts(root)
})

function expectAssetPath(files: Record<string, FileSnapshot>): string {
  const path = Object.keys(files).find(name => name.startsWith('assets/pixel--'))
  assert.ok(path !== undefined)
  return path
}

it('conversion failure leaves source and previous target unchanged and cleans temporary files', async (t) => {
  const root = await sandbox(t)
  const source = await fixture(root, { unknownFlavour: true })
  const target = join(root, 'from_affine')
  await mkdir(target)
  await writeFile(join(target, 'keep.txt'), 'previous target')
  const before = await tree(target)
  const sourceBefore = await digest(source)

  await assert.rejects(
    migrateWorkspace({ source, target, allowMissing: [], dryRun: false }),
    /Unsupported AFFiNE block flavour.*affine:future/iu,
  )
  assert.deepEqual(await tree(target), before)
  assert.equal(await digest(source), sourceBefore)
  await assertNoMigrationArtifacts(root)
})

it('validation failure after complete staging leaves source and previous target unchanged', async (t) => {
  const root = await sandbox(t)
  const source = await fixture(root)
  const target = join(root, 'from_affine')
  await mkdir(target)
  await writeFile(join(target, 'keep.txt'), 'previous target')
  const before = await tree(target)
  const sourceBefore = await digest(source)
  let validationRan = false

  await assert.rejects(migrateWorkspace(
    { source, target, allowMissing: [], dryRun: false },
    {
      validate: async (options) => {
        await validateOutput(options)
        validationRan = true
        throw new Error('injected validation failure')
      },
    },
  ), /injected validation failure/u)
  assert.equal(validationRan, true)
  assert.deepEqual(await tree(target), before)
  assert.equal(await digest(source), sourceBefore)
  await assertNoMigrationArtifacts(root)
})

it('staged note truncation fails validation and cannot replace the previous target', async (t) => {
  const root = await sandbox(t)
  const source = await fixture(root)
  const target = join(root, 'from_affine')
  await mkdir(target)
  await writeFile(join(target, 'keep.txt'), 'previous target')
  const before = await tree(target)

  await assert.rejects(migrateWorkspace(
    { source, target, allowMissing: [], dryRun: false },
    {
      validate: async (options) => {
        const path = join(options.outputDirectory, 'First page/First page.md')
        const markdown = await readFile(path, 'utf8')
        const bodyStart = markdown.indexOf('\n\n# ')
        assert.ok(bodyStart > 0)
        await writeFile(path, `${markdown.slice(0, bodyStart)}\n\n`)
        return validateOutput(options)
      },
    },
  ), /First page\.md content mismatch.*converted Markdown/iu)

  assert.deepEqual(await tree(target), before)
  await assertNoMigrationArtifacts(root)
})

it('staged nonempty diagram corruption fails validation and preserves the previous target', async (t) => {
  const root = await sandbox(t)
  const source = await fixture(root, { diagram: true })
  const target = join(root, 'from_affine')
  await mkdir(target)
  await writeFile(join(target, 'keep.txt'), 'previous target')
  const before = await tree(target)
  const sourceBefore = await digest(source)
  const diagramPath = 'assets/diagrams/page-1--surface-1.svg'

  await assert.rejects(migrateWorkspace(
    { source, target, allowMissing: [], dryRun: false },
    {
      validate: async (options) => {
        const path = join(options.outputDirectory, diagramPath)
        const original = await readFile(path, 'utf8')
        assert.ok(original.length > 0)
        await writeFile(path, `${original.slice(0, -6)}<corrupted/>`)
        return validateOutput(options)
      },
    },
  ), /diagram content mismatch.*page-1--surface-1\.svg/iu)

  assert.deepEqual(await tree(target), before)
  assert.equal(await digest(source), sourceBefore)
  await assertNoMigrationArtifacts(root)
})

it('commit failure rolls back the previous target and preserves the source', async (t) => {
  const root = await sandbox(t)
  const source = await fixture(root)
  const target = join(root, 'from_affine')
  await mkdir(target)
  await writeFile(join(target, 'keep.txt'), 'previous target')
  const before = await tree(target)
  const sourceBefore = await digest(source)
  let renameCount = 0

  await assert.rejects(migrateWorkspace(
    { source, target, allowMissing: [], dryRun: false },
    {
      rename: async (oldPath, newPath) => {
        renameCount += 1
        if (renameCount === 2) {
          throw new Error('injected commit failure')
        }
        await rename(oldPath, newPath)
      },
    },
  ), /injected commit failure/u)
  assert.equal(renameCount, 3, 'the rollback rename must run after the failed commit')
  assert.deepEqual(await tree(target), before)
  assert.equal(await digest(source), sourceBefore)
  await assertNoMigrationArtifacts(root)
})

it('rollback failure preserves and discloses the only previous-target recovery copy', async (t) => {
  const root = await sandbox(t)
  const source = await fixture(root)
  const target = join(root, 'from_affine')
  await mkdir(target)
  await writeFile(join(target, 'keep.txt'), 'previous target')
  const before = await tree(target)
  const sourceBefore = await digest(source)
  let renameCount = 0
  let recoveryPath: string | undefined
  let failure: unknown

  try {
    await migrateWorkspace(
      { source, target, allowMissing: [], dryRun: false },
      {
        rename: async (oldPath, newPath) => {
          renameCount += 1
          if (renameCount === 2) {
            throw new Error('injected commit failure')
          }
          if (renameCount === 3) {
            recoveryPath = oldPath
            throw new Error('injected rollback failure')
          }
          await rename(oldPath, newPath)
        },
      },
    )
  }
  catch (error) {
    failure = error
  }

  assert.ok(failure instanceof AggregateError)
  assert.equal(renameCount, 3)
  assert.ok(recoveryPath !== undefined)
  assert.match(failure.message, /previous target remains recoverable/iu)
  assert.ok(failure.message.includes(recoveryPath), 'the durable recovery path must be exact')
  assert.deepEqual(await tree(recoveryPath), before)
  await assert.rejects(stat(target), { code: 'ENOENT' })
  assert.equal(await digest(source), sourceBefore)
})

for (const failureCase of [
  {
    name: 'corrupt source',
    prepare: async (root: string) => { await writeFile(join(root, 'storage.db'), 'not a SQLite database') },
    error: /consistent read-only SQLite backup/iu,
  },
  {
    name: 'nonexistent source',
    prepare: async () => Promise.resolve(),
    error: /consistent read-only SQLite backup/iu,
  },
  {
    name: 'unapproved missing asset',
    prepare: async (root: string) => { await fixture(root, { assetState: 'missing' }) },
    error: /Asset "approved-missing" is missing/iu,
  },
  {
    name: 'deleted asset',
    prepare: async (root: string) => { await fixture(root, { assetState: 'deleted' }) },
    error: /Asset "image-source" is deleted/iu,
  },
  {
    name: 'zero-length asset',
    prepare: async (root: string) => { await fixture(root, { assetState: 'zero-length' }) },
    error: /Asset "image-source" is zero-length/iu,
  },
  {
    name: 'asset signature mismatch',
    prepare: async (root: string) => { await fixture(root, { assetState: 'signature-mismatch' }) },
    error: /Asset "image-source".*signature mismatch/iu,
  },
]) {
  it(`${failureCase.name} failure preserves complete source and target trees and cleans up`, async (t) => {
    const root = await sandbox(t)
    await failureCase.prepare(root)
    const source = join(root, 'storage.db')
    const target = join(root, 'from_affine')
    await mkdir(join(target, 'nested'), { recursive: true })
    await writeFile(join(target, 'nested', 'keep.txt'), 'previous target')
    const before = await tree(root)

    await assert.rejects(
      migrateWorkspace({ source, target, allowMissing: [], dryRun: false }),
      failureCase.error,
    )

    assert.deepEqual(await tree(root), before)
    await assertNoMigrationArtifacts(root)
  })
}

it('repeatable runs produce identical output hashes and remove staging and backups', async (t) => {
  const root = await sandbox(t)
  const source = await fixture(root)
  const target = join(root, 'from_affine')

  await migrateWorkspace({ source, target, allowMissing: [], dryRun: false })
  const first = await tree(target)
  await writeFile(join(target, 'obsolete.md'), 'must disappear')
  await migrateWorkspace({ source, target, allowMissing: [], dryRun: false })
  const second = await tree(target)

  assert.deepEqual(second, first)
  await assertNoMigrationArtifacts(root)
})

it('strict target ownership refuses other names and symbolic-link targets before replacement', async (t) => {
  const root = await sandbox(t)
  const source = await fixture(root)
  const other = join(root, 'other')
  await mkdir(other)
  await writeFile(join(other, 'keep.txt'), 'do not replace')
  const before = await tree(other)

  await assert.rejects(
    migrateWorkspace({ source, target: other, allowMissing: [], dryRun: false }),
    /target.*from_affine/iu,
  )
  assert.deepEqual(await tree(other), before)

  const linkedTarget = join(root, 'from_affine')
  await symlink(other, linkedTarget, 'dir')
  await assert.rejects(
    migrateWorkspace({ source, target: linkedTarget, allowMissing: [], dryRun: false }),
    /symbolic link/iu,
  )
  assert.deepEqual(await tree(other), before)
  await assertNoMigrationArtifacts(root)
})

it('symbolic-link target parents cannot alias a target containing the source', async (t) => {
  const root = await sandbox(t)
  const actualParent = join(root, 'actual')
  const actualTarget = join(actualParent, 'from_affine')
  await mkdir(actualTarget, { recursive: true })
  const source = await fixture(actualTarget)
  await writeFile(join(actualTarget, 'keep.txt'), 'previous target')
  const before = await tree(actualTarget)
  const linkedParent = join(root, 'linked')
  await symlink(actualParent, linkedParent, 'dir')

  await assert.rejects(
    migrateWorkspace({
      source,
      target: join(linkedParent, 'from_affine'),
      allowMissing: [],
      dryRun: false,
    }),
    /symbolic link/iu,
  )

  assert.deepEqual(await tree(actualTarget), before)
  await assertNoMigrationArtifacts(root)
})

it('target symlink and containment checks repeat immediately before commit', async (t) => {
  const root = await sandbox(t)
  const source = await fixture(root)
  const parent = join(root, 'parent')
  const movedParent = join(root, 'moved-parent')
  const target = join(parent, 'from_affine')
  await mkdir(target, { recursive: true })
  await writeFile(join(target, 'keep.txt'), 'previous target')
  const before = await tree(target)
  const sourceBefore = await digest(source)

  await assert.rejects(migrateWorkspace(
    { source, target, allowMissing: [], dryRun: false },
    {
      validate: async (options) => {
        const result = await validateOutput(options)
        await rename(parent, movedParent)
        await symlink(movedParent, parent, 'dir')
        return result
      },
    },
  ), /symbolic link/iu)

  assert.deepEqual(await tree(join(movedParent, 'from_affine')), before)
  assert.equal(await digest(source), sourceBefore)
  await assertNoMigrationArtifacts(movedParent)
})

it('report-named active page keeps its note and both reports with a deterministic suffix', async (t) => {
  const root = await sandbox(t)
  const source = await fixture(root, { pageTitle: '_affine-migration' })
  const target = join(root, 'from_affine')

  await migrateWorkspace({ source, target, allowMissing: [], dryRun: false })

  const files = await tree(target)
  assert.deepEqual(Object.keys(files).sort(), [
    '_affine-migration/_affine-migration.md',
    '_affine-migration.json',
    '_affine-migration.md',
    '_trash/_affine-migration/Deleted page.md',
    expectAssetPath(files),
  ].sort())
  const note = await readFile(join(target, '_affine-migration/_affine-migration.md'), 'utf8')
  assert.match(note, /title: "_affine-migration"/u)
  assert.match(note, /Converted from a consistent backup/u)
  const jsonReport: unknown = JSON.parse(await readFile(join(target, '_affine-migration.json'), 'utf8'))
  assert.ok(jsonReport !== null && typeof jsonReport === 'object')
  assert.ok((await readFile(join(target, '_affine-migration.md'), 'utf8')).length > 0)
})

it('bookmark and YouTube blocks normalize bare and protocol-relative URLs end to end', async (t) => {
  const root = await sandbox(t)
  const source = await fixture(root, { externalLinks: true })
  const target = join(root, 'from_affine')

  await migrateWorkspace({ source, target, allowMissing: [], dryRun: false })

  const note = await readFile(join(target, 'First page/First page.md'), 'utf8')
  assert.match(note, /\]\(<https:\/\/example\.com\/docs>\)/u)
  assert.match(note, /\]\(<https:\/\/www\.youtube\.com\/watch\?v=test>\)/u)
})

it('dry-run executes the complete staged report and validation path without touching the target', async (t) => {
  const root = await sandbox(t)
  const source = await fixture(root, { assetState: 'missing' })
  const target = join(root, 'from_affine')
  await mkdir(target)
  await writeFile(join(target, 'keep.txt'), 'previous target')
  const before = await tree(target)
  const sourceBefore = await digest(source)
  let staged: Record<string, FileSnapshot> | undefined

  const result = await migrateWorkspace(
    { source, target, allowMissing: ['approved-missing'], dryRun: true },
    {
      validate: async (options) => {
        staged = await tree(options.outputDirectory)
        return validateOutput(options)
      },
    },
  )

  assert.equal(result.dryRun, true)
  assert.equal(result.pages, 2)
  assert.ok(staged !== undefined)
  assert.ok(staged['_affine-migration.json'] !== undefined)
  assert.ok(staged['_affine-migration.md'] !== undefined)
  assert.ok(staged['First page/First page.md'] !== undefined)
  assert.deepEqual(await tree(target), before)
  assert.equal(await digest(source), sourceBefore)
  await assertNoMigrationArtifacts(root)
})

it('dry-run does not create a missing target', async (t) => {
  const root = await sandbox(t)
  const source = await fixture(root)
  const target = join(root, 'from_affine')

  await migrateWorkspace({ source, target, allowMissing: [], dryRun: true })

  await assert.rejects(readdir(target), { code: 'ENOENT' })
  await assertNoMigrationArtifacts(root)
})
