import type { AffineBlock, BlockConversionContext, ConversionWarning, ConvertedBlock, DiagramAsset, RenderBlockSequence } from './types.ts'

import type { RecordValue } from './yjs.ts'
import * as Y from 'yjs'
import {
  escapeMarkdownInlineText,
  escapeMarkdownText,
  escapeWikilinkAlias,
  escapeWikilinkTarget,
} from '../markdown.ts'
import { allowsMissingGroupChild } from '../migration-policy.ts'
import { compareCodeUnits, sanitizeFilename } from '../paths.ts'
import { renderRichText } from '../richtext.ts'
import {

  BlockConversionError,

} from './types.ts'
import { mapValue, record, textDeltas } from './yjs.ts'

interface Point {
  readonly x: number
  readonly y: number
}

interface Geometry {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

interface PaintedSvg {
  readonly contents: string
  readonly bounds: readonly Geometry[]
}

type TextAnchor = 'start' | 'middle' | 'end'

function expandGeometry(box: Geometry, amount: number): Geometry {
  return {
    x: box.x - amount,
    y: box.y - amount,
    width: box.width + amount * 2,
    height: box.height + amount * 2,
  }
}

function pointGeometry(point: Point, radius: number): Geometry {
  return { x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2 }
}

interface NativeElement {
  readonly id: string
  readonly type: string
  readonly index: string
  readonly value: RecordValue
  readonly source?: Y.Map<unknown>
}

const PALETTE: Readonly<Record<string, string>> = {
  '--affine-palette-line-black': '#000000',
  '--affine-palette-line-grey': '#777777',
  '--affine-palette-transparent': 'transparent',
  '--affine-palette-shape-blue': '#c8d9eb',
  '--affine-palette-shape-magenta': '#e8c4d8',
  '--affine-palette-shape-purple': '#d7cce8',
  '--affine-palette-shape-tangerine': '#f4d2b5',
  '--affine-palette-shape-white': '#ffffff',
  '--affine-palette-shape-yellow': '#f4e7b2',
  '--affine-palette-line-yellow': '#b89b24',
}

function fail(block: AffineBlock, message: string): never {
  throw new BlockConversionError(`AFFiNE block ${block.id} (${block.flavour}) ${message}`)
}

function numberValue(value: unknown, block: AffineBlock, description: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(block, `${description} must be a finite number.`)
  }
  return value
}

function geometry(value: unknown, block: AffineBlock, description = 'geometry'): Geometry {
  if (typeof value !== 'string') {
    fail(block, `${description} prop:xywh must be a JSON string.`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  }
  catch {
    fail(block, `has invalid ${description} prop:xywh JSON.`)
  }
  if (!Array.isArray(parsed) || parsed.length !== 4) {
    fail(block, `${description} prop:xywh must contain four finite numbers.`)
  }
  const [x, y, width, height] = parsed.map(entry => numberValue(entry, block, description))
  if (width === undefined || height === undefined || x === undefined || y === undefined) {
    fail(block, `${description} prop:xywh must contain four finite numbers.`)
  }
  if (width <= 0 || height <= 0) {
    fail(block, `${description} dimensions must be positive.`)
  }
  return { x, y, width, height }
}

function optionalGeometry(block: AffineBlock): Geometry | undefined {
  const value = mapValue(block.source, 'prop:xywh')
  if (value === undefined || (typeof value === 'string' && /^\[\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\]$/u.test(value))) {
    return undefined
  }
  return geometry(value, block)
}

function indexOf(value: RecordValue): string {
  const index = value.index
  if (index !== undefined && typeof index !== 'string') {
    throw new BlockConversionError('AFFiNE surface element index must be a string.')
  }
  return index ?? ''
}

function compareIndexed(left: { id: string, index: string }, right: { id: string, index: string }): number {
  return compareCodeUnits(left.index, right.index) || compareCodeUnits(left.id, right.id)
}

function blockIndex(block: AffineBlock): { id: string, index: string } {
  const index = mapValue(block.source, 'prop:index')
  if (index !== undefined && typeof index !== 'string') {
    fail(block, 'property prop:index must be a string.')
  }
  return { id: block.id, index: index ?? '' }
}

function parseNativeElement(
  block: AffineBlock,
  rawValues: unknown,
  key: string,
  raw: unknown,
): NativeElement {
  const value = record(raw)
  const source = rawValues instanceof Y.Map ? mapValue(rawValues, key) : undefined
  if (rawValues instanceof Y.Map && !(source instanceof Y.Map)) {
    fail(block, `native element ${key} must be a Y.Map.`)
  }
  if (value === undefined) {
    fail(block, `native element ${key} must be an object.`)
  }
  if (value.id !== key || typeof value.id !== 'string' || value.id.length === 0) {
    fail(block, `native element ${key} has an invalid id.`)
  }
  if (typeof value.type !== 'string' || value.type.length === 0) {
    fail(block, `native element ${key} has an invalid type.`)
  }
  if (!['group', 'shape', 'text', 'connector'].includes(value.type)) {
    fail(block, `has unknown native element type "${value.type}" in element ${key}.`)
  }
  return {
    id: key,
    type: value.type,
    index: indexOf(value),
    value,
    ...source instanceof Y.Map ? { source } : {},
  }
}

function nativeElements(block: AffineBlock): NativeElement[] {
  const rawWrapper = mapValue(block.source, 'prop:elements')
  const rawValues = rawWrapper instanceof Y.Map ? mapValue(rawWrapper, 'value') : undefined
  const wrapper = record(rawWrapper)
  if (wrapper === undefined) {
    fail(block, 'property prop:elements must be a native value wrapper.')
  }
  if (wrapper.type !== '$blocksuite:internal:native$') {
    fail(block, 'property prop:elements has an unsupported wrapper type.')
  }
  const values = record(wrapper.value)
  if (values === undefined) {
    fail(block, 'property prop:elements.value must be an object.')
  }
  return Object.entries(values)
    .map(([key, raw]) => parseNativeElement(block, rawValues, key, raw))
    .sort(compareIndexed)
}

function nativeProperty(element: NativeElement, property: string): unknown {
  return element.source?.has(property) === true ? mapValue(element.source, property) : element.value[property]
}

function svgText(
  value: unknown,
  block: AffineBlock,
  context: BlockConversionContext,
  description: string,
  account = true,
): string {
  if (value === undefined) {
    return ''
  }
  if (typeof value === 'string') {
    return value
  }
  if (!(value instanceof Y.Text)) {
    fail(block, `${description} must be a string or Y.Text.`)
  }
  const deltas = textDeltas(value)
  const inserts: string[] = []
  for (const delta of deltas) {
    if (typeof delta.insert !== 'string') {
      fail(block, `${description} rich-text delta insert must be a string.`)
    }
    inserts.push(delta.insert)
    if (delta.attributes !== undefined && Object.keys(delta.attributes).length > 0) {
      fail(block, `${description} supports only plain text in SVG; rich-text attributes are not supported.`)
    }
  }
  if (account) {
    for (const [deltaIndex] of deltas.entries()) {
      context.coverage?.recordRichTextDelta(value, deltaIndex, 'rendered')
    }
  }
  return inserts.join('')
}

function xml(value: string): string {
  // eslint-disable-next-line no-control-regex -- XML sanitization intentionally rejects control characters.
  if (/[\u0000-\u0008\v\f\u000E-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/u.test(value)) {
    throw new BlockConversionError('Cannot render an XML-invalid control character or unpaired surrogate in SVG.')
  }
  return value.replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      default: return '&apos;'
    }
  })
}

function svgNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new BlockConversionError('Cannot render non-finite derived SVG geometry.')
  }
  const rounded = Math.abs(value) < 0.0005 ? 0 : Number(value.toFixed(3))
  return String(rounded)
}

function color(value: unknown, fallback: string, block: AffineBlock, description: string): string {
  if (value === undefined || value === '') {
    return fallback
  }
  if (typeof value === 'string') {
    const palette = Object.hasOwn(PALETTE, value) ? PALETTE[value] : undefined
    if (palette !== undefined) {
      return palette
    }
    if (/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu.test(value)
      || /^rgb\(\s*\d{1,3}(?:\.\d+)?%?\s*,\s*\d{1,3}(?:\.\d+)?%?\s*,\s*\d{1,3}(?:\.\d+)?%?\s*\)$/iu.test(value)
      || /^rgba\(\s*\d{1,3}(?:\.\d+)?%?\s*,\s*\d{1,3}(?:\.\d+)?%?\s*,\s*\d{1,3}(?:\.\d+)?%?\s*,\s*(?:\d+(?:\.\d+)?|\.\d+)%?\s*\)$/iu.test(value)) {
      return value
    }
  }
  fail(block, `${description} has an unsupported nonempty color value.`)
}

function positiveProperty(value: RecordValue, key: string, fallback: number, block: AffineBlock): number {
  const raw = value[key]
  const result = raw === undefined ? fallback : numberValue(raw, block, `element ${String(value.id)} ${key}`)
  if (result <= 0) {
    fail(block, `element ${String(value.id)} ${key} must be positive.`)
  }
  return result
}

function nonnegativeProperty(value: RecordValue, key: string, fallback: number, block: AffineBlock): number {
  const raw = value[key]
  const result = raw === undefined ? fallback : numberValue(raw, block, `element ${String(value.id)} ${key}`)
  if (result < 0) {
    fail(block, `element ${String(value.id)} ${key} must be nonnegative.`)
  }
  return result
}

function textTag(
  text: string,
  x: number,
  y: number,
  size: number,
  fill: string,
  anchor: TextAnchor = 'start',
): string {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n')
  const tspans = lines.map((line, index) =>
    `<tspan x="${svgNumber(x)}"${index === 0 ? '' : ` dy="${svgNumber(size * 1.2)}"`}>${xml(line)}</tspan>`).join('')
  return `<text x="${svgNumber(x)}" y="${svgNumber(y)}" font-family="sans-serif" font-size="${svgNumber(size)}" fill="${xml(fill)}" text-anchor="${anchor}">${tspans}</text>`
}

function textPaintedBounds(
  text: string,
  x: number,
  y: number,
  size: number,
  anchor: TextAnchor = 'start',
): Geometry {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n')
  const maxLineLength = lines.reduce((longest, line) => Math.max(longest, line.length), 0)
  const width = maxLineLength * size
  const left = anchor === 'middle' ? x - width / 2 : anchor === 'end' ? x - width : x
  const top = y - size
  const lastBaseline = y + (lines.length - 1) * size * 1.2
  return { x: left, y: top, width, height: lastBaseline - top + size }
}

function plainBlockText(block: AffineBlock, context: BlockConversionContext, active = new Set<string>()): string {
  if (active.has(block.id)) {
    fail(block, 'has a cycle while reading canvas text.')
  }
  const accountOwnText = active.size === 0
  active.add(block.id)
  const own = block.source.get('prop:text')
  const parts: string[] = []
  if (own !== undefined) {
    parts.push(svgText(own, block, context, 'property prop:text', accountOwnText))
  }
  for (const id of block.children) {
    const child = context.blocks.get(id)
    if (child === undefined) {
      fail(block, `references missing child ${id}.`)
    }
    parts.push(plainBlockText(child, context, active))
  }
  active.delete(block.id)
  return parts.filter(part => part.length > 0).join('\n')
}

function frameChildIds(block: AffineBlock): string[] {
  const value = block.source.get('prop:childElementIds')
  if (value === undefined) {
    return []
  }
  const children = record(value)
  if (children === undefined) {
    fail(block, 'property prop:childElementIds must be an object.')
  }
  return Object.entries(children).map(([id, included]) => {
    if (included !== true) {
      fail(block, `childElementIds entry ${id} must be true.`)
    }
    return id
  }).sort()
}

interface SurfaceFrameMembership {
  readonly frameIds: ReadonlySet<string>
  readonly framedChildIds: ReadonlySet<string>
}

function surfaceFrameMembership(
  surface: AffineBlock,
  context: BlockConversionContext,
): SurfaceFrameMembership {
  const frameIds = new Set<string>()
  const framedChildIds = new Set<string>()
  for (const id of surface.children) {
    const child = context.blocks.get(id)
    if (child?.flavour !== 'affine:frame') {
      continue
    }
    frameIds.add(id)
    for (const childId of frameChildIds(child)) {
      framedChildIds.add(childId)
    }
  }
  return { frameIds, framedChildIds }
}

function surfaceRendersBlockText(block: AffineBlock, context: BlockConversionContext): boolean {
  if (optionalGeometry(block) === undefined) {
    return false
  }
  for (const surface of context.blocks.values()) {
    if (surface.flavour !== 'affine:surface' || !surface.children.includes(block.id)) {
      continue
    }
    const { framedChildIds } = surfaceFrameMembership(surface, context)
    if (!framedChildIds.has(block.id)) {
      return true
    }
  }
  return false
}

function surfaceGeneratesDiagram(
  block: AffineBlock,
  context: BlockConversionContext,
  elements: readonly NativeElement[],
): boolean {
  if (elements.length > 0) {
    return true
  }
  const { framedChildIds } = surfaceFrameMembership(block, context)
  return block.children.some((id) => {
    const child = context.blocks.get(id)
    if (child === undefined) {
      fail(block, `references missing child ${id}.`)
    }
    if (framedChildIds.has(id) && child.flavour !== 'affine:frame') {
      return false
    }
    return optionalGeometry(child) !== undefined
  })
}

function requiredString(block: AffineBlock, property: string): string {
  const value = block.source.get(property)
  if (typeof value !== 'string' || value.length === 0) {
    fail(block, `property ${property} must be a non-empty string.`)
  }
  return value
}

function optionalCaption(block: AffineBlock): string | undefined {
  const value = block.source.get('prop:caption')
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  if (typeof value !== 'string') {
    fail(block, 'property prop:caption must be a string or null.')
  }
  return value
}

export function surfaceDiagramPath(documentId: string, surfaceId: string): string {
  return `assets/diagrams/${sanitizeFilename(`${documentId}--${surfaceId}`, documentId)}.svg`
}

function owningSurface(context: BlockConversionContext, childId: string): AffineBlock | undefined {
  return [...context.blocks.values()].find(candidate =>
    candidate.flavour === 'affine:surface' && candidate.children.includes(childId))
}

function convertSurfaceReference(block: AffineBlock, context: BlockConversionContext): ConvertedBlock {
  if (block.children.length > 0) {
    fail(block, 'cannot have children.')
  }
  const reference = requiredString(block, 'prop:reference')
  const expectedFlavour = requiredString(block, 'prop:refFlavour')
  const target = context.blocks.get(reference)
  if (target === undefined) {
    fail(block, `reference target ${reference} is missing.`)
  }
  if (target.flavour !== expectedFlavour) {
    fail(block, `reference target ${reference} flavour does not match prop:refFlavour.`)
  }
  const surface = owningSurface(context, reference)
  if (surface === undefined) {
    fail(block, `reference target ${reference} has no owning surface.`)
  }
  const hasDiagram = surfaceGeneratesDiagram(surface, context, nativeElements(surface))
  const path = hasDiagram
    ? surfaceDiagramPath(context.documentId, surface.id)
    : context.pages.require(context.documentId).outputPath
  const caption = optionalCaption(block)
  return {
    markdown: `${hasDiagram ? '!' : ''}[[${escapeWikilinkTarget(path)}${caption === undefined ? '' : `|${escapeWikilinkAlias(caption)}`}]]`,
  }
}

function convertFrame(
  block: AffineBlock,
  context: BlockConversionContext,
  renderSequence: RenderBlockSequence,
): string {
  if (block.children.length > 0) {
    fail(block, 'frame sys:children must be empty; use prop:childElementIds.')
  }
  const sourceTitle = mapValue(block.source, 'prop:title')
  let title: string
  if (sourceTitle instanceof Y.Text) {
    const rendered = renderRichText(sourceTitle, context.pages, context.coverage)
    context.losses.push(...rendered.losses)
    title = rendered.markdown
  }
  else if (typeof sourceTitle === 'string' && sourceTitle.length > 0) {
    title = escapeMarkdownInlineText(sourceTitle)
  }
  else {
    fail(block, 'property prop:title must be a non-empty string or Y.Text.')
  }
  const ids = frameChildIds(block)
  const surface = owningSurface(context, block.id)
  const native = new Set(surface === undefined
    ? []
    : nativeElements(surface).map(element => element.id))
  const indexedBlocks: Array<{ id: string, index: string }> = []
  for (const id of ids) {
    const child = context.blocks.get(id)
    if (child !== undefined) {
      indexedBlocks.push(blockIndex(child))
    }
    else if (!native.has(id)) {
      fail(block, `frame child ${id} is missing.`)
    }
  }
  indexedBlocks.sort(compareIndexed)
  const blockIds = indexedBlocks.map(child => child.id)
  const contents = blockIds.length === 0 ? '' : renderSequence(blockIds, 0)
  return `## ${title}${contents.length === 0 ? '' : `\n\n${contents}`}`
}

interface SvgResult {
  readonly contents: string
  readonly nativeTexts: readonly string[]
  readonly warnings: readonly ConversionWarning[]
}

interface NativeGroupResult {
  readonly grouped: ReadonlySet<string>
  readonly warnings: readonly ConversionWarning[]
}

function groupNativeElements(
  block: AffineBlock,
  context: BlockConversionContext,
  elements: readonly NativeElement[],
  byId: ReadonlyMap<string, NativeElement>,
): NativeGroupResult {
  const warnings: ConversionWarning[] = []
  const grouped = new Set<string>()
  const owners = new Map<string, string>()
  for (const element of elements) {
    if (element.type !== 'group') {
      continue
    }
    const children = record(element.value.children)
    if (children === undefined) {
      fail(block, `group ${element.id} children must be an object.`)
    }
    for (const [id, included] of Object.entries(children)) {
      if (included !== true) {
        fail(block, `group ${element.id} child ${id} must be true.`)
      }
      if (!byId.has(id) && !context.blocks.has(id)) {
        const approved = allowsMissingGroupChild(
          context.allowMissingGroupChildren,
          context.documentId,
          block.id,
          element.id,
          id,
        )
        if (!approved) {
          fail(block, `group ${element.id} references missing child ${id}.`)
        }
        warnings.push({
          kind: 'edgeless-missing-group-child',
          documentId: context.documentId,
          blockId: block.id,
          groupId: element.id,
          childId: id,
          reason: 'The source group references a non-existent element; all existing elements are retained.',
        })
        continue
      }
      if (byId.has(id)) {
        const owner = owners.get(id)
        if (owner !== undefined && owner !== element.id) {
          fail(block, `native element ${id} belongs to multiple groups ${owner} and ${element.id}.`)
        }
        owners.set(id, element.id)
        grouped.add(id)
      }
    }
  }
  return { grouped, warnings }
}

interface ConnectorPathResult {
  readonly paths: ReadonlyMap<string, string>
  readonly endpoints: ReadonlyMap<string, readonly Point[]>
}

function connectorEndpoint(
  block: AffineBlock,
  element: NativeElement,
  endpointName: 'source' | 'target',
  blockGeometries: ReadonlyMap<string, Geometry>,
  elementGeometries: ReadonlyMap<string, Geometry>,
): Point {
  const endpoint = record(element.value[endpointName])
  if (endpoint === undefined) {
    fail(block, `connector ${element.id} ${endpointName} must be an object.`)
  }
  if (endpoint.id === undefined) {
    return {
      x: numberValue(endpoint.x, block, `connector ${element.id} x`),
      y: numberValue(endpoint.y, block, `connector ${element.id} y`),
    }
  }
  if (typeof endpoint.id !== 'string') {
    fail(block, `connector ${element.id} has an invalid target id.`)
  }
  const box = elementGeometries.get(endpoint.id) ?? blockGeometries.get(endpoint.id)
  if (box === undefined) {
    fail(block, `connector ${element.id} target ${endpoint.id} is missing geometry.`)
  }
  let position: [number, number] = [0.5, 0.5]
  if (endpoint.position !== undefined) {
    if (!Array.isArray(endpoint.position) || endpoint.position.length !== 2) {
      fail(block, `connector ${element.id} endpoint position must contain two numbers.`)
    }
    position = [
      numberValue(endpoint.position[0], block, 'connector position'),
      numberValue(endpoint.position[1], block, 'connector position'),
    ]
  }
  return {
    x: box.x + box.width * position[0],
    y: box.y + box.height * position[1],
  }
}

function connectorEndpoints(
  block: AffineBlock,
  element: NativeElement,
  blockGeometries: ReadonlyMap<string, Geometry>,
  elementGeometries: ReadonlyMap<string, Geometry>,
): Point[] {
  const endpoints = (['source', 'target'] as const).map(endpointName =>
    connectorEndpoint(block, element, endpointName, blockGeometries, elementGeometries))
  const controllers = element.value.controllers ?? []
  if (!Array.isArray(controllers)) {
    fail(block, `connector ${element.id} controllers must be an array.`)
  }
  for (const raw of controllers) {
    const controller = record(raw)
    if (controller === undefined) {
      fail(block, `connector ${element.id} has an invalid controller.`)
    }
    endpoints.splice(endpoints.length - 1, 0, {
      x: numberValue(controller.x, block, 'connector controller x'),
      y: numberValue(controller.y, block, 'connector controller y'),
    })
  }
  return endpoints
}

function connectorPath(block: AffineBlock, element: NativeElement, endpoints: readonly Point[]): string {
  const [first, ...rest] = endpoints
  if (first === undefined) {
    fail(block, `connector ${element.id} has no endpoints.`)
  }
  return `M ${svgNumber(first.x)} ${svgNumber(first.y)}${rest.map(point =>
    ` L ${svgNumber(point.x)} ${svgNumber(point.y)}`).join('')}`
}

function buildConnectorPaths(
  block: AffineBlock,
  elements: readonly NativeElement[],
  blockGeometries: ReadonlyMap<string, Geometry>,
  elementGeometries: ReadonlyMap<string, Geometry>,
): ConnectorPathResult {
  const endpointsById = new Map<string, readonly Point[]>()
  const paths = new Map<string, string>()
  for (const element of elements) {
    if (element.type !== 'connector') {
      continue
    }
    const endpoints = connectorEndpoints(block, element, blockGeometries, elementGeometries)
    paths.set(element.id, connectorPath(block, element, endpoints))
    endpointsById.set(element.id, endpoints)
  }
  return { paths, endpoints: endpointsById }
}

interface NativeSvgResult extends PaintedSvg {
  readonly nativeTexts: readonly string[]
}

function renderNativeGroup(
  block: AffineBlock,
  context: BlockConversionContext,
  element: NativeElement,
  byId: ReadonlyMap<string, NativeElement>,
  renderElement: (element: NativeElement) => string,
): string {
  const children = record(element.value.children) ?? {}
  const childElements = Object.keys(children)
    .map(id => byId.get(id))
    .filter((item): item is NativeElement => item !== undefined)
    .sort(compareIndexed)
  const titleValue = nativeProperty(element, 'title')
  const title = titleValue === undefined
    ? element.id
    : svgText(titleValue, block, context, `group ${element.id} title`)
  return `<g id="${xml(element.id)}"><title>${xml(title)}</title>${childElements.map(renderElement).join('')}</g>`
}

function renderNativeShape(
  block: AffineBlock,
  context: BlockConversionContext,
  element: NativeElement,
  box: Geometry,
): PaintedSvg {
  const fill = element.value.filled === false ? 'none' : color(element.value.fillColor, '#ffffff', block, `shape ${element.id} fillColor`)
  const stroke = color(element.value.strokeColor, '#000000', block, `shape ${element.id} strokeColor`)
  const width = positiveProperty(element.value, 'strokeWidth', 1, block)
  const common = `fill="${xml(fill)}" stroke="${xml(stroke)}" stroke-width="${svgNumber(width)}"`
  const bounds: Geometry[] = [expandGeometry(box, width / 2)]
  let output: string
  if (element.value.shapeType === 'rect') {
    const radius = nonnegativeProperty(element.value, 'radius', 0, block)
    output = `<rect x="${svgNumber(box.x)}" y="${svgNumber(box.y)}" width="${svgNumber(box.width)}" height="${svgNumber(box.height)}" rx="${svgNumber(radius)}" ${common}/>`
  }
  else if (element.value.shapeType === 'ellipse') {
    output = `<ellipse cx="${svgNumber(box.x + box.width / 2)}" cy="${svgNumber(box.y + box.height / 2)}" rx="${svgNumber(box.width / 2)}" ry="${svgNumber(box.height / 2)}" ${common}/>`
  }
  else if (element.value.shapeType === 'diamond' || element.value.shapeType === 'triangle') {
    const points = element.value.shapeType === 'diamond'
      ? [[box.x + box.width / 2, box.y], [box.x + box.width, box.y + box.height / 2], [box.x + box.width / 2, box.y + box.height], [box.x, box.y + box.height / 2]]
      : [[box.x + box.width / 2, box.y], [box.x + box.width, box.y + box.height], [box.x, box.y + box.height]]
    output = `<polygon points="${points.map(([x, y]) => `${svgNumber(x ?? 0)},${svgNumber(y ?? 0)}`).join(' ')}" ${common}/>`
  }
  else {
    fail(block, `shape ${element.id} has unsupported shapeType "${String(element.value.shapeType)}".`)
  }
  const shapeText = svgText(nativeProperty(element, 'text'), block, context, `shape ${element.id} text`)
  if (shapeText.length > 0) {
    const size = positiveProperty(element.value, 'fontSize', 16, block)
    const x = box.x + 8
    const y = box.y + 24
    output += textTag(shapeText, x, y, size, color(element.value.color, '#000000', block, `shape ${element.id} color`))
    bounds.push(textPaintedBounds(shapeText, x, y, size))
  }
  return { contents: output, bounds }
}

function renderNativeText(
  block: AffineBlock,
  context: BlockConversionContext,
  element: NativeElement,
  box: Geometry,
  nativeTextValues: Map<string, string>,
): PaintedSvg {
  const size = positiveProperty(element.value, 'fontSize', 16, block)
  const anchor = element.value.textAlign === 'center' ? 'middle' : element.value.textAlign === 'right' ? 'end' : 'start'
  const x = anchor === 'middle' ? box.x + box.width / 2 : anchor === 'end' ? box.x + box.width : box.x
  const y = box.y + size
  const text = svgText(nativeProperty(element, 'text'), block, context, `text element ${element.id} text`)
  nativeTextValues.set(element.id, text)
  const contents = textTag(text, x, y, size, color(element.value.color, '#000000', block, `text element ${element.id} color`), anchor)
  const bounds = text.length === 0 ? [box] : [box, textPaintedBounds(text, x, y, size, anchor)]
  return { contents, bounds }
}

function connectorPaintedBounds(
  endpoints: readonly Point[],
  strokeWidth: number,
  frontArrow: boolean,
  rearArrow: boolean,
): Geometry[] {
  const bounds = endpoints.map(point => pointGeometry(point, strokeWidth * 2))
  const markerRadius = Math.hypot(9, 5) * strokeWidth * 0.6
  const first = endpoints[0]
  const last = endpoints.at(-1)
  if (frontArrow && first !== undefined) {
    bounds.push(pointGeometry(first, markerRadius))
  }
  if (rearArrow && last !== undefined) {
    bounds.push(pointGeometry(last, markerRadius))
  }
  return bounds
}

function renderNativeConnector(
  block: AffineBlock,
  element: NativeElement,
  connectorPaths: ReadonlyMap<string, string>,
  connectorEndpoints: ReadonlyMap<string, readonly Point[]>,
): PaintedSvg {
  const front = element.value.frontEndpointStyle ?? 'None'
  const rear = element.value.rearEndpointStyle ?? 'None'
  if ((front !== 'None' && front !== 'Arrow') || (rear !== 'None' && rear !== 'Arrow')) {
    fail(block, `connector ${element.id} has an unsupported endpoint style.`)
  }
  const strokeWidth = positiveProperty(element.value, 'strokeWidth', 1, block)
  const contents = `<path d="${connectorPaths.get(element.id)}" fill="none" stroke="${xml(color(element.value.stroke, '#000000', block, `connector ${element.id} stroke`))}" stroke-width="${svgNumber(strokeWidth)}"${rear === 'Arrow' ? ' marker-end="url(#arrow)"' : ''}${front === 'Arrow' ? ' marker-start="url(#arrow)"' : ''}/>`
  const endpoints = connectorEndpoints.get(element.id) ?? []
  return {
    contents,
    bounds: connectorPaintedBounds(endpoints, strokeWidth, front === 'Arrow', rear === 'Arrow'),
  }
}

function renderNativeSvg(
  block: AffineBlock,
  context: BlockConversionContext,
  elements: readonly NativeElement[],
  byId: ReadonlyMap<string, NativeElement>,
  elementGeometries: ReadonlyMap<string, Geometry>,
  grouped: ReadonlySet<string>,
  connectorPaths: ReadonlyMap<string, string>,
  connectorEndpoints: ReadonlyMap<string, readonly Point[]>,
): NativeSvgResult {
  const nativeTextValues = new Map<string, string>()
  const rendered = new Set<string>()
  const active = new Set<string>()
  const bounds: Geometry[] = []
  function renderElement(element: NativeElement): string {
    if (rendered.has(element.id)) {
      return ''
    }
    if (active.has(element.id)) {
      fail(block, `native group cycle includes ${element.id}.`)
    }
    active.add(element.id)
    let painted: PaintedSvg
    if (element.type === 'group') {
      painted = { contents: renderNativeGroup(block, context, element, byId, renderElement), bounds: [] }
    }
    else if (element.type === 'shape') {
      const box = elementGeometries.get(element.id)
      if (box === undefined) {
        fail(block, `shape ${element.id} has no geometry.`)
      }
      painted = renderNativeShape(block, context, element, box)
    }
    else if (element.type === 'text') {
      const box = elementGeometries.get(element.id)
      if (box === undefined) {
        fail(block, `text element ${element.id} has no geometry.`)
      }
      painted = renderNativeText(block, context, element, box, nativeTextValues)
    }
    else {
      painted = renderNativeConnector(block, element, connectorPaths, connectorEndpoints)
    }
    bounds.push(...painted.bounds)
    active.delete(element.id)
    rendered.add(element.id)
    return painted.contents
  }

  const roots = elements.filter(element => !grouped.has(element.id))
  const contents = roots.map(renderElement).join('')
  if (rendered.size !== elements.length) {
    const unreachable = elements.find(element => !rendered.has(element.id))
    if (unreachable !== undefined) {
      renderElement(unreachable)
    }
    fail(block, 'contains unreachable native elements.')
  }
  const nativeTexts = elements.flatMap((element) => {
    if (element.type !== 'text') {
      return []
    }
    const text = nativeTextValues.get(element.id) ?? ''
    return text.trim().length > 0 ? [text] : []
  })
  return { contents, nativeTexts, bounds }
}

interface SurfaceBlocksSvgResult {
  readonly contents: string
  readonly bounds: readonly Geometry[]
}
function renderSurfaceBlock(
  surface: AffineBlock,
  child: AffineBlock,
  context: BlockConversionContext,
  box: Geometry,
): PaintedSvg {
  if (child.flavour === 'affine:frame') {
    const title = svgText(child.source.get('prop:title'), child, context, 'property prop:title', false)
    const contents = `<g id="${xml(child.id)}"><rect x="${svgNumber(box.x)}" y="${svgNumber(box.y)}" width="${svgNumber(box.width)}" height="${svgNumber(box.height)}" fill="#fff8e7" stroke="#b89b24"/>${textTag(title, box.x + 12, box.y + 26, 20, '#000000')}</g>`
    const bounds = title.length === 0
      ? [expandGeometry(box, 0.5)]
      : [expandGeometry(box, 0.5), textPaintedBounds(title, box.x + 12, box.y + 26, 20)]
    return { contents, bounds }
  }
  if (child.flavour === 'affine:edgeless-text') {
    const text = plainBlockText(child, context)
    const contents = textTag(text, box.x, box.y + 16, 16, color(child.source.get('prop:color'), '#000000', surface, `edgeless-text ${child.id} prop:color`))
    return { contents, bounds: text.length === 0 ? [] : [textPaintedBounds(text, box.x, box.y + 16, 16)] }
  }
  if (child.flavour === 'affine:image' || child.flavour === 'affine:bookmark') {
    const label = child.flavour === 'affine:image' ? 'Image' : child.source.get('prop:title') ?? child.source.get('prop:url') ?? 'Bookmark'
    const text = svgText(label, child, context, 'diagram label', false)
    const contents = `<rect x="${svgNumber(box.x)}" y="${svgNumber(box.y)}" width="${svgNumber(box.width)}" height="${svgNumber(box.height)}" fill="#ffffff" stroke="#777777"/>${textTag(text, box.x + 8, box.y + 24, 16, '#000000')}`
    const bounds = text.length === 0
      ? [expandGeometry(box, 0.5)]
      : [expandGeometry(box, 0.5), textPaintedBounds(text, box.x + 8, box.y + 24, 16)]
    return { contents, bounds }
  }
  return fail(child, 'is not supported as a direct surface child.')
}

function orderedChildren(
  block: AffineBlock,
  context: BlockConversionContext,
  ids: readonly string[] = block.children,
  description = 'child',
): AffineBlock[] {
  return ids.map((id) => {
    const child = context.blocks.get(id)
    if (child === undefined) {
      fail(block, `references missing ${description} ${id}.`)
    }
    return child
  }).sort((left, right) => compareIndexed(blockIndex(left), blockIndex(right)))
}

function renderSurfaceBlocks(
  block: AffineBlock,
  context: BlockConversionContext,
  blockGeometries: ReadonlyMap<string, Geometry>,
): SurfaceBlocksSvgResult {
  const { framedChildIds } = surfaceFrameMembership(block, context)
  const orderedBlocks = orderedChildren(block, context)
  const bounds: Geometry[] = []
  const contents: string[] = []
  for (const child of orderedBlocks) {
    if (framedChildIds.has(child.id) && child.flavour !== 'affine:frame') {
      continue
    }
    const box = blockGeometries.get(child.id)
    if (box === undefined) {
      continue
    }
    const painted = renderSurfaceBlock(block, child, context, box)
    contents.push(painted.contents)
    bounds.push(box, ...painted.bounds)
  }
  return { contents: contents.join(''), bounds }
}

function renderSvg(
  block: AffineBlock,
  context: BlockConversionContext,
  elements: readonly NativeElement[],
): SvgResult | undefined {
  const byId = new Map(elements.map(element => [element.id, element]))
  const blockGeometries = new Map<string, Geometry>()
  for (const child of context.blocks.values()) {
    const box = optionalGeometry(child)
    if (box !== undefined) {
      blockGeometries.set(child.id, box)
    }
  }
  const elementGeometries = new Map<string, Geometry>()
  for (const element of elements) {
    if (element.type === 'shape' || element.type === 'text' || element.value.xywh !== undefined) {
      elementGeometries.set(element.id, geometry(element.value.xywh, block, `element ${element.id}`))
    }
  }
  const { grouped, warnings } = groupNativeElements(block, context, elements, byId)
  const connectors = buildConnectorPaths(block, elements, blockGeometries, elementGeometries)
  const native = renderNativeSvg(
    block,
    context,
    elements,
    byId,
    elementGeometries,
    grouped,
    connectors.paths,
    connectors.endpoints,
  )
  const blockSvg = renderSurfaceBlocks(block, context, blockGeometries)

  if (!surfaceGeneratesDiagram(block, context, elements)) {
    return undefined
  }
  const bounds: Geometry[] = [
    ...native.bounds,
    ...blockSvg.bounds,
  ]
  if (bounds.length === 0) {
    bounds.push({ x: 0, y: 0, width: 1, height: 1 })
  }
  const minX = bounds.reduce((minimum, box) => Math.min(minimum, box.x), Infinity)
  const minY = bounds.reduce((minimum, box) => Math.min(minimum, box.y), Infinity)
  const maxX = bounds.reduce((maximum, box) => Math.max(maximum, box.x + box.width), -Infinity)
  const maxY = bounds.reduce((maximum, box) => Math.max(maximum, box.y + box.height), -Infinity)
  const margin = 16
  const viewX = minX - margin
  const viewY = minY - margin
  const width = Math.max(1, maxX - minX + margin * 2)
  const height = Math.max(1, maxY - minY + margin * 2)
  const arrows = elements.some(element => element.type === 'connector'
    && (element.value.frontEndpointStyle === 'Arrow' || element.value.rearEndpointStyle === 'Arrow'))
  const definitions = arrows ? '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#000000"/></marker></defs>' : ''
  const contents = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${svgNumber(viewX)} ${svgNumber(viewY)} ${svgNumber(width)} ${svgNumber(height)}" width="${svgNumber(width)}" height="${svgNumber(height)}" role="img" aria-label="${xml(`AFFiNE surface ${block.id}`)}"><title>${xml(`AFFiNE surface ${block.id}`)}</title>${definitions}${native.contents}${blockSvg.contents}</svg>`
  return { contents, nativeTexts: native.nativeTexts, warnings }
}

function convertSurface(
  block: AffineBlock,
  context: BlockConversionContext,
  renderSequence: RenderBlockSequence,
): ConvertedBlock {
  const elements = nativeElements(block)
  const svg = renderSvg(block, context, elements)
  if (elements.length === 0 && block.children.length === 0) {
    return { childrenHandled: true, disposition: 'structural/metadata-only' }
  }

  const { frameIds, framedChildIds } = surfaceFrameMembership(block, context)
  const topLevelIds = block.children.filter(id => !framedChildIds.has(id) || frameIds.has(id))
  const topLevel = orderedChildren(block, context, topLevelIds, 'surface child')
  const rendered = renderSequence(topLevel.map(child => child.id), 0)
  const sections: string[] = []
  let diagrams: DiagramAsset[] = []
  if (svg !== undefined) {
    const path = surfaceDiagramPath(context.documentId, block.id)
    diagrams = [{ path, contents: svg.contents }]
    sections.push(`![[${escapeWikilinkTarget(path)}]]`)
    if (svg.nativeTexts.length > 0) {
      sections.push(`### Canvas text\n\n${svg.nativeTexts.map(escapeMarkdownText).join('\n\n')}`)
    }
  }
  if (rendered.length > 0) {
    sections.push(rendered)
  }
  return { markdown: sections.join('\n\n'), childrenHandled: true, diagrams, warnings: svg?.warnings ?? [] }
}

/** Convert edgeless blocks; surface conversion consumes and orders its visual children. */
export function convertEdgelessBlock(
  block: AffineBlock,
  context: BlockConversionContext,
  renderSequence: RenderBlockSequence,
): ConvertedBlock {
  switch (block.flavour) {
    case 'affine:surface':
      return convertSurface(block, context, renderSequence)
    case 'affine:surface-ref':
      return convertSurfaceReference(block, context)
    case 'affine:edgeless-text': {
      const text = block.source.get('prop:text')
      const renderedBySurface = surfaceRendersBlockText(block, context)
      if (text === undefined || renderedBySurface) {
        return {}
      }
      if (text instanceof Y.Text) {
        const rendered = renderRichText(text, context.pages, context.coverage)
        context.losses.push(...rendered.losses)
        return { markdown: rendered.markdown }
      }
      if (typeof text !== 'string') {
        fail(block, 'property prop:text must be a string or Y.Text.')
      }
      return { markdown: escapeMarkdownText(text) }
    }
    case 'affine:frame':
      return { markdown: convertFrame(block, context, renderSequence), childrenHandled: true }
    default:
      fail(block, 'is not an edgeless block.')
  }
}
