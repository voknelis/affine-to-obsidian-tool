import * as Y from 'yjs'

import { textDeltas } from './converters/yjs.ts'

export const COVERAGE_DISPOSITIONS = ['rendered', 'structural/metadata-only', 'approved-loss'] as const
export type CoverageDisposition = (typeof COVERAGE_DISPOSITIONS)[number]

export function isCoverageDisposition(value: unknown): value is CoverageDisposition {
  return typeof value === 'string' && (COVERAGE_DISPOSITIONS as readonly string[]).includes(value)
}

export interface CoverageCounts {
  readonly total: number
  readonly rendered: number
  readonly structuralMetadataOnly: number
  readonly approvedLoss: number
}

export interface BlockCoverageItem {
  readonly kind: 'block'
  readonly blockId: string
  readonly disposition: CoverageDisposition
  readonly reason?: string
}

export interface RichTextDeltaCoverageItem {
  readonly kind: 'rich-text-delta'
  readonly blockId: string
  readonly property: string
  readonly deltaIndex: number
  readonly disposition: CoverageDisposition
  readonly reason?: string
}

export type CoverageItem = BlockCoverageItem | RichTextDeltaCoverageItem

export interface DocumentCoverage {
  readonly documentId: string
  readonly blocks: CoverageCounts
  readonly richTextDeltas: CoverageCounts
  readonly items: readonly CoverageItem[]
}

export interface CoverageSourceBlock {
  readonly id: string
  readonly source: Y.Map<unknown>
}

interface TextSource {
  readonly blockId: string
  readonly property: string
  readonly deltaCount: number
}

export class CoverageError extends Error {
  override readonly name = 'CoverageError'
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareItems(left: CoverageItem, right: CoverageItem): number {
  return compareText(left.kind, right.kind)
    || compareText(left.blockId, right.blockId)
    || compareText(left.kind === 'rich-text-delta' ? left.property : '', right.kind === 'rich-text-delta' ? right.property : '')
    || (left.kind === 'rich-text-delta' ? left.deltaIndex : -1)
    - (right.kind === 'rich-text-delta' ? right.deltaIndex : -1)
}

/**
 * Census every source block and Y.Text delta before conversion, then require
 * exactly one explicit disposition for each. No output-only heuristic is used.
 */
export class DocumentCoverageLedger {
  readonly documentId: string
  private readonly blockIds: ReadonlySet<string>
  private readonly textSources = new WeakMap<Y.Text, TextSource>()
  private readonly textIdentities = new Map<string, TextSource>()
  private readonly records = new Map<string, CoverageItem>()
  private completedCoverage: DocumentCoverage | undefined

  constructor(documentId: string, blocks: Iterable<CoverageSourceBlock>) {
    this.documentId = documentId
    const ids = new Set<string>()
    const ordered = [...blocks].sort((left, right) => compareText(left.id, right.id))
    for (const block of ordered) {
      if (ids.has(block.id)) {
        throw new CoverageError(`Duplicate source block "${block.id}" in document ${documentId}.`)
      }

      ids.add(block.id)
      this.censusValue(block.id, block.source, '', new WeakSet<object>())
    }
    this.blockIds = ids
  }

  private censusValue(blockId: string, value: unknown, path: string, ancestors: WeakSet<object>): void {
    if (value instanceof Y.Text) {
      if (path.length === 0) {
        throw new CoverageError(`Rich text in block ${blockId} has no property path.`)
      }

      if (this.textSources.has(value)) {
        throw new CoverageError(`Rich text at ${blockId}:${path} is shared by multiple source properties.`)
      }
      const source = { blockId, property: path, deltaCount: textDeltas(value).length }
      const identity = `${blockId}\0${path}`
      if (this.textIdentities.has(identity)) {
        throw new CoverageError(`Duplicate rich-text source identity "${blockId}:${path}" in document ${this.documentId}.`)
      }

      this.textIdentities.set(identity, source)
      this.textSources.set(value, source)
      return
    }
    if (value === null || typeof value !== 'object') {
      return
    }

    if (ancestors.has(value)) {
      return
    }

    ancestors.add(value)
    if (value instanceof Y.Map) {
      for (const [key, child] of value.entries()) {
        this.censusValue(blockId, child, path.length === 0 ? key : `${path}.${key}`, ancestors)
      }
    }
    else if (value instanceof Y.Array) {
      value.toArray().forEach((child, index) => {
        this.censusValue(blockId, child, `${path}.${index}`, ancestors)
      })
    }
    else if (Array.isArray(value)) {
      value.forEach((child, index) => this.censusValue(blockId, child, `${path}.${index}`, ancestors))
    }
    else if (!(value instanceof Y.AbstractType)) {
      for (const [key, child] of Object.entries(value)) {
        this.censusValue(blockId, child, path.length === 0 ? key : `${path}.${key}`, ancestors)
      }
    }
    ancestors.delete(value)
  }

  private deltaKey(source: TextSource, deltaIndex: number): string {
    return `${source.blockId}\0${source.property}\0${deltaIndex}`
  }

  private assertDisposition(disposition: CoverageDisposition, reason: string | undefined): void {
    if (!isCoverageDisposition(disposition)) {
      throw new CoverageError(`Unknown coverage disposition "${String(disposition)}" in document ${this.documentId}.`)
    }
    if (disposition === 'approved-loss' && (reason === undefined || reason.trim().length === 0)) {
      throw new CoverageError(`Approved-loss coverage in document ${this.documentId} requires a reason.`)
    }
  }

  private addRecord(key: string, item: CoverageItem, duplicateDescription: string): void {
    if (this.completedCoverage !== undefined) {
      throw new CoverageError(`Coverage ledger for document ${this.documentId} is already complete.`)
    }

    this.assertDisposition(item.disposition, item.reason)
    if (this.records.has(key)) {
      throw new CoverageError(`Duplicate ${duplicateDescription} in document ${this.documentId}.`)
    }

    this.records.set(key, item)
  }

  recordBlock(blockId: string, disposition: CoverageDisposition, reason?: string): void {
    if (!this.blockIds.has(blockId)) {
      throw new CoverageError(`Unknown source block "${blockId}" in document ${this.documentId}.`)
    }
    const item: BlockCoverageItem = reason === undefined
      ? { kind: 'block', blockId, disposition }
      : { kind: 'block', blockId, disposition, reason }
    this.addRecord(`block\0${blockId}`, item, `block "${blockId}"`)
  }

  recordRichTextDelta(text: Y.Text, deltaIndex: number, disposition: CoverageDisposition, reason?: string): void {
    const source = this.textSources.get(text)
    if (source === undefined) {
      throw new CoverageError(`Unknown rich-text source in document ${this.documentId}.`)
    }
    if (!Number.isInteger(deltaIndex) || deltaIndex < 0 || deltaIndex >= source.deltaCount) {
      throw new CoverageError(`Unknown rich-text delta ${source.blockId}:${source.property}:${deltaIndex}.`)
    }
    const item: RichTextDeltaCoverageItem = reason === undefined
      ? { kind: 'rich-text-delta', blockId: source.blockId, property: source.property, deltaIndex, disposition }
      : { kind: 'rich-text-delta', blockId: source.blockId, property: source.property, deltaIndex, disposition, reason }
    this.addRecord(
      this.deltaKey(source, deltaIndex),
      item,
      `rich-text delta "${source.blockId}:${source.property}:${deltaIndex}"`,
    )
  }

  recordRichText(text: Y.Text, disposition: CoverageDisposition, reason?: string): void {
    const source = this.textSources.get(text)
    if (source === undefined) {
      throw new CoverageError(`Unknown rich-text source in document ${this.documentId}.`)
    }

    for (let deltaIndex = 0; deltaIndex < source.deltaCount; deltaIndex += 1) {
      this.recordRichTextDelta(text, deltaIndex, disposition, reason)
    }
  }

  richTextSource(text: Y.Text): { readonly blockId: string, readonly property: string } {
    const source = this.textSources.get(text)
    if (source === undefined) {
      throw new CoverageError(`Unknown rich-text source in document ${this.documentId}.`)
    }

    return { blockId: source.blockId, property: source.property }
  }

  complete(): DocumentCoverage {
    if (this.completedCoverage !== undefined) {
      return this.completedCoverage
    }

    for (const blockId of [...this.blockIds].sort(compareText)) {
      if (!this.records.has(`block\0${blockId}`)) {
        throw new CoverageError(`Unaccounted block "${blockId}" in document ${this.documentId}.`)
      }
    }

    for (const source of this.textIdentities.values()) {
      for (let deltaIndex = 0; deltaIndex < source.deltaCount; deltaIndex += 1) {
        if (!this.records.has(this.deltaKey(source, deltaIndex))) {
          throw new CoverageError(
            `Unaccounted rich-text delta "${source.blockId}:${source.property}:${deltaIndex}" in document ${this.documentId}.`,
          )
        }
      }
    }

    const items = [...this.records.values()].sort(compareItems)
    const blocks = { total: 0, rendered: 0, structuralMetadataOnly: 0, approvedLoss: 0 }
    const richTextDeltas = { total: 0, rendered: 0, structuralMetadataOnly: 0, approvedLoss: 0 }
    for (const item of items) {
      const counts = item.kind === 'block' ? blocks : richTextDeltas
      counts.total += 1
      if (item.disposition === 'rendered') {
        counts.rendered += 1
      }
      else if (item.disposition === 'structural/metadata-only') {
        counts.structuralMetadataOnly += 1
      }
      else {
        counts.approvedLoss += 1
      }
    }

    this.completedCoverage = { documentId: this.documentId, blocks, richTextDeltas, items }
    return this.completedCoverage
  }
}
