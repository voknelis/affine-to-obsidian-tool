import type { AffineDocument } from '../src/types.ts'
import assert from 'node:assert/strict'
import { it } from 'vitest'

import * as Y from 'yjs'
import { convertPage } from '../src/converters/index.ts'
import { buildPageRegistry } from '../src/page-registry.ts'

interface BlockSpec {
  id: string
  flavour: string
  children?: string[]
  text?: string
  title?: string
  type?: string
  props?: Record<string, unknown>
}

function fixture(specs: BlockSpec[], documentId = 'doc'): AffineDocument {
  const doc = new Y.Doc()
  const blocks = doc.getMap<unknown>('blocks')
  for (const spec of specs) {
    const block = new Y.Map<unknown>()
    block.set('sys:id', spec.id)
    block.set('sys:flavour', spec.flavour)
    const children = new Y.Array<string>()
    children.push(spec.children ?? [])
    block.set('sys:children', children)
    for (const [key, value] of Object.entries(spec.props ?? {})) {
      block.set(key, value)
    }
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
    blocks.set(spec.id, block)
  }
  return { id: documentId, doc, snapshotApplied: true, updateCount: 0 }
}

function pages(documentId = 'doc') {
  return buildPageRegistry({
    pages: [{ id: documentId, title: 'Document', tags: [], trash: false }],
    tags: [],
    blockVersions: {},
  })
}

function svgViewBox(svg: string) {
  const match = /viewBox="([^"]+)"/u.exec(svg)
  const value = match?.[1]
  assert.ok(value !== undefined)
  const [x, y, width, height] = value.split(' ').map(Number) as [number, number, number, number]
  return { x, y, width, height, right: x + width, bottom: y + height }
}

function surfaceDocument(
  elements: Record<string, unknown>,
  surfaceChildren: BlockSpec[] = [],
  extra: BlockSpec[] = [],
  ids: { documentId?: string, surfaceId?: string } = {},
): AffineDocument {
  const documentId = ids.documentId ?? 'doc'
  const surfaceId = ids.surfaceId ?? 'surface'
  const nested = new Set(surfaceChildren.flatMap(block => block.children ?? []))
  const children = surfaceChildren.filter(block => !nested.has(block.id))
  return fixture([
    { id: documentId, flavour: 'affine:page', title: 'Source', children: [surfaceId, ...extra.map(block => block.id)] },
    {
      id: surfaceId,
      flavour: 'affine:surface',
      children: children.map(block => block.id),
      props: { 'prop:elements': { type: '$blocksuite:internal:native$', value: elements } },
    },
    ...surfaceChildren,
    ...extra,
  ], documentId)
}

function canvasText(id: string, text: string, index: string, xywh = '[0,0,200,40]'): BlockSpec[] {
  return [
    {
      id,
      flavour: 'affine:edgeless-text',
      children: [`${id}-paragraph`],
      props: { 'prop:index': index, 'prop:xywh': xywh },
    },
    { id: `${id}-paragraph`, flavour: 'affine:paragraph', type: 'text', text },
  ]
}

const APPROVED_MISSING_GROUP_CHILD = {
  documentId: 'document-id',
  surfaceId: 'surface-id',
  groupId: 'group-id',
  childId: 'child-id',
} as const

function staleGroupFixture(overrides: { [K in keyof typeof APPROVED_MISSING_GROUP_CHILD]?: string } = {}) {
  const ids = { ...APPROVED_MISSING_GROUP_CHILD, ...overrides }
  const document = surfaceDocument({
    [ids.groupId]: { id: ids.groupId, type: 'group', children: { [ids.childId]: true } },
  }, [], [], ids)
  return { document, registry: pages(ids.documentId), ids }
}

function nativeTextDocument(initialize: (text: Y.Text) => void): AffineDocument {
  const document = surfaceDocument({})
  const surface = document.doc.getMap<Y.Map<unknown>>('blocks').get('surface')
  assert.ok(surface instanceof Y.Map)
  const wrapper = new Y.Map<unknown>()
  const elements = new Y.Map<unknown>()
  const label = new Y.Map<unknown>()
  label.set('id', 'label')
  label.set('type', 'text')
  label.set('xywh', '[0,0,200,40]')
  const text = new Y.Text()
  label.set('text', text)
  elements.set('label', label)
  wrapper.set('type', '$blocksuite:internal:native$')
  wrapper.set('value', elements)
  surface.set('prop:elements', wrapper)
  initialize(text)
  return document
}

it('orders edgeless-text blocks and exposes native surface text as stable Markdown sections', () => {
  const document = surfaceDocument(
    {
      native: { id: 'native', type: 'text', index: 'a1', xywh: '[0,0,300,50]', text: 'Native <canvas> & text', fontSize: 24 },
    },
    [...canvasText('later', 'Later', 'a2', '[0,100,200,40]'), ...canvasText('first', 'First', 'a1', '[0,50,200,40]')],
  )

  const result = convertPage(document, pages())
  assert.ok(!result.markdown.includes('Native &lt;canvas&gt; &amp; text'), 'Markdown is not XML-escaped')
  assert.ok(result.markdown.includes('Native \\<canvas\\> \\& text'))
  const firstPosition = result.markdown.indexOf('First')
  const laterPosition = result.markdown.indexOf('Later')
  assert.ok(firstPosition >= 0)
  assert.ok(laterPosition >= 0)
  assert.ok(firstPosition < laterPosition)
  assert.equal(result.diagrams.length, 1)
  assert.equal(result.diagrams[0]?.path, 'assets/diagrams/doc--surface.svg')
  assert.match(result.diagrams[0]?.contents ?? '', /Native &lt;canvas&gt; &amp; text/u)
  assert.match(result.markdown, /!\[\[assets\/diagrams\/doc--surface\.svg\]\]/u)
})

it('renders standalone edgeless text with geometry and accounts for its rich-text deltas', () => {
  const document = fixture([
    { id: 'doc', flavour: 'affine:page', title: 'Source', children: ['standalone', 'plain'] },
    {
      id: 'standalone',
      flavour: 'affine:edgeless-text',
      props: { 'prop:xywh': '[0,0,200,40]', 'prop:text': new Y.Text('Standalone **rich** text') },
    },
    {
      id: 'plain',
      flavour: 'affine:edgeless-text',
      props: { 'prop:xywh': '[0,50,200,40]', 'prop:text': 'Plain <text> & **literal**' },
    },
  ])

  const result = convertPage(document, pages())
  assert.match(result.markdown, /Standalone \\\*\\\*rich\\\*\\\* text/u)
  assert.match(result.markdown, /Plain \\<text\\> \\& \\\*\\\*literal\\\*\\\*/u)
  assert.deepEqual(result.diagrams, [])
  const deltas = result.coverage.items.filter(item => item.kind === 'rich-text-delta' && item.blockId === 'standalone')
  assert.equal(deltas.length, 1)
  assert.equal(deltas[0]?.disposition, 'rendered')
})

it('renders and accounts for native Y.Text group titles and text elements', () => {
  const document = surfaceDocument({})
  const surface = document.doc.getMap<Y.Map<unknown>>('blocks').get('surface')
  assert.ok(surface instanceof Y.Map)
  const wrapper = new Y.Map<unknown>()
  const elements = new Y.Map<unknown>()
  const group = new Y.Map<unknown>()
  const label = new Y.Map<unknown>()
  group.set('id', 'group')
  group.set('type', 'group')
  group.set('children', { label: true })
  group.set('title', new Y.Text('Rich group'))
  label.set('id', 'label')
  label.set('type', 'text')
  label.set('xywh', '[0,0,200,40]')
  label.set('text', new Y.Text('Rich native text'))
  elements.set('group', group)
  elements.set('label', label)
  wrapper.set('type', '$blocksuite:internal:native$')
  wrapper.set('value', elements)
  surface.set('prop:elements', wrapper)

  const result = convertPage(document, pages())
  assert.match(result.diagrams[0]?.contents ?? '', /<title>Rich group<\/title>/u)
  assert.match(result.diagrams[0]?.contents ?? '', /Rich native text/u)
  assert.match(result.markdown, /### Canvas text\n\nRich native text/u)
  const nativeDeltas = result.coverage.items.filter(item => item.kind === 'rich-text-delta' && item.blockId === 'surface')
  assert.equal(nativeDeltas.length, 2)
  assert.ok(nativeDeltas.every(item => item.disposition === 'rendered'))
})

it('renders shapes, nested groups, connectors, and text into deterministic self-contained SVG', () => {
  const elements: Record<string, unknown> = {
    connector: {
      id: 'connector',
      type: 'connector',
      index: 'a3',
      source: { id: 'shape', position: [1, 0.5] },
      target: { id: 'other' },
      stroke: '#336699',
      strokeWidth: 2,
      rearEndpointStyle: 'Arrow',
    },
    group: { id: 'group', type: 'group', index: 'a2', title: 'A <group> & friends', children: { shape: true, label: true } },
    label: { id: 'label', type: 'text', index: 'a2', xywh: '[10,10,80,30]', text: '5 < 6 & 7 > 4', fontSize: 16 },
    shape: {
      id: 'shape',
      type: 'shape',
      index: 'a1',
      shapeType: 'rect',
      xywh: '[0,0,100,80]',
      radius: 4,
      fillColor: '#ffffff',
      strokeColor: '#000000',
      strokeWidth: 2,
    },
    other: { id: 'other', type: 'shape', index: 'a4', shapeType: 'ellipse', xywh: '[200,0,80,80]' },
  }
  const first = convertPage(surfaceDocument(elements), pages())
  const reversed = Object.fromEntries(Object.entries(elements).reverse())
  const second = convertPage(surfaceDocument(reversed), pages())
  const svg = first.diagrams[0]?.contents ?? ''

  assert.equal(svg, second.diagrams[0]?.contents)
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/u)
  assert.match(svg, /<rect[^>]+width="100"[^>]+height="80"/u)
  assert.match(svg, /<ellipse[^>]+cx="240"[^>]+cy="40"/u)
  assert.match(svg, /<g id="group">/u)
  assert.match(svg, /<path[^>]+marker-end="url\(#arrow\)"/u)
  assert.match(svg, /5 &lt; 6 &amp; 7 &gt; 4/u)
  assert.match(svg, /A &lt;group&gt; &amp; friends/u)
  assert.doesNotMatch(svg, /<script|href\s*=|https?:\/\/(?!www\.w3\.org)/u)
})

it('resolves connector geometry from document blocks outside the surface', () => {
  const document = surfaceDocument({
    connector: {
      id: 'connector',
      type: 'connector',
      source: { x: 0, y: 0 },
      target: { id: 'note' },
    },
  }, [], [{
    id: 'note',
    flavour: 'affine:note',
    props: { 'prop:xywh': '[100,100,200,80]' },
  }])

  const result = convertPage(document, pages())
  const svg = result.diagrams[0]?.contents ?? ''
  assert.match(svg, /<path d="M 0 0 L 200 140"/u)
  assert.match(svg, /viewBox="-18 -18 236 176"/u)
})

it('bounds SVGs only to the current surface while retaining its rendered children', () => {
  const document = fixture([
    { id: 'doc', flavour: 'affine:page', title: 'Source', children: ['surface', 'other-surface', 'standalone'] },
    {
      id: 'surface',
      flavour: 'affine:surface',
      children: ['current-text'],
      props: {
        'prop:elements': {
          type: '$blocksuite:internal:native$',
          value: {
            group: { id: 'group', type: 'group', xywh: '[5000,5000,100,100]', children: { shape: true } },
            shape: { id: 'shape', type: 'shape', shapeType: 'rect', xywh: '[0,0,100,80]' },
          },
        },
      },
    },
    {
      id: 'current-text',
      flavour: 'affine:edgeless-text',
      props: { 'prop:xywh': '[200,0,50,20]', 'prop:text': 'Current' },
    },
    {
      id: 'other-surface',
      flavour: 'affine:surface',
      children: ['other-text'],
      props: { 'prop:elements': { type: '$blocksuite:internal:native$', value: {} } },
    },
    {
      id: 'other-text',
      flavour: 'affine:edgeless-text',
      props: { 'prop:xywh': '[10000,10000,500,500]', 'prop:text': 'Other surface' },
    },
    {
      id: 'standalone',
      flavour: 'affine:edgeless-text',
      props: { 'prop:xywh': '[-10000,-10000,500,500]', 'prop:text': 'Standalone' },
    },
  ])

  const result = convertPage(document, pages())
  const diagram = result.diagrams.find(candidate => candidate.path === 'assets/diagrams/doc--surface.svg')
  assert.match(diagram?.contents ?? '', /viewBox="-16.5 -16.5 344.5 113" width="344.5" height="113"/u)
  assert.match(diagram?.contents ?? '', />Current<\/tspan>/u)
})

it('renders named frame sections and resolves surface references to their owning diagram', () => {
  const frameChildren = canvasText('inside', 'Frame text', 'a1', '[20,40,100,30]')
  const document = surfaceDocument({
    decoration: { id: 'decoration', type: 'shape', shapeType: 'rect', xywh: '[250,0,40,40]' },
  }, [
    {
      id: 'frame',
      flavour: 'affine:frame',
      props: {
        'prop:title': new Y.Text('Frame <one>'),
        'prop:xywh': '[0,0,300,200]',
        'prop:childElementIds': { inside: true, decoration: true },
      },
    },
    ...frameChildren,
  ], [
    {
      id: 'reference',
      flavour: 'affine:surface-ref',
      props: { 'prop:reference': 'frame', 'prop:refFlavour': 'affine:frame', 'prop:caption': 'Overview' },
    },
  ])

  const result = convertPage(document, pages())
  assert.match(result.markdown, /## Frame \\<one\\>/u)
  assert.match(result.markdown, /Frame text/u)
  assert.equal(result.markdown.match(/!\[\[assets\/diagrams\/doc--surface\.svg(?:\|Overview)?\]\]/gu)?.length, 2)
  assert.equal(result.diagrams.length, 1)
  assert.match(result.diagrams[0]?.contents ?? '', /Frame &lt;one&gt;/u)
})

it('links geometry-less referenced text without embedding a nonexistent diagram', () => {
  const document = surfaceDocument({}, [{
    id: 'text',
    flavour: 'affine:edgeless-text',
    props: { 'prop:index': 'a1', 'prop:text': new Y.Text('Geometry-less referenced text') },
  }], [{
    id: 'reference',
    flavour: 'affine:surface-ref',
    props: {
      'prop:reference': 'text',
      'prop:refFlavour': 'affine:edgeless-text',
      'prop:caption': 'Referenced canvas text',
    },
  }])

  const result = convertPage(document, pages())
  assert.deepEqual(result.diagrams, [])
  assert.match(result.markdown, /Geometry\\-less referenced text/u)
  assert.match(result.markdown, /\[\[Document\|Referenced canvas text\]\]/u)
  assert.doesNotMatch(result.markdown, /assets\/diagrams|\.svg/u)
  const delta = result.coverage.items.find(item => item.kind === 'rich-text-delta' && item.blockId === 'text')
  assert.equal(delta?.disposition, 'rendered')
})

it('omits output for empty surfaces', () => {
  const result = convertPage(surfaceDocument({}), pages())
  assert.equal(result.markdown, '---\ntitle: "Document"\naffine_id: "doc"\ntrash: false\ntags: []\n---\n\n# Document\n')
  assert.deepEqual(result.diagrams, [])
})

it('treats an all-zero block geometry as absent canvas metadata', () => {
  const document = surfaceDocument({}, [], [{
    id: 'note',
    flavour: 'affine:note',
    props: { 'prop:xywh': '[0,0,0,0]' },
  }])

  const result = convertPage(document, pages())
  assert.deepEqual(result.diagrams, [])
})

it('rejects invalid geometry, missing targets, and unknown native element types', () => {
  for (const xywh of ['[0,0,20]', '[0,0,-1,20]', '[0,0,NaN,20]', 'not geometry']) {
    assert.throws(
      () => convertPage(surfaceDocument({ shape: { id: 'shape', type: 'shape', shapeType: 'rect', xywh } }), pages()),
      /geometry|xywh|finite|positive/iu,
      xywh,
    )
  }
  assert.throws(
    () => convertPage(surfaceDocument({
      connector: { id: 'connector', type: 'connector', source: { id: 'missing' }, target: { x: 1, y: 1 } },
    }), pages()),
    /connector.*missing|missing.*connector/iu,
  )
  assert.throws(
    () => convertPage(surfaceDocument({ mystery: { id: 'mystery', type: 'mystery' } }), pages()),
    /element type.*mystery/iu,
  )

  const missingReference = surfaceDocument({}, [], [{
    id: 'reference',
    flavour: 'affine:surface-ref',
    props: { 'prop:reference': 'absent', 'prop:refFlavour': 'affine:frame' },
  }])
  assert.throws(() => convertPage(missingReference, pages()), /reference.*absent|absent.*reference/iu)
})

it('rejects inherited object keys as palette colors', () => {
  for (const color of ['constructor', 'toString', '__proto__']) {
    assert.throws(() => convertPage(surfaceDocument({
      item: { id: 'item', type: 'shape', shapeType: 'rect', xywh: '[0,0,100,40]', fillColor: color },
    }), pages()), /fillColor.*unsupported.*color/iu)
  }
})

it('sorts edgeless indices by code units rather than locale collation', () => {
  const result = convertPage(surfaceDocument({
    lower: { id: 'lower', type: 'text', index: 'a', xywh: '[0,50,100,40]', text: 'Lower' },
    upper: { id: 'upper', type: 'text', index: 'Z', xywh: '[0,0,100,40]', text: 'Upper' },
  }), pages())
  const svg = result.diagrams[0]?.contents ?? ''
  const upperPosition = svg.indexOf('>Upper<')
  const lowerPosition = svg.indexOf('>Lower<')
  assert.ok(upperPosition >= 0)
  assert.ok(lowerPosition >= 0)
  assert.ok(upperPosition < lowerPosition)
})

it('rejects unsupported nonempty edgeless colors instead of substituting black or white', () => {
  const cases: Array<{ element: Record<string, unknown>, property: string }> = [
    {
      property: 'fillColor',
      element: { id: 'item', type: 'shape', shapeType: 'rect', xywh: '[0,0,100,40]' },
    },
    {
      property: 'strokeColor',
      element: { id: 'item', type: 'shape', shapeType: 'rect', xywh: '[0,0,100,40]' },
    },
    {
      property: 'color',
      element: { id: 'item', type: 'shape', shapeType: 'rect', xywh: '[0,0,100,40]', text: 'Text' },
    },
    {
      property: 'color',
      element: { id: 'item', type: 'text', xywh: '[0,0,100,40]', text: 'Text' },
    },
    {
      property: 'stroke',
      element: { id: 'item', type: 'connector', source: { x: 0, y: 0 }, target: { x: 10, y: 10 } },
    },
  ]
  for (const { element, property } of cases) {
    for (const value of ['--affine-palette-new', 'hsl(120 50% 50%)', '#12', '#12345', 'rgb(,,,)', 'rgba(0,0,0)', 42]) {
      assert.throws(
        () => convertPage(surfaceDocument({ item: { ...element, [property]: value } }), pages()),
        new RegExp(`${property}.*unsupported.*color`, 'iu'),
        `${property}=${String(value)}`,
      )
    }
  }
  assert.throws(() => convertPage(surfaceDocument({}, [
    {
      id: 'text',
      flavour: 'affine:edgeless-text',
      children: ['paragraph'],
      props: { 'prop:xywh': '[0,0,100,40]', 'prop:color': 'var(--future-color)' },
    },
    { id: 'paragraph', flavour: 'affine:paragraph', type: 'text', text: 'Text' },
  ]), pages()), /prop:color.*unsupported.*color/iu)
})

it('preserves supported literal hex and legacy RGB edgeless colors', () => {
  const result = convertPage(surfaceDocument({
    shape: {
      id: 'shape',
      type: 'shape',
      shapeType: 'rect',
      xywh: '[0,0,100,40]',
      fillColor: 'rgb(1, 2, 3)',
      strokeColor: 'rgba(0, 0, 0, 0.5)',
    },
    text: { id: 'text', type: 'text', xywh: '[0,50,100,40]', text: 'Text', color: '#abcd' },
  }), pages())
  const svg = result.diagrams[0]?.contents ?? ''
  assert.match(svg, /fill="rgb\(1, 2, 3\)" stroke="rgba\(0, 0, 0, 0.5\)"/u)
  assert.match(svg, /fill="#abcd"/u)
})

it('retains explicit defaults for absent and empty edgeless colors', () => {
  const result = convertPage(surfaceDocument({
    shape: { id: 'shape', type: 'shape', shapeType: 'rect', xywh: '[0,0,100,40]', fillColor: '', strokeColor: '' },
  }), pages())
  assert.match(result.diagrams[0]?.contents ?? '', /fill="#ffffff" stroke="#000000"/u)
})

it('rejects group cycles and unsafe references', () => {
  assert.throws(() => convertPage(surfaceDocument({
    a: { id: 'a', type: 'group', children: { b: true } },
    b: { id: 'b', type: 'group', children: { a: true } },
  }), pages()), /cycle/iu)

  const wrongTarget = surfaceDocument({}, [...canvasText('text', 'Text', 'a1')], [{
    id: 'reference',
    flavour: 'affine:surface-ref',
    props: { 'prop:reference': 'text', 'prop:refFlavour': 'affine:frame' },
  }])
  assert.throws(() => convertPage(wrongTarget, pages()), /refFlavour|target.*flavour/iu)
})

it('accepts a stale native group child only when its exact tuple is allowed', () => {
  const { document, registry, ids } = staleGroupFixture()
  assert.throws(() => convertPage(document, registry), /group.*missing child/iu)
  const result = convertPage(document, registry, { allowMissingGroupChildren: [ids] })
  assert.deepEqual(result.warnings, [{
    kind: 'edgeless-missing-group-child',
    documentId: ids.documentId,
    blockId: ids.surfaceId,
    groupId: ids.groupId,
    childId: ids.childId,
    reason: 'The source group references a non-existent element; all existing elements are retained.',
  }])
})

it('rejects a stale group child with a different document ID', () => {
  const { document, registry } = staleGroupFixture({ documentId: 'different-document' })
  assert.throws(() => convertPage(document, registry, { allowMissingGroupChildren: [APPROVED_MISSING_GROUP_CHILD] }), /group.*missing child/iu)
})

it('rejects a stale group child with a different surface ID', () => {
  const { document, registry } = staleGroupFixture({ surfaceId: 'different-surface' })
  assert.throws(() => convertPage(document, registry, { allowMissingGroupChildren: [APPROVED_MISSING_GROUP_CHILD] }), /group.*missing child/iu)
})

it('rejects a stale group child with a different group ID', () => {
  const { document, registry } = staleGroupFixture({ groupId: 'different-group' })
  assert.throws(() => convertPage(document, registry, { allowMissingGroupChildren: [APPROVED_MISSING_GROUP_CHILD] }), /group.*missing child/iu)
})

it('rejects a stale group child with a different child ID', () => {
  const { document, registry } = staleGroupFixture({ childId: 'different-child' })
  assert.throws(() => convertPage(document, registry, { allowMissingGroupChildren: [APPROVED_MISSING_GROUP_CHILD] }), /group.*missing child/iu)
})

it('rejects rich-text attributes and non-string deltas in native SVG text', () => {
  assert.throws(() => convertPage(nativeTextDocument((text) => {
    text.insert(0, 'formatted')
    text.format(0, text.length, { bold: true })
  }), pages()), /plain text.*rich-text attributes/iu)

  assert.throws(() => convertPage(nativeTextDocument((text) => {
    text.insertEmbed(0, { unsupported: true })
  }), pages()), /delta insert must be a string/iu)
})

it('rejects formatted Y.Text flattened from edgeless block children', () => {
  const document = surfaceDocument({}, canvasText('canvas', 'formatted', 'a1'))
  const paragraph = document.doc.getMap<Y.Map<unknown>>('blocks').get('canvas-paragraph')
  assert.ok(paragraph instanceof Y.Map)
  const text = paragraph.get('prop:text')
  assert.ok(text instanceof Y.Text)
  text.format(0, text.length, { italic: true })
  assert.throws(() => convertPage(document, pages()), /plain text.*rich-text attributes/iu)
})

it('rejects unsupported native text property value types', () => {
  for (const value of [null, false, 42, { text: 'nested' }]) {
    assert.throws(() => convertPage(surfaceDocument({
      label: { id: 'label', type: 'text', xywh: '[0,0,200,40]', text: value },
    }), pages()), /text.*must be a string or Y.Text/iu, JSON.stringify(value))
  }
})

it('rejects existing and nonexistent frame sys:children references', () => {
  for (const childId of ['paragraph', 'absent']) {
    const children: BlockSpec[] = [{
      id: 'frame',
      flavour: 'affine:frame',
      children: [childId],
      props: { 'prop:title': new Y.Text('Frame'), 'prop:xywh': '[0,0,100,100]' },
    }]
    if (childId === 'paragraph') {
      children.push({ id: childId, flavour: 'affine:paragraph', type: 'text', text: 'Child' })
    }
    assert.throws(() => convertPage(surfaceDocument({}, children), pages()), /frame sys:children must be empty/iu, childId)
  }
})

it('requires positive font sizes and stroke widths and nonnegative radii', () => {
  const cases = [
    { key: 'fontSize', value: 0, element: { id: 'item', type: 'text', xywh: '[0,0,100,40]', text: 'Text' } },
    { key: 'fontSize', value: -1, element: { id: 'item', type: 'text', xywh: '[0,0,100,40]', text: 'Text' } },
    { key: 'strokeWidth', value: 0, element: { id: 'item', type: 'shape', shapeType: 'rect', xywh: '[0,0,100,40]' } },
    { key: 'strokeWidth', value: -1, element: { id: 'item', type: 'shape', shapeType: 'rect', xywh: '[0,0,100,40]' } },
    { key: 'radius', value: -1, element: { id: 'item', type: 'shape', shapeType: 'rect', xywh: '[0,0,100,40]' } },
  ]
  for (const { key, value, element } of cases) {
    assert.throws(() => convertPage(surfaceDocument({
      item: { ...element, [key]: value },
    }), pages()), new RegExp(`${key}.*must be (?:positive|nonnegative)`, 'iu'), `${key}=${value}`)
  }

  const zeroRadius = convertPage(surfaceDocument({
    item: { id: 'item', type: 'shape', shapeType: 'rect', xywh: '[0,0,100,40]', radius: 0 },
  }), pages())
  assert.match(zeroRadius.diagrams[0]?.contents ?? '', /rx="0"/u)
})

it('rejects arithmetic overflow in derived SVG geometry', () => {
  assert.throws(() => convertPage(surfaceDocument({
    item: { id: 'item', type: 'shape', shapeType: 'rect', xywh: '[1e308,0,1e308,40]' },
  }), pages()), /non-finite derived SVG geometry/iu)
})

it('rejects XML-invalid controls and unpaired surrogates in SVG text', () => {
  for (const value of ['NUL\0text', 'controltext', 'unpaired\uD800text', 'invalid\uFFFEtext']) {
    assert.throws(() => convertPage(surfaceDocument({
      label: { id: 'label', type: 'text', xywh: '[0,0,200,40]', text: value },
    }), pages()), /XML-invalid.*control character.*unpaired surrogate/iu)
  }
})

it('preserves valid astral Unicode while escaping generated SVG', () => {
  const result = convertPage(surfaceDocument({
    label: { id: 'label', type: 'text', xywh: '[0,0,200,40]', text: 'Valid 😀 & <text>' },
  }), pages())
  assert.match(result.diagrams[0]?.contents ?? '', /Valid 😀 &amp; &lt;text&gt;/u)
})

it('preserves adjacent list runs when rendering ordered surface children', () => {
  const document = surfaceDocument({}, [
    { id: 'second', flavour: 'affine:list', type: 'numbered', text: 'Second', props: { 'prop:index': 'a2' } },
    {
      id: 'svg-only',
      flavour: 'affine:edgeless-text',
      props: { 'prop:index': 'a15', 'prop:xywh': '[0,50,20,20]' },
    },
    { id: 'first', flavour: 'affine:list', type: 'numbered', text: 'First', props: { 'prop:index': 'a1' } },
  ])

  const result = convertPage(document, pages())

  assert.match(result.markdown, /1\. First\n1\. Second/u)
  assert.doesNotMatch(result.markdown, /1\. First\n\n1\. Second/u)
})

it('keeps plain string frame titles on one Markdown line', () => {
  const document = surfaceDocument({}, [{
    id: 'frame',
    flavour: 'affine:frame',
    props: {
      'prop:title': 'First\nSecond',
      'prop:xywh': '[0,0,100,100]',
    },
  }])

  const result = convertPage(document, pages())

  assert.match(result.markdown, /## First Second/u)
  assert.doesNotMatch(result.markdown, /## First\nSecond/u)
})

it('rejects frame native IDs owned by another surface', () => {
  const document = fixture([
    { id: 'doc', flavour: 'affine:page', title: 'Source', children: ['surface', 'other-surface'] },
    {
      id: 'surface',
      flavour: 'affine:surface',
      children: ['frame'],
      props: { 'prop:elements': { type: '$blocksuite:internal:native$', value: {} } },
    },
    {
      id: 'other-surface',
      flavour: 'affine:surface',
      props: {
        'prop:elements': {
          type: '$blocksuite:internal:native$',
          value: {
            native: { id: 'native', type: 'shape', shapeType: 'rect', xywh: '[0,0,10,10]' },
          },
        },
      },
    },
    {
      id: 'frame',
      flavour: 'affine:frame',
      props: {
        'prop:title': 'Frame',
        'prop:childElementIds': { native: true },
      },
    },
  ])

  assert.throws(() => convertPage(document, pages()), /frame child native is missing/iu)
})

it('rejects native elements owned by multiple groups', () => {
  const document = surfaceDocument({
    first: { id: 'first', type: 'group', children: { shape: true } },
    second: { id: 'second', type: 'group', children: { shape: true } },
    shape: { id: 'shape', type: 'shape', shapeType: 'rect', xywh: '[0,0,10,10]' },
  })

  assert.throws(
    () => convertPage(document, pages()),
    /native element shape belongs to multiple groups first and second/iu,
  )
})

it('bounds wide shape strokes by their painted extent plus the SVG margin', () => {
  const result = convertPage(surfaceDocument({
    shape: {
      id: 'shape',
      type: 'shape',
      shapeType: 'rect',
      xywh: '[0,0,100,80]',
      strokeWidth: 80,
    },
  }), pages())

  const box = svgViewBox(result.diagrams[0]?.contents ?? '')
  assert.deepEqual(box, { x: -56, y: -56, width: 212, height: 192, right: 156, bottom: 136 })
})

it('bounds long multiline native text for every supported alignment', () => {
  const longLine = 'abcdefghijklmnopqrst'
  const cases = [
    ['start', 100, 500],
    ['center', -90, 310],
    ['right', -280, 120],
  ] as const
  for (const [textAlign, paintedLeft, paintedRight] of cases) {
    const result = convertPage(surfaceDocument({
      label: {
        id: 'label',
        type: 'text',
        xywh: '[100,100,20,20]',
        text: `Tiny\n${longLine}`,
        fontSize: 20,
        textAlign,
      },
    }), pages())

    const box = svgViewBox(result.diagrams[0]?.contents ?? '')
    assert.equal(box.x, paintedLeft - 16, textAlign)
    assert.equal(box.right, paintedRight + 16, textAlign)
    assert.equal(box.y, 84, textAlign)
    assert.equal(box.bottom, 180, textAlign)
  }
})

it('bounds connector arrow markers beyond wide strokes and the fixed margin', () => {
  const result = convertPage(surfaceDocument({
    connector: {
      id: 'connector',
      type: 'connector',
      source: { x: 0, y: 0 },
      target: { x: 100, y: 0 },
      strokeWidth: 10,
      frontEndpointStyle: 'Arrow',
      rearEndpointStyle: 'Arrow',
    },
  }), pages())

  const box = svgViewBox(result.diagrams[0]?.contents ?? '')
  assert.ok(box.x < -60)
  assert.ok(box.y < -60)
  assert.ok(box.right > 160)
  assert.ok(box.bottom > 60)
})

it('rejects non-finite painted bounds instead of emitting an invalid viewBox', () => {
  assert.throws(() => convertPage(surfaceDocument({
    shape: {
      id: 'shape',
      type: 'shape',
      shapeType: 'rect',
      xywh: `[0,0,${Number.MAX_VALUE},10]`,
      strokeWidth: Number.MAX_VALUE,
    },
  }), pages()), /non-finite derived SVG geometry/iu)
})
