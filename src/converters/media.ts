import type {
  AssetCollection,
  AssetManifestEntry,
  AssetRequest,
} from '../assets.ts'
import type { AffineBlock, BlockConversionContext } from './types.ts'
import {

  normalizeMimeType,
} from '../assets.ts'
import {
  escapeInlineCode,
  escapeMarkdownInlineText,
  escapeMarkdownUrl,
  escapeWikilinkAlias,
  escapeWikilinkTarget,
  normalizeExternalUrl,
} from '../markdown.ts'
import { BlockConversionError } from './types.ts'
import { mapValue } from './yjs.ts'

function requiredString(block: AffineBlock, property: string): string {
  const value = mapValue(block.source, property)
  if (typeof value !== 'string' || value.length === 0) {
    throw new BlockConversionError(
      `AFFiNE block ${block.id} (${block.flavour}) property ${property} must be a non-empty string.`,
    )
  }
  return value
}

function optionalString(block: AffineBlock, property: string): string | undefined {
  const value = mapValue(block.source, property)
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== 'string') {
    throw new BlockConversionError(
      `AFFiNE block ${block.id} (${block.flavour}) property ${property} must be a string or null.`,
    )
  }
  return value
}

function wikilink(path: string, alias?: string, embed = false): string {
  const target = escapeWikilinkTarget(path)
  const suffix = alias === undefined || alias.length === 0
    ? ''
    : `|${escapeWikilinkAlias(alias)}`
  return `${embed ? '!' : ''}[[${target}${suffix}]]`
}

function embedsInObsidian(asset: AssetManifestEntry): boolean {
  const mime = normalizeMimeType(asset.mime)
  return mime === 'application/pdf' || mime.startsWith('image/')
    || mime.startsWith('audio/') || mime.startsWith('video/')
}

/** Describe the blob needed by an image or attachment before extraction begins. */
export function mediaAssetRequest(block: AffineBlock): AssetRequest {
  if (block.flavour !== 'affine:image' && block.flavour !== 'affine:attachment') {
    throw new BlockConversionError(
      `AFFiNE block ${block.id} (${block.flavour}) does not reference an extractable asset.`,
    )
  }
  if (block.children.length > 0) {
    throw new BlockConversionError(`AFFiNE media block ${block.id} cannot have children.`)
  }
  const sourceId = requiredString(block, 'prop:sourceId')
  if (block.flavour === 'affine:attachment') {
    return { sourceId, name: requiredString(block, 'prop:name') }
  }
  const name = optionalString(block, 'prop:name')
  return { sourceId, name: name === undefined || name.length === 0 ? 'image' : name }
}

function convertAssetBlock(
  block: AffineBlock,
  context: BlockConversionContext,
  assets: AssetCollection,
): string {
  const request = mediaAssetRequest(block)
  const asset = assets.require(request.sourceId)
  if (asset.status === 'missing') {
    const kind = block.flavour === 'affine:image' ? 'image' : 'attachment'
    return [
      `> [!warning] Missing AFFiNE ${kind}`,
      `> Document: ${escapeInlineCode(context.documentId)}`,
      `> Source ID: ${escapeInlineCode(request.sourceId)}`,
    ].join('\n')
  }
  if (block.flavour === 'affine:image') {
    return wikilink(asset.path, optionalString(block, 'prop:caption'), true)
  }
  const embed = embedsInObsidian(asset)
  return wikilink(asset.path, embed ? undefined : request.name, embed)
}

function convertExternalLink(block: AffineBlock): string {
  const url = requiredString(block, 'prop:url')
  const title = optionalString(block, 'prop:title')
  const caption = optionalString(block, 'prop:caption')
  const label = title !== undefined && title.length > 0
    ? title
    : caption !== undefined && caption.length > 0 ? caption : url
  return `[${escapeMarkdownInlineText(label)}](${escapeMarkdownUrl(normalizeExternalUrl(url))})`
}

/** Convert one leaf media block against already extracted, validated assets. */
export function convertMediaBlock(
  block: AffineBlock,
  context: BlockConversionContext,
  assets: AssetCollection,
): string {
  if (block.children.length > 0) {
    throw new BlockConversionError(`AFFiNE media block ${block.id} cannot have children.`)
  }
  switch (block.flavour) {
    case 'affine:image':
    case 'affine:attachment':
      return convertAssetBlock(block, context, assets)
    case 'affine:bookmark':
    case 'affine:embed-youtube':
      return convertExternalLink(block)
    case 'affine:embed-linked-doc': {
      const pageId = requiredString(block, 'prop:pageId')
      const path = context.pages.requirePath(pageId)
      return wikilink(path, optionalString(block, 'prop:caption'), true)
    }
    default:
      throw new BlockConversionError(
        `Unsupported AFFiNE media block flavour "${block.flavour}" in block ${block.id} of document ${context.documentId}.`,
      )
  }
}
