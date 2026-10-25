import type * as Y from 'yjs'

import type { DocumentCoverageLedger } from './coverage.ts'

import type { PageRegistry } from './page-registry.ts'

import { textDeltas } from './converters/yjs.ts'
import {
  escapeInlineCode,
  escapeMarkdownText,
  escapeMarkdownUrl,
  escapeWikilinkAlias,
  escapeWikilinkTarget,
  normalizeExternalUrl,
} from './markdown.ts'

const BOOLEAN_MARKS: Record<string, true> = {
  bold: true,
  italic: true,
  underline: true,
  strike: true,
  code: true,
}
const KNOWN_ATTRIBUTES: Record<string, true> = {
  ...BOOLEAN_MARKS,
  background: true,
  color: true,
  link: true,
  reference: true,
}
const COLOR_ATTRIBUTES = ['background', 'color'] as const

type ColorAttribute = (typeof COLOR_ATTRIBUTES)[number]
type FormatAttribute = 'bold' | 'italic' | 'underline' | 'strike'
type Attributes = Record<string, unknown>

export interface RichTextLoss {
  kind: 'visual-color' | 'visual-formatting'
  attribute: ColorAttribute | FormatAttribute
  value: string
  text: string
  readonly blockId?: string
  readonly property?: string
  readonly deltaIndex?: number
}

export interface RenderedRichText {
  markdown: string
  losses: RichTextLoss[]
}

interface LinkedPageReference {
  type: 'LinkedPage'
  pageId: string
}

interface TextBoundaries {
  leading: string
  core: string
  trailing: string
}

interface RichTextSource {
  readonly blockId: string
  readonly property: string
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false && value !== ''
}

function validateAttributes(attributes: Attributes): void {
  for (const [name, value] of Object.entries(attributes)) {
    if (KNOWN_ATTRIBUTES[name] !== true) {
      throw new Error(`AFFiNE delta has unknown rich-text attribute "${name}"`)
    }
    if (BOOLEAN_MARKS[name] === true && isPresent(value) && value !== true) {
      throw new Error(`AFFiNE rich-text attribute ${name} must be true when present`)
    }
  }
}

function optionalString(attributes: Attributes, name: ColorAttribute | 'link'): string | undefined {
  const value = attributes[name]
  if (!isPresent(value)) {
    return undefined
  }
  if (typeof value !== 'string') {
    throw new TypeError(`AFFiNE rich-text attribute ${name} must be a string`)
  }
  return value
}

function linkedPage(attributes: Attributes): LinkedPageReference | undefined {
  const value = attributes.reference
  if (!isPresent(value)) {
    return undefined
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('AFFiNE rich-text reference must be an object')
  }

  const reference = value as Record<string, unknown>
  if (reference.type !== 'LinkedPage') {
    throw new Error(`Unsupported AFFiNE rich-text reference type "${String(reference.type)}"`)
  }
  if (typeof reference.pageId !== 'string' || reference.pageId.length === 0) {
    throw new Error('AFFiNE LinkedPage reference requires a nonempty pageId')
  }
  return { type: 'LinkedPage', pageId: reference.pageId }
}

function enabled(attributes: Attributes, name: string): boolean {
  return attributes[name] === true
}

interface LineContext {
  prefix: string
  endedWithCarriageReturn: boolean
}

function escapeAdjacentLineStart(rendered: string, value: string, linePrefix: string): string {
  const escaped = /^ {0,3}\d+$/u.test(linePrefix) && value.startsWith('.')
    ? rendered.replace(/^\./u, '\\.')
    : rendered
  const leadingSpaces = /^ */u.exec(value)?.[0].length ?? 0
  if (
    /^ {1,3}$/u.test(linePrefix)
    && linePrefix.length + leadingSpaces >= 4
    && escaped.startsWith(' ')
  ) {
    return `&#32;${escaped.slice(1)}`
  }
  return escaped
}

function advanceLine(line: LineContext, value: string): void {
  if (value.length === 0) {
    return
  }
  const lastBreak = Math.max(value.lastIndexOf('\n'), value.lastIndexOf('\r'))
  line.prefix = lastBreak === -1 ? line.prefix + value : value.slice(lastBreak + 1)
  line.endedWithCarriageReturn = value.endsWith('\r')
}

function renderPlainText(value: string, line: LineContext): string {
  const source = line.endedWithCarriageReturn && value.startsWith('\n') ? value.slice(1) : value
  const escaped = escapeMarkdownText(source)
  return escapeAdjacentLineStart(escaped, source, line.prefix).replaceAll('\n', '<br>')
}

function escapeCodeWikilinkAlias(value: string): string {
  return value.replace(/([\\[\]|])/gu, '\\$1')
}

function textBoundaries(value: string): TextBoundaries {
  const leading = /^\s*/u.exec(value)?.[0] ?? ''
  if (leading.length === value.length) {
    return { leading, core: '', trailing: '' }
  }
  const trailing = /\s*$/u.exec(value)?.[0] ?? ''
  return {
    leading,
    core: value.slice(leading.length, value.length - trailing.length),
    trailing,
  }
}

function collectColorLosses(
  attributes: Attributes,
  sourceText: string,
  source: RichTextSource | undefined,
  deltaIndex: number,
): { losses: RichTextLoss[], lostColors: ColorAttribute[] } {
  const losses: RichTextLoss[] = []
  const lostColors: ColorAttribute[] = []
  for (const attribute of COLOR_ATTRIBUTES) {
    const value = optionalString(attributes, attribute)
    if (value !== undefined) {
      losses.push({
        kind: 'visual-color',
        attribute,
        value,
        text: sourceText,
        ...(source === undefined ? {} : { ...source, deltaIndex }),
      })
      lostColors.push(attribute)
    }
  }
  return { losses, lostColors }
}

function renderFormattedText(
  rendered: string,
  attributes: Attributes,
  core: string,
  code: boolean,
): string {
  if (core.length === 0 && !code) {
    return rendered
  }
  if (optionalString(attributes, 'background') !== undefined) {
    rendered = `==${rendered}==`
  }
  if (enabled(attributes, 'underline')) {
    rendered = `<u>${rendered}</u>`
  }
  if (enabled(attributes, 'strike')) {
    rendered = `~~${rendered}~~`
  }
  if (enabled(attributes, 'italic')) {
    rendered = `*${rendered}*`
  }
  if (enabled(attributes, 'bold')) {
    rendered = `**${rendered}**`
  }
  return rendered
}

/** Render one Y.Text delta stream; every source delta is consumed exactly once. */
export function renderRichText(
  text: Y.Text,
  pages: PageRegistry,
  coverage?: DocumentCoverageLedger,
): RenderedRichText {
  const markdown: string[] = []
  const line: LineContext = { prefix: '', endedWithCarriageReturn: false }
  const losses: RichTextLoss[] = []
  const source = coverage?.richTextSource(text)

  for (const [deltaIndex, delta] of textDeltas(text).entries()) {
    if (typeof delta.insert !== 'string') {
      throw new TypeError('AFFiNE rich-text delta insert must be a string')
    }
    const attributes = delta.attributes ?? {}
    validateAttributes(attributes)
    const sourceText = delta.insert
    const reference = linkedPage(attributes)
    const link = optionalString(attributes, 'link')
    if (reference !== undefined && link !== undefined) {
      throw new Error('AFFiNE rich-text delta cannot have both link and reference attributes')
    }

    const { losses: colorLosses, lostColors } = collectColorLosses(
      attributes,
      sourceText,
      source,
      deltaIndex,
    )
    losses.push(...colorLosses)

    const code = enabled(attributes, 'code')
    const { leading, core, trailing } = code
      ? { leading: '', core: sourceText, trailing: '' }
      : textBoundaries(sourceText)

    const renderedLeading = renderPlainText(leading, line)
    advanceLine(line, leading)
    const coreText = line.endedWithCarriageReturn && core.startsWith('\n') ? core.slice(1) : core
    let rendered = reference === undefined ? renderPlainText(core, line) : escapeWikilinkAlias(coreText)
    if (code) {
      rendered = escapeInlineCode(coreText)
    }
    rendered = renderFormattedText(rendered, attributes, coreText, code)
    advanceLine(line, core)

    if (reference !== undefined) {
      const target = pages.require(reference.pageId)
      const path = escapeWikilinkTarget(target.outputPath)
      const alias = code ? escapeCodeWikilinkAlias(rendered) : rendered
      rendered = coreText.length === 0 && !code ? `[[${path}]]` : `[[${path}|${alias}]]`
    }
    else if (link !== undefined) {
      rendered = `[${rendered}](${escapeMarkdownUrl(normalizeExternalUrl(link))})`
    }
    coverage?.recordRichTextDelta(
      text,
      deltaIndex,
      lostColors.length === 0 ? 'rendered' : 'approved-loss',
      lostColors.length === 0 ? undefined : `visual-color:${lostColors.join(',')}`,
    )
    const renderedTrailing = renderPlainText(trailing, line)
    advanceLine(line, trailing)
    markdown.push(`${renderedLeading}${rendered}${renderedTrailing}`)
  }

  return { markdown: markdown.join(''), losses }
}
