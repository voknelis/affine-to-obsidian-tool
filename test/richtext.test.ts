import type { AffinePageMetadata } from '../src/types.ts'
import assert from 'node:assert/strict'
import { it } from 'vitest'

import * as Y from 'yjs'
import { DocumentCoverageLedger } from '../src/coverage.ts'
import { buildPageRegistry, PageRegistryError } from '../src/page-registry.ts'
import { renderRichText } from '../src/richtext.ts'

type Attributes = Record<string, unknown>

function richText(...operations: ReadonlyArray<{ text: string, attributes?: Attributes }>): Y.Text {
  const document = new Y.Doc()
  const text = document.getText('rich')
  for (const operation of operations) {
    text.insert(text.length, operation.text, operation.attributes ?? {})
  }
  return text
}

function registry(pages: AffinePageMetadata[] = []) {
  return buildPageRegistry({ pages, tags: [], blockVersions: {} })
}

function page(id: string, title: string, trash = false): AffinePageMetadata {
  return { id, title, trash, tags: [] }
}

it('renders plain text and every basic observed AFFiNE mark', () => {
  const pages = registry()
  const cases = [
    { attributes: {}, expected: 'text' },
    { attributes: { bold: true }, expected: '**text**' },
    { attributes: { italic: true }, expected: '*text*' },
    { attributes: { underline: true }, expected: '<u>text</u>' },
    { attributes: { strike: true }, expected: '~~text~~' },
    { attributes: { code: true }, expected: '`text`' },
  ]

  for (const { attributes, expected } of cases) {
    const result = renderRichText(richText({ text: 'text', attributes }), pages)
    assert.equal(result.markdown, expected)
    assert.deepEqual(result.losses, [])
  }
})

it('renders highlight and reports loss of its source visual color', () => {
  const result = renderRichText(
    richText({ text: 'important', attributes: { background: 'yellow' } }),
    registry(),
  )

  assert.equal(result.markdown, '==important==')
  assert.deepEqual(result.losses, [
    { kind: 'visual-color', attribute: 'background', value: 'yellow', text: 'important' },
  ])
})

it('preserves text with unsupported foreground color and reports the visual loss', () => {
  const result = renderRichText(
    richText({ text: 'red', attributes: { color: 'var(--affine-text-red)' } }),
    registry(),
  )

  assert.equal(result.markdown, 'red')
  assert.deepEqual(result.losses, [
    {
      kind: 'visual-color',
      attribute: 'color',
      value: 'var(--affine-text-red)',
      text: 'red',
    },
  ])
})

it('binds conversion losses to the exact coverage delta identity', () => {
  const document = new Y.Doc()
  const block = new Y.Map<unknown>()
  document.getMap('blocks').set('block', block)
  const text = new Y.Text()
  block.set('prop:text', text)
  text.insert(0, 'red', { color: 'red' })
  const coverage = new DocumentCoverageLedger('doc', [{ id: 'block', source: block }])

  const result = renderRichText(text, registry(), coverage)
  assert.deepEqual(result.losses, [{
    kind: 'visual-color',
    attribute: 'color',
    value: 'red',
    text: 'red',
    blockId: 'block',
    property: 'prop:text',
    deltaIndex: 0,
  }])
})

it('renders external links with escaped labels and URL destinations', () => {
  const result = renderRichText(
    richText({
      text: 'a [label]',
      attributes: { link: 'https://example.com/a b_(c)' },
    }),
    registry(),
  )

  assert.equal(result.markdown, '[a \\[label\\]](<https://example.com/a b_(c)>)')
  assert.deepEqual(result.losses, [])
})

it('normalizes scheme-less AFFiNE external links to HTTPS', () => {
  const result = renderRichText(
    richText({ text: 'jisho.org', attributes: { link: 'jisho.org' } }),
    registry(),
  )

  assert.equal(result.markdown, '[jisho.org](<https://jisho.org>)')
})

it('rejects executable and local rich-text link schemes', () => {
  for (const link of ['javascript:alert(1)', 'data:text/html,script', 'file:///etc/passwd']) {
    assert.throws(
      () => renderRichText(richText({ text: 'unsafe', attributes: { link } }), registry()),
      /unsupported external URL scheme/iu,
    )
  }
})

it('renders overlapping marks around the same escaped delta', () => {
  const result = renderRichText(
    richText({
      text: ' *both* ',
      attributes: { bold: true, italic: true, underline: true },
    }),
    registry(),
  )

  assert.equal(result.markdown, ' ***<u>\\*both\\*</u>*** ')
})

it('renders consecutive deltas independently and preserves multiline text', () => {
  const result = renderRichText(
    richText(
      { text: 'plain\n# not heading\n', attributes: {} },
      { text: 'bold\nnext', attributes: { bold: true } },
    ),
    registry(),
  )

  assert.equal(result.markdown, 'plain<br>\\# not heading<br>**bold<br>next**')
})

it('escapes ordered-list markers and code indentation split across deltas', () => {
  const ordered = renderRichText(
    richText(
      { text: '1', attributes: { bold: false } },
      { text: '. item' },
    ),
    registry(),
  )
  const indented = renderRichText(
    richText(
      { text: '  ', attributes: { bold: false } },
      { text: '  item' },
    ),
    registry(),
  )

  assert.equal(ordered.markdown, '1\\. item')
  assert.equal(indented.markdown, '  &#32; item')
})

it('escapes indented and adjacent ordered-list markers', () => {
  assert.equal(renderRichText(richText({ text: '  1. item' }), registry()).markdown, '  1\\. item')
  assert.equal(renderRichText(richText({ text: '  1) item' }), registry()).markdown, '  1\\) item')

  const indented = renderRichText(
    richText(
      { text: '  1', attributes: { bold: false } },
      { text: '. item' },
    ),
    registry(),
  )
  const parenthesized = renderRichText(
    richText(
      { text: '1', attributes: { bold: false } },
      { text: ') item' },
    ),
    registry(),
  )
  assert.equal(indented.markdown, '  1\\. item')
  assert.equal(parenthesized.markdown, '1\\) item')
})

it('escapes whole and cross-delta tab indentation', () => {
  assert.equal(renderRichText(richText({ text: '  \tcode' }), registry()).markdown, '  &#9;code')

  const splitSpaces = renderRichText(
    richText(
      { text: ' ', attributes: { bold: false } },
      { text: '  ', attributes: { italic: false } },
      { text: '\tcode' },
    ),
    registry(),
  )
  const splitTabs = renderRichText(
    richText(
      { text: ' ', attributes: { bold: false } },
      { text: '\t', attributes: { italic: false } },
      { text: '\tcode' },
    ),
    registry(),
  )
  assert.equal(splitSpaces.markdown, '   &#9;code')
  assert.equal(splitTabs.markdown, ' &#9;&#9;code')
})

it('coalesces CRLF split across deltas without merging coverage identities', () => {
  const document = new Y.Doc()
  const block = new Y.Map<unknown>()
  document.getMap('blocks').set('block', block)
  const text = new Y.Text()
  block.set('prop:text', text)
  text.insert(0, 'first\r', { color: 'red' })
  text.insert(text.length, '\nsecond', {})
  const coverage = new DocumentCoverageLedger('doc', [{ id: 'block', source: block }])

  const result = renderRichText(text, registry(), coverage)
  coverage.recordBlock('block', 'rendered')
  const completed = coverage.complete()

  assert.equal(result.markdown, 'first<br>second')
  assert.deepEqual(completed.richTextDeltas, {
    total: 2,
    rendered: 1,
    structuralMetadataOnly: 0,
    approvedLoss: 1,
  })
})

it('moves boundary whitespace outside every delimiter-based mark and link', () => {
  const cases = [
    { attributes: { bold: true }, expected: ' **text** ' },
    { attributes: { italic: true }, expected: ' *text* ' },
    { attributes: { underline: true }, expected: ' <u>text</u> ' },
    { attributes: { strike: true }, expected: ' ~~text~~ ' },
    { attributes: { background: 'yellow' }, expected: ' ==text== ' },
    { attributes: { link: 'example.com' }, expected: ' [text](<https://example.com>) ' },
  ]

  for (const { attributes, expected } of cases) {
    assert.equal(renderRichText(richText({ text: ' text ', attributes }), registry()).markdown, expected)
  }
})

it('keeps newlines outside boundary delimiters and blank lines inside formatted content', () => {
  const cases = [
    { attributes: { bold: true }, wrap: (text: string) => `**${text}**` },
    { attributes: { italic: true }, wrap: (text: string) => `*${text}*` },
    { attributes: { underline: true }, wrap: (text: string) => `<u>${text}</u>` },
    { attributes: { strike: true }, wrap: (text: string) => `~~${text}~~` },
    { attributes: { background: 'yellow' }, wrap: (text: string) => `==${text}==` },
    { attributes: { link: 'example.com' }, wrap: (text: string) => `[${text}](<https://example.com>)` },
  ]

  for (const { attributes, wrap } of cases) {
    assert.equal(
      renderRichText(richText({ text: '\ntext\n', attributes }), registry()).markdown,
      `<br>${wrap('text')}<br>`,
    )
  }
  assert.equal(
    renderRichText(richText({ text: 'bold\n\nnext', attributes: { bold: true } }), registry()).markdown,
    '**bold<br><br>next**',
  )
})

it('preserves code-span whitespace while overlapping other marks', () => {
  assert.equal(
    renderRichText(richText({ text: ' text ', attributes: { code: true, bold: true } }), registry()).markdown,
    '**`  text  `**',
  )
  assert.equal(
    renderRichText(richText({ text: 'first\nsecond', attributes: { code: true } }), registry()).markdown,
    '`first second`',
  )
})

it('resolves active and trash LinkedPage references to path-qualified aliased wikilinks', () => {
  const pages = registry([
    page('active-id', 'Active Note'),
    page('trash-id', 'Deleted Note', true),
  ])
  const result = renderRichText(
    richText(
      {
        text: 'active alias',
        attributes: { reference: { type: 'LinkedPage', pageId: 'active-id' } },
      },
      {
        text: 'trash | alias',
        attributes: { reference: { type: 'LinkedPage', pageId: 'trash-id' } },
      },
    ),
    pages,
  )

  assert.equal(
    result.markdown,
    '[[Active Note|active alias]][[_trash/Deleted Note|trash \\| alias]]',
  )
})

it('escapes wikilink delimiters after inline-code rendering', () => {
  const result = renderRichText(
    richText({
      text: 'a|b]]c',
      attributes: { code: true, reference: { type: 'LinkedPage', pageId: 'target' } },
    }),
    registry([page('target', 'Target')]),
  )

  assert.equal(result.markdown, '[[Target|`a\\|b\\]\\]c`]]')
})

it('fails explicitly for unresolved LinkedPage references', () => {
  assert.throws(
    () => renderRichText(
      richText({
        text: 'missing',
        attributes: { reference: { type: 'LinkedPage', pageId: 'missing-id' } },
      }),
      registry(),
    ),
    (error: unknown) => error instanceof PageRegistryError && /missing-id/u.test(error.message),
  )
})

it('fails explicitly for malformed deltas and unknown attributes', () => {
  assert.throws(
    () => renderRichText(richText({ text: 'text', attributes: { unknown: true } }), registry()),
    /unknown rich-text attribute "unknown"/u,
  )
  assert.throws(
    () => renderRichText(richText({ text: 'text', attributes: { bold: 'yes' } }), registry()),
    /bold must be true/u,
  )
})

it('rejects non-string rich-text inserts', () => {
  const document = new Y.Doc()
  const text = document.getText('rich')
  text.insertEmbed(0, { value: 'not text' })

  assert.throws(() => renderRichText(text, registry()), /delta insert must be a string/u)
})
