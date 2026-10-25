import type { ConvertCustomBlock } from '../src/converters/types.ts'
import type { AffineDocument, AffinePageMetadata } from '../src/types.ts'
import assert from 'node:assert/strict'

import { it } from 'vitest'
import * as Y from 'yjs'
import { convertBasicPage } from '../src/converters/basic.ts'
import { BlockConversionError } from '../src/converters/types.ts'
import { buildPageRegistry } from '../src/page-registry.ts'

interface BlockSpec {
  id: string
  flavour: string
  children?: string[]
  text?: string
  title?: string
  type?: string
  checked?: boolean
  language?: string
}

function page(id = 'doc', title = 'Document'): AffinePageMetadata {
  return { id, title, tags: [], trash: false }
}

function registry(...pages: AffinePageMetadata[]) {
  return buildPageRegistry({ pages, tags: [], blockVersions: {} })
}

function fixture(documentId: string, specs: BlockSpec[]): AffineDocument {
  const doc = new Y.Doc()
  const blocks = doc.getMap<unknown>('blocks')
  for (const spec of specs) {
    const block = new Y.Map<unknown>()
    block.set('sys:id', spec.id)
    block.set('sys:flavour', spec.flavour)
    const children = new Y.Array<string>()
    children.push(spec.children ?? [])
    block.set('sys:children', children)
    if (spec.text !== undefined) {
      const text = new Y.Text()
      text.insert(0, spec.text)
      block.set('prop:text', text)
    }
    if (spec.title !== undefined) {
      const title = new Y.Text()
      title.insert(0, spec.title)
      block.set('prop:title', title)
    }
    if (spec.type !== undefined) {
      block.set('prop:type', spec.type)
    }
    if (spec.checked !== undefined) {
      block.set('prop:checked', spec.checked)
    }
    if (spec.language !== undefined) {
      block.set('prop:language', spec.language)
    }
    blocks.set(spec.id, block)
  }
  return { id: documentId, doc, snapshotApplied: true, updateCount: 0 }
}

function basicDocument(children: BlockSpec[], documentId = 'doc'): AffineDocument {
  const nested = new Set(children.flatMap(child => child.children ?? []))
  const rootChildren = children.filter(child => !nested.has(child.id)).map(child => child.id)
  return fixture(documentId, [
    { id: documentId, flavour: 'affine:page', title: 'Source title', children: rootChildren },
    ...children,
  ])
}

const rejectCustomBlock: ConvertCustomBlock = (block, context) => {
  throw new BlockConversionError(
    `Unsupported AFFiNE block flavour "${block.flavour}" in block ${block.id} of document ${context.documentId}.`,
  )
}
function render(document: AffineDocument, title = 'Document'): string {
  return convertBasicPage(document, registry(page(document.id, title)), rejectCustomBlock).markdown
}

function expected(title: string, body = ''): string {
  return `---\ntitle: "${title}"\naffine_id: "doc"\ntrash: false\ntags: []\n---\n\n# ${title}${body.length === 0 ? '' : `\n\n${body}`}\n`
}

it('assembles frontmatter and title, traversing page and note children in source order', () => {
  const document = basicDocument([
    {
      id: 'note',
      flavour: 'affine:note',
      children: ['first', 'second'],
    },
    { id: 'first', flavour: 'affine:paragraph', type: 'text', text: 'first' },
    { id: 'second', flavour: 'affine:paragraph', type: 'text', text: 'second' },
  ])

  assert.equal(render(document), expected('Document', 'first\n\nsecond'))
})

it('renders text paragraphs, h1-h6, and multiline quotes', () => {
  const types = ['text', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'quote']
  const document = basicDocument(types.map((type, index) => ({
    id: `paragraph-${index}`,
    flavour: 'affine:paragraph',
    type,
    text: type === 'quote' ? 'quoted\nnext' : type,
  })))

  assert.equal(
    render(document),
    expected('Document', 'text\n\n# h1\n\n## h2\n\n### h3\n\n#### h4\n\n##### h5\n\n###### h6\n\n> quoted<br>next'),
  )
})

it('renders bulleted, numbered, and todo lists with checked state and nested ordering', () => {
  const document = basicDocument([
    { id: 'bullet', flavour: 'affine:list', type: 'bulleted', text: 'bullet' },
    { id: 'number', flavour: 'affine:list', type: 'numbered', text: 'number' },
    { id: 'open', flavour: 'affine:list', type: 'todo', checked: false, text: 'open' },
    { id: 'done', flavour: 'affine:list', type: 'todo', checked: true, text: 'done' },
    {
      id: 'parent',
      flavour: 'affine:list',
      type: 'numbered',
      text: 'parent',
      children: ['child', 'last'],
    },
    { id: 'child', flavour: 'affine:list', type: 'bulleted', text: 'child' },
    { id: 'last', flavour: 'affine:list', type: 'numbered', text: 'last' },
  ])

  assert.equal(
    render(document),
    expected('Document', '- bullet\n1. number\n- [ ] open\n- [x] done\n1. parent\n    - child\n    1. last'),
  )
})

it('uses four-space indentation for mixed multi-level ordered nesting', () => {
  const document = basicDocument([
    {
      id: 'parent',
      flavour: 'affine:list',
      type: 'numbered',
      text: 'parent',
      children: ['bullet', 'ordered'],
    },
    {
      id: 'bullet',
      flavour: 'affine:list',
      type: 'bulleted',
      text: 'bullet',
      children: ['grandchild', 'todo'],
    },
    { id: 'grandchild', flavour: 'affine:list', type: 'numbered', text: 'grandchild' },
    { id: 'todo', flavour: 'affine:list', type: 'todo', checked: true, text: 'todo' },
    { id: 'ordered', flavour: 'affine:list', type: 'numbered', text: 'ordered' },
  ])

  assert.equal(
    render(document),
    expected(
      'Document',
      '1. parent\n    - bullet\n        1. grandchild\n        - [x] todo\n    1. ordered',
    ),
  )
})

it('renders language-aware code fences and dividers', () => {
  const document = basicDocument([
    { id: 'code', flavour: 'affine:code', language: 'typescript', text: 'const value = 1;' },
    { id: 'divider', flavour: 'affine:divider' },
    { id: 'plain', flavour: 'affine:code', text: 'plain text' },
  ])

  assert.equal(
    render(document),
    expected('Document', '```typescript\nconst value = 1;\n```\n\n---\n\n```\nplain text\n```'),
  )
})

it('uses a fence longer than every backtick run in code content', () => {
  const code = 'before\n```\nconst longer = "````";\nafter'
  const document = basicDocument([
    { id: 'code', flavour: 'affine:code', language: 'markdown', text: code },
  ])

  assert.equal(render(document), expected('Document', `\`\`\`\`\`markdown\n${code}\n\`\`\`\`\``))
})

it('handles an empty page and empty paragraph, quote, list, and code blocks', () => {
  assert.equal(render(basicDocument([])), expected('Document'))

  const document = basicDocument([
    { id: 'paragraph', flavour: 'affine:paragraph', type: 'text', text: '' },
    { id: 'quote', flavour: 'affine:paragraph', type: 'quote', text: '' },
    { id: 'list', flavour: 'affine:list', type: 'bulleted', text: '' },
    { id: 'code', flavour: 'affine:code', text: '' },
  ])
  assert.equal(render(document), expected('Document', '\n\n>\n\n- \n\n```\n\n```'))
})

it('uses the deterministic untitled heading and escapes Markdown in titles', () => {
  assert.equal(render(basicDocument([]), 'A *document*'), expected('A *document*').replace('# A *document*', '# A \\*document\\*'))
  assert.equal(render(basicDocument([]), ''), expected('', '').replace('# \n', '# Untitled\\-\\-doc\n'))
})

it('normalizes multiline page titles to a single-line heading', () => {
  assert.match(render(basicDocument([]), 'First\nSecond\r\n*Third*'), /\n# First Second \\\*Third\\\*\n$/u)
})

it('block map insertion order does not affect output', () => {
  const specs = [
    { id: 'doc', flavour: 'affine:page', title: 'Source title', children: ['note'] },
    {
      id: 'note',
      flavour: 'affine:note',
      children: ['a', 'b'],
    },
    { id: 'a', flavour: 'affine:paragraph', type: 'text', text: 'a' },
    { id: 'b', flavour: 'affine:paragraph', type: 'text', text: 'b' },
  ]
  assert.equal(render(fixture('doc', specs)), render(fixture('doc', [...specs].reverse())))
})

it('resolves a single page root whose block ID differs from the document ID', () => {
  const document = fixture('doc', [
    { id: 'root-block', flavour: 'affine:page', title: 'Source title', children: ['paragraph'] },
    { id: 'paragraph', flavour: 'affine:paragraph', type: 'text', text: 'body' },
  ])

  assert.equal(render(document), expected('Document', 'body'))

  const multipleRoots = fixture('doc', [
    { id: 'first-root', flavour: 'affine:page', title: 'First' },
    { id: 'second-root', flavour: 'affine:page', title: 'Second' },
  ])
  assert.throws(() => render(multipleRoots), /exactly one AFFiNE page root.*doc/iu)
})

it('treats a null code language as an absent language', () => {
  const document = basicDocument([
    { id: 'code', flavour: 'affine:code', text: 'plain text' },
  ])
  document.doc.getMap<Y.Map<unknown>>('blocks').get('code')?.set('prop:language', null)

  assert.equal(render(document), expected('Document', '```\nplain text\n```'))
})

it('rejects direct and indirect cycles with document and block context', () => {
  const direct = basicDocument([
    { id: 'note', flavour: 'affine:note', children: ['doc'] },
  ])
  assert.throws(() => render(direct), /cycle.*doc.*note.*doc/iu)

  const indirect = fixture('doc', [
    { id: 'doc', flavour: 'affine:page', title: 'Source title', children: ['note'] },
    { id: 'note', flavour: 'affine:note', children: ['list'] },
    { id: 'list', flavour: 'affine:list', type: 'bulleted', text: 'loop', children: ['note'] },
  ])
  assert.throws(() => render(indirect), /cycle.*note.*list.*note/iu)
})

it('rejects missing child IDs and repeated non-cyclic block references', () => {
  const missing = basicDocument([
    { id: 'note', flavour: 'affine:note', children: ['absent'] },
  ])
  assert.throws(() => render(missing), /Missing AFFiNE block "absent".*doc/iu)

  const repeated = basicDocument([
    { id: 'note', flavour: 'affine:note', children: ['paragraph', 'paragraph'] },
    { id: 'paragraph', flavour: 'affine:paragraph', type: 'text', text: 'once' },
  ])
  assert.throws(() => render(repeated), /multiple times.*paragraph/iu)
})

it('rejects malformed block maps, identities, children, roots, and unknown flavours', () => {
  const wrongMap = basicDocument([])
  wrongMap.doc.getMap('blocks').set('bad', 'not a map')
  assert.throws(() => render(wrongMap), /bad.*Y\.Map/iu)

  const wrongId = basicDocument([])
  wrongId.doc.getMap<Y.Map<unknown>>('blocks').get('doc')?.set('sys:id', 42)
  assert.throws(() => render(wrongId), /doc.*sys:id/iu)

  const wrongChildren = basicDocument([])
  wrongChildren.doc.getMap<Y.Map<unknown>>('blocks').get('doc')?.set('sys:children', 'note')
  assert.throws(() => render(wrongChildren), /doc.*sys:children/iu)

  const wrongRoot = fixture('doc', [
    { id: 'doc', flavour: 'affine:note', title: 'Not a page' },
  ])
  assert.throws(() => render(wrongRoot), /root.*affine:page/iu)

  const unknown = basicDocument([
    { id: 'mystery', flavour: 'affine:mystery' },
  ])
  assert.throws(() => render(unknown), /Unsupported AFFiNE block flavour.*affine:mystery/iu)
})

it('rejects malformed paragraph, list, code, and leaf properties', () => {
  const unsupportedParagraph = { id: 'block', flavour: 'affine:paragraph', type: 'h7', text: 'bad' }
  assert.throws(() => render(basicDocument([unsupportedParagraph])), /paragraph type/iu)

  const unsupportedList = { id: 'block', flavour: 'affine:list', type: 'ordered', text: 'bad' }
  assert.throws(() => render(basicDocument([unsupportedList])), /list type/iu)

  const codeWithChildren = {
    id: 'block',
    flavour: 'affine:code',
    language: 'typescript',
    text: 'bad',
    children: ['doc'],
  }
  assert.throws(() => render(basicDocument([codeWithChildren])), /cannot have children/iu)

  const missingText = basicDocument([
    { id: 'paragraph', flavour: 'affine:paragraph', type: 'text' },
  ])
  assert.throws(() => render(missingText), /paragraph.*prop:text.*Y\.Text/iu)

  const wrongText = basicDocument([
    { id: 'paragraph', flavour: 'affine:paragraph', type: 'text', text: 'valid' },
  ])
  wrongText.doc.getMap<Y.Map<unknown>>('blocks').get('paragraph')?.set('prop:text', 'invalid')
  assert.throws(() => render(wrongText), /paragraph.*prop:text.*Y\.Text/iu)

  const wrongChecked = basicDocument([
    { id: 'todo', flavour: 'affine:list', type: 'todo', checked: false, text: 'todo' },
  ])
  wrongChecked.doc.getMap<Y.Map<unknown>>('blocks').get('todo')?.set('prop:checked', 'yes')
  assert.throws(() => render(wrongChecked), /todo.*prop:checked.*boolean/iu)

  const wrongLanguage = basicDocument([
    { id: 'code', flavour: 'affine:code', language: 'typescript', text: 'code' },
  ])
  wrongLanguage.doc.getMap<Y.Map<unknown>>('blocks').get('code')?.set('prop:language', 42)
  assert.throws(() => render(wrongLanguage), /code.*prop:language.*string/iu)
})
