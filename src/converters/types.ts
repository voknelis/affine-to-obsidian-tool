import type * as Y from 'yjs'

import type { CoverageDisposition, DocumentCoverage, DocumentCoverageLedger } from '../coverage.ts'
import type { MissingGroupChildException } from '../migration-policy.ts'
import type { PageRegistry } from '../page-registry.ts'
import type { RichTextLoss } from '../richtext.ts'

/** A validated AFFiNE block; source properties remain typed as unknown until consumed. */
export interface AffineBlock {
  readonly id: string
  readonly flavour: string
  readonly children: readonly string[]
  readonly source: Y.Map<unknown>
}

/** Shared state available to every converter for one page document. */
export interface BlockConversionContext {
  readonly documentId: string
  readonly pages: PageRegistry
  readonly blocks: ReadonlyMap<string, AffineBlock>
  readonly losses: RichTextLoss[]
  readonly coverage?: DocumentCoverageLedger
  readonly allowMissingGroupChildren: readonly MissingGroupChildException[]
}
export interface DiagramAsset {
  readonly path: string
  readonly contents: string
}

export interface DatabaseConversionWarning {
  readonly kind: 'database-view-filter' | 'database-view-setting'
  readonly documentId: string
  readonly blockId: string
  readonly viewId: string
  readonly setting: string
  readonly value: unknown
  readonly reason: string
}

export interface MissingAssetConversionWarning {
  readonly kind: 'missing-asset'
  readonly documentId: string
  readonly blockId: string
  readonly sourceId: string
  readonly reason: string
}

export interface EdgelessMissingGroupChildWarning {
  readonly kind: 'edgeless-missing-group-child'
  readonly documentId: string
  readonly blockId: string
  readonly groupId: string
  readonly childId: string
  readonly reason: string
}

export type ConversionWarning = DatabaseConversionWarning | MissingAssetConversionWarning | EdgelessMissingGroupChildWarning

export interface ConvertedPage {
  readonly markdown: string
  readonly losses: readonly RichTextLoss[]
  readonly diagrams: readonly DiagramAsset[]
  readonly warnings: readonly ConversionWarning[]
  readonly coverage: DocumentCoverage
}

export type RenderBlockSequence = (ids: readonly string[], depth: number) => string

export interface ConvertedBlock {
  readonly markdown?: string
  readonly childDepth?: number
  readonly childrenHandled?: boolean
  readonly diagrams?: readonly DiagramAsset[]
  readonly warnings?: readonly ConversionWarning[]
  readonly disposition?: CoverageDisposition
  readonly dispositionReason?: string
  readonly consumedBlockIds?: readonly string[]
}

export type ConvertCustomBlock = (
  block: AffineBlock,
  context: BlockConversionContext,
  renderSequence: RenderBlockSequence,
) => ConvertedBlock

export class BlockConversionError extends Error {
  override readonly name = 'BlockConversionError'
}
