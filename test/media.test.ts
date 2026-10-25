import type { AssetReference } from '../src/assets.ts'
import type { AffineBlock, BlockConversionContext } from '../src/converters/types.ts'
import type { PageRegistry } from '../src/page-registry.ts'

import type { AffinePageMetadata } from '../src/types.ts'
import assert from 'node:assert/strict'
import { it } from 'vitest'
import * as Y from 'yjs'
import { AssetCollection, AssetError } from '../src/assets.ts'
import { convertMediaBlock, mediaAssetRequest } from '../src/converters/media.ts'
import { BlockConversionError } from '../src/converters/types.ts'
import { buildPageRegistry, PageRegistryError } from '../src/page-registry.ts'

function page(id: string, title: string, trash = false): AffinePageMetadata {
  return { id, title, tags: [], trash }
}

function registry(...pages: AffinePageMetadata[]): PageRegistry {
  return buildPageRegistry({ pages, tags: [], blockVersions: {} })
}

function block(
  flavour: string,
  properties: Readonly<Record<string, unknown>>,
  id = 'media',
): AffineBlock {
  const document = new Y.Doc()
  const source = document.getMap<unknown>('blocks')
  source.set('sys:id', id)
  source.set('sys:flavour', flavour)
  source.set('sys:children', new Y.Array<string>())
  for (const [key, value] of Object.entries(properties)) {
    source.set(key, value)
  }
  return { id, flavour, children: [], source }
}

function context(pages: PageRegistry, documentId = 'doc'): BlockConversionContext {
  return { documentId, pages, blocks: new Map(), losses: [], allowMissingGroupChildren: [] }
}

function assets(...entries: AssetReference[]): AssetCollection {
  return new AssetCollection(entries)
}

function available(sourceId: string, path: string, mime: string): AssetReference {
  return {
    sourceId,
    status: 'available',
    path,
    bytes: 10,
    mime,
    sha256: 'a'.repeat(64),
  }
}

it('creates deterministic image requests and Obsidian embeds with optional captions', () => {
  const pages = registry(page('doc', 'Document'))
  const image = block('affine:image', { 'prop:sourceId': 'image-id', 'prop:caption': '' })
  const captioned = block('affine:image', {
    'prop:sourceId': 'image-id',
    'prop:caption': 'A [caption]',
  })
  const resolved = assets(available('image-id', 'assets/image--0123456789ab.png', 'image/png'))

  assert.deepEqual(mediaAssetRequest(image), { sourceId: 'image-id', name: 'image' })
  assert.equal(convertMediaBlock(image, context(pages), resolved), '![[assets/image--0123456789ab.png]]')
  assert.equal(
    convertMediaBlock(captioned, context(pages), resolved),
    '![[assets/image--0123456789ab.png|A \\[caption\\]]]',
  )
})

it('uses sanitized attachment names and selects embeds only for Obsidian-supported media', () => {
  const pages = registry(page('doc', 'Document'))
  const cases = [
    ['application/pdf', 'attachment', 'assets/report--0123456789ab.pdf', '![[assets/report--0123456789ab.pdf]]'],
    ['image/png', 'attachment', 'assets/preview--0123456789ab.png', '![[assets/preview--0123456789ab.png]]'],
    ['audio/mpeg', 'attachment', 'assets/sound--0123456789ab.mp3', '![[assets/sound--0123456789ab.mp3]]'],
    ['video/mp4', 'attachment', 'assets/movie--0123456789ab.mp4', '![[assets/movie--0123456789ab.mp4]]'],
    ['text/html; charset=utf-8', 'saved.html', 'assets/saved--0123456789ab.html', '[[assets/saved--0123456789ab.html|saved.html]]'],
    ['application/json', 'layout.json', 'assets/layout--0123456789ab.json', '[[assets/layout--0123456789ab.json|layout.json]]'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'sheet.xlsx', 'assets/sheet--0123456789ab.xlsx', '[[assets/sheet--0123456789ab.xlsx|sheet.xlsx]]'],
  ] as const

  for (const [mime, name, path, expected] of cases) {
    const attachment = block('affine:attachment', { 'prop:sourceId': 'asset-id', 'prop:name': name })
    assert.deepEqual(mediaAssetRequest(attachment), { sourceId: 'asset-id', name })
    assert.equal(
      convertMediaBlock(attachment, context(pages), assets(available('asset-id', path, mime))),
      expected,
    )
  }
})

it('renders the approved missing attachment as a warning callout without a broken link', () => {
  const approved = 'approved-asset'
  const pages = registry(page('doc', 'Document'))
  const attachment = block('affine:attachment', { 'prop:sourceId': approved, 'prop:name': 'saved.html' })

  const markdown = convertMediaBlock(
    attachment,
    context(pages, 'document-id'),
    assets({ sourceId: approved, status: 'missing' }),
  )

  assert.equal(markdown, [
    '> [!warning] Missing AFFiNE attachment',
    '> Document: `document-id`',
    `> Source ID: \`${approved}\``,
  ].join('\n'))
  assert.ok(!markdown.includes('[['))
})

it('rejects asset references omitted from extraction instead of emitting broken links', () => {
  const pages = registry(page('doc', 'Document'))
  const image = block('affine:image', { 'prop:sourceId': 'unregistered' })

  assert.throws(
    () => convertMediaBlock(image, context(pages), assets()),
    (error: unknown) => error instanceof AssetError && /unregistered.*extraction/i.test(error.message),
  )
})

it('converts bookmarks and YouTube blocks to titled external links with caption fallback', () => {
  const pages = registry(page('doc', 'Document'))
  const bookmark = block('affine:bookmark', {
    'prop:url': 'https://example.com/a(b)?x=1',
    'prop:title': 'A *bookmark*',
    'prop:caption': 'Unused caption',
  })
  const youtube = block('affine:embed-youtube', {
    'prop:url': 'https://www.youtube.com/watch?v=abc',
    'prop:title': null,
    'prop:caption': 'Video caption',
  })
  const fallback = block('affine:embed-youtube', {
    'prop:url': 'https://youtu.be/abc',
    'prop:title': '',
    'prop:caption': null,
  })

  assert.equal(
    convertMediaBlock(bookmark, context(pages), assets()),
    '[A \\*bookmark\\*](<https://example.com/a(b)?x=1>)',
  )
  assert.equal(
    convertMediaBlock(youtube, context(pages), assets()),
    '[Video caption](<https://www.youtube.com/watch?v=abc>)',
  )
  assert.equal(
    convertMediaBlock(fallback, context(pages), assets()),
    '[https://youtu.be/abc](<https://youtu.be/abc>)',
  )
})

it('normalizes bookmark and YouTube URLs and keeps labels on one line', () => {
  const pages = registry(page('doc', 'Document'))
  const bookmark = block('affine:bookmark', {
    'prop:url': 'example.com/docs',
    'prop:title': 'First\n*Second*',
  })
  const youtube = block('affine:embed-youtube', {
    'prop:url': '//www.youtube.com/watch?v=test',
    'prop:caption': 'Video\r\ncaption',
  })

  assert.equal(
    convertMediaBlock(bookmark, context(pages), assets()),
    '[First \\*Second\\*](<https://example.com/docs>)',
  )
  assert.equal(
    convertMediaBlock(youtube, context(pages), assets()),
    '[Video caption](<https://www.youtube.com/watch?v=test>)',
  )
})

it('rejects executable and local bookmark and YouTube URL schemes', () => {
  const pages = registry(page('doc', 'Document'))
  for (const url of ['javascript:alert(1)', 'data:text/html,script', 'file:///etc/passwd']) {
    for (const flavour of ['affine:bookmark', 'affine:embed-youtube']) {
      assert.throws(
        () => convertMediaBlock(block(flavour, { 'prop:url': url }), context(pages), assets()),
        /unsupported external URL scheme/iu,
      )
    }
  }
})

it('converts linked documents through final active and trash registry paths', () => {
  const pages = registry(
    page('doc', 'Document'),
    page('target', 'Target'),
    page('deleted', 'Archived', true),
  )
  const linked = block('affine:embed-linked-doc', { 'prop:pageId': 'target', 'prop:caption': null })
  const captioned = block('affine:embed-linked-doc', {
    'prop:pageId': 'deleted',
    'prop:caption': 'Deleted [page]',
  })

  assert.equal(convertMediaBlock(linked, context(pages), assets()), '![[Target]]')
  assert.equal(
    convertMediaBlock(captioned, context(pages), assets()),
    '![[_trash/Archived|Deleted \\[page\\]]]',
  )
})

const withChildren = block('affine:image', { 'prop:sourceId': 'id' })
const malformedMediaCases = [
  ['an empty image source ID', block('affine:image', { 'prop:sourceId': '' }), BlockConversionError, /property prop:sourceId must be a non-empty string/iu],
  ['a non-string attachment name', block('affine:attachment', { 'prop:sourceId': 'id', 'prop:name': 42 }), BlockConversionError, /property prop:name must be a non-empty string/iu],
  ['a missing bookmark URL', block('affine:bookmark', { 'prop:url': undefined, 'prop:title': 'title' }), BlockConversionError, /property prop:url must be a non-empty string/iu],
  ['a non-string YouTube caption', block('affine:embed-youtube', { 'prop:url': 'https://youtu.be/abc', 'prop:caption': 42 }), BlockConversionError, /property prop:caption must be a string or null/iu],
  ['an unresolved linked page', block('affine:embed-linked-doc', { 'prop:pageId': 'unknown' }), PageRegistryError, /unknown/iu],
  ['an unsupported flavour', block('affine:unknown', {}), BlockConversionError, /Unsupported AFFiNE media block flavour "affine:unknown"/iu],
  ['media children', { ...withChildren, children: ['child'] }, BlockConversionError, /AFFiNE media block media cannot have children/iu],
] as const

for (const [description, value, expectedError, expectedMessage] of malformedMediaCases) {
  it(`rejects ${description}`, () => {
    const pages = registry(page('doc', 'Document'))
    assert.throws(
      () => convertMediaBlock(value, context(pages), assets(available('id', 'assets/image--a.png', 'image/png'))),
      (error: unknown) => error instanceof expectedError && expectedMessage.test(error.message),
    )
  })
}
