import type { TestContext } from 'vitest'
import type { AssetBlob, AssetRequest } from '../src/assets.ts'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { it } from 'vitest'
import {

  AssetCollection,
  AssetError,

  extractAssets,
  extractSqliteAssets,
} from '../src/assets.ts'

const PNG = Uint8Array.from([
  0x89,
  0x50,
  0x4E,
  0x47,
  0x0D,
  0x0A,
  0x1A,
  0x0A,
  1,
  2,
  3,
])
const JPEG = Uint8Array.from([0xFF, 0xD8, 0xFF, 0xE0, 1, 2])
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
const SVG = new TextEncoder().encode('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>')
const PDF = new TextEncoder().encode('%PDF-1.7\nbody')
const XLSX = Uint8Array.from([0x50, 0x4B, 0x03, 0x04, 1, 2])
const HTML = new TextEncoder().encode('<!doctype html><html><body>actual bytes</body></html>')

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function temporaryDirectory(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'affine-assets-test-'))
  t.onTestFinished(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

function reader(entries: Readonly<Record<string, AssetBlob | undefined>>) {
  return (sourceId: string): AssetBlob | undefined => entries[sourceId]
}

function request(sourceId: string, name: string): AssetRequest {
  return { sourceId, name }
}

it('uses actual bytes for deterministic names and manifests and reads repeated sourceIds once', async (t) => {
  const firstOutput = temporaryDirectory(t)
  const secondOutput = temporaryDirectory(t)
  let reads = 0
  const readBlob = (sourceId: string): AssetBlob | undefined => {
    assert.equal(sourceId, 'image/source')
    reads += 1
    return { data: PNG, mime: 'image/png' }
  }
  const requests = [request('image/source', '../My diagram.old.png'), request('image/source', 'ignored.png')]

  const first = await extractAssets(requests, { outputDirectory: firstOutput, readBlob })
  const second = await extractAssets(requests, { outputDirectory: secondOutput, readBlob })
  const digest = sha256(PNG)
  const expectedPath = `assets/..-My diagram.old--${digest.slice(0, 12)}.png`
  const expected = {
    sourceId: 'image/source',
    status: 'available',
    path: expectedPath,
    bytes: PNG.byteLength,
    mime: 'image/png',
    sha256: digest,
  }

  assert.deepEqual(first.entries, [expected])
  assert.deepEqual(second.entries, [expected])
  assert.equal(reads, 2)
  assert.deepEqual(readFileSync(join(firstOutput, expectedPath)), Buffer.from(PNG))
  assert.deepEqual(readdirSync(join(firstOutput, 'assets')), [expectedPath.slice('assets/'.length)])
  assert.deepEqual(readFileSync(join(secondOutput, expectedPath)), Buffer.from(PNG))
})

it('sorts manifest IDs by code units rather than locale collation', () => {
  const collection = new AssetCollection([
    { sourceId: 'a', status: 'missing' },
    { sourceId: 'Z', status: 'missing' },
  ])
  assert.deepEqual(collection.entries.map(entry => entry.sourceId), ['Z', 'a'])
})

it('derives extensions from normalized MIME and validates every required signature', async (t) => {
  const output = temporaryDirectory(t)
  const fixtures = [
    ['jpeg', 'photo.jpeg', 'image/jpeg; charset=binary', JPEG, '.jpg'],
    ['webp', 'photo.bin', 'IMAGE/WEBP', WEBP, '.webp'],
    ['svg', 'drawing.txt', 'image/svg+xml', SVG, '.svg'],
    ['pdf', 'document.bin', 'application/pdf', PDF, '.pdf'],
    ['xlsx', 'sheet.zip', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', XLSX, '.xlsx'],
    ['html', 'page.txt', 'text/html; charset=utf-8', HTML, '.html'],
    ['json', 'layout.txt', 'application/json', new TextEncoder().encode('{"cells":[]}'), '.json'],
    ['plain', 'notes.dat', 'text/plain; charset=utf-8', new TextEncoder().encode('plain text'), '.txt'],
  ] as const
  const blobs: Record<string, AssetBlob> = {}
  for (const [id, , mime, data] of fixtures) {
    blobs[id] = { data, mime }
  }

  const result = await extractAssets(
    fixtures.map(([id, name]) => request(id, name)),
    { outputDirectory: output, readBlob: reader(blobs) },
  )

  for (const [id, , mime, data, extension] of fixtures) {
    const entry = result.require(id)
    assert.equal(entry.status, 'available')
    if (entry.status !== 'available') {
      continue
    }
    assert.ok(entry.path.endsWith(`${sha256(data).slice(0, 12)}${extension}`))
    assert.equal(entry.mime, mime)
    assert.equal(entry.bytes, data.byteLength)
    assert.equal(entry.sha256, sha256(data))
  }
})

it('deduplicates identical content across sourceIds with an order-independent canonical name', async (t) => {
  const firstOutput = temporaryDirectory(t)
  const secondOutput = temporaryDirectory(t)
  const blobs = {
    'source-z': { data: PNG, mime: 'IMAGE/PNG; charset=binary' },
    'source-a': { data: PNG, mime: 'image/png' },
  }
  const requests = [request('source-z', 'zeta.png'), request('source-a', 'alpha.png')]

  const first = await extractAssets(requests, { outputDirectory: firstOutput, readBlob: reader(blobs) })
  const second = await extractAssets([...requests].reverse(), {
    outputDirectory: secondOutput,
    readBlob: reader(blobs),
  })
  const digest = sha256(PNG)
  const canonical = `assets/alpha--${digest.slice(0, 12)}.png`

  assert.deepEqual(first.entries.map(entry => [entry.sourceId, entry.status === 'available' ? entry.path : '']), [
    ['source-a', canonical],
    ['source-z', canonical],
  ])
  assert.deepEqual(second.entries, first.entries)
  assert.deepEqual(readdirSync(join(firstOutput, 'assets')), [`alpha--${digest.slice(0, 12)}.png`])
  assert.deepEqual(readFileSync(join(secondOutput, canonical)), Buffer.from(PNG))
})

it('does not deduplicate identical bytes across incompatible normalized media types', async (t) => {
  const output = temporaryDirectory(t)
  const blobs = {
    zip: { data: XLSX, mime: 'application/zip' },
    xlsx: { data: XLSX, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    html: { data: HTML, mime: 'text/html; charset=utf-8' },
    plain: { data: HTML, mime: 'text/plain' },
  }

  const result = await extractAssets([
    request('zip', 'archive.bin'),
    request('xlsx', 'workbook.bin'),
    request('html', 'page.bin'),
    request('plain', 'page-copy.bin'),
  ], { outputDirectory: output, readBlob: reader(blobs) })

  const paths = new Map<string, string>()
  for (const [sourceId, extension] of [['zip', '.zip'], ['xlsx', '.xlsx'], ['html', '.html'], ['plain', '.txt']] as const) {
    const entry = result.require(sourceId)
    assert.equal(entry.status, 'available')
    if (entry.status !== 'available') {
      continue
    }
    assert.ok(entry.path.endsWith(extension))
    paths.set(sourceId, entry.path)
  }
  assert.notEqual(paths.get('zip'), paths.get('xlsx'))
  assert.notEqual(paths.get('html'), paths.get('plain'))
  assert.equal(readdirSync(join(output, 'assets')).length, 4)
})

it('writes long multibyte asset names without exceeding filename byte limits', async (t) => {
  const output = temporaryDirectory(t)
  const result = await extractAssets([request('image', `${'🙂'.repeat(200)}.png`)], {
    outputDirectory: output,
    readBlob: reader({ image: { data: PNG, mime: 'image/png' } }),
  })

  const entry = result.require('image')
  assert.equal(entry.status, 'available')
  if (entry.status !== 'available') {
    return
  }
  const basename = entry.path.slice('assets/'.length)
  assert.ok(Buffer.byteLength(basename, 'utf8') <= 255)
  assert.ok(basename.endsWith(`--${sha256(PNG).slice(0, 12)}.png`))
  assert.ok(!basename.includes('\uFFFD'))
  assert.deepEqual(readFileSync(join(output, entry.path)), Buffer.from(PNG))
})

it('allows only the explicitly approved absent blob and emits no asset file', async (t) => {
  const output = temporaryDirectory(t)
  const approved = 'approved-asset'

  const result = await extractAssets([request(approved, 'saved.html')], {
    outputDirectory: output,
    readBlob: reader({}),
    allowMissing: [approved],
  })

  assert.deepEqual(result.entries, [{ sourceId: approved, status: 'missing' }])
  assert.deepEqual(result.missing, [{ sourceId: approved, status: 'missing' }])
  assert.deepEqual(readdirSync(output), [])
})

it('rejects additional missing, deleted, and zero-length blobs even when listed as allowed', async (t) => {
  const output = temporaryDirectory(t)
  const approved = 'approved-asset'
  const cases: Array<{ id: string, blob?: AssetBlob, error: RegExp }> = [
    { id: 'additional-missing', error: /additional-missing.*missing/i },
    { id: 'deleted', blob: { data: PNG, mime: 'image/png', deletedAt: '2026-01-01' }, error: /deleted.*deleted/i },
    { id: 'zero', blob: { data: new Uint8Array(), mime: 'image/png' }, error: /zero.*zero-length/i },
  ]

  for (const { id, blob, error } of cases) {
    await assert.rejects(extractAssets([request(id, 'asset.png')], {
      outputDirectory: output,
      readBlob: reader({ [id]: blob }),
      allowMissing: [approved, ...(id === 'additional-missing' ? [] : [id])],
    }), error)
  }
})

it('rejects signature mismatches instead of trusting MIME or names', async (t) => {
  const output = temporaryDirectory(t)
  const fixtures = [
    ['png', 'image/png'],
    ['jpeg', 'image/jpeg'],
    ['webp', 'image/webp'],
    ['svg', 'image/svg+xml'],
    ['pdf', 'application/pdf'],
    ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['html', 'text/html; charset=utf-8'],
  ] as const

  for (const [id, mime] of fixtures) {
    await assert.rejects(extractAssets([request(id, 'wrong.dat')], {
      outputDirectory: output,
      readBlob: reader({ [id]: { data: new TextEncoder().encode('not the declared format'), mime } }),
    }), (error: unknown) => {
      assert.ok(error instanceof AssetError)
      assert.match(error.message, new RegExp(`${id}.*signature`, 'i'))
      return true
    })
  }
})

it('rejects inherited object keys as MIME types', async (t) => {
  for (const mime of ['constructor', 'toString', '__proto__']) {
    await assert.rejects(extractAssets([request(mime, 'asset.png')], {
      outputDirectory: temporaryDirectory(t),
      readBlob: reader({ [mime]: { data: PNG, mime } }),
    }), /unsupported MIME type/iu)
  }
})

it('fails before writing any files when one requested asset is invalid', async (t) => {
  const output = temporaryDirectory(t)
  const blobs = {
    good: { data: PNG, mime: 'image/png' },
    bad: { data: PNG, mime: 'application/pdf' },
  }

  await assert.rejects(extractAssets([request('good', 'good.png'), request('bad', 'bad.pdf')], {
    outputDirectory: output,
    readBlob: reader(blobs),
  }), /bad.*signature/i)
  assert.deepEqual(readdirSync(output), [])
})

it('reads AFFiNE blobs from SQLite read-only and ignores stale size metadata', async (t) => {
  const directory = temporaryDirectory(t)
  const source = join(directory, 'source.db')
  const database = new DatabaseSync(source)
  database.exec('CREATE TABLE blobs (key TEXT PRIMARY KEY, data BLOB NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, deleted_at TEXT)')
  database.prepare('INSERT INTO blobs (key, data, mime, size, deleted_at) VALUES (?, ?, ?, ?, ?)')
    .run('sqlite-id', PNG, 'image/png', -1, null)
  database.close()

  const result = await extractSqliteAssets(source, [request('sqlite-id', 'image.png')], {
    outputDirectory: directory,
  })

  const entry = result.require('sqlite-id')
  assert.equal(entry.status, 'available')
  if (entry.status === 'available') {
    assert.equal(entry.bytes, PNG.byteLength)
    assert.deepEqual(readFileSync(join(directory, entry.path)), Buffer.from(PNG))
  }
})
