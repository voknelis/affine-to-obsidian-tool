import type { AffinePageMetadata, AffineWorkspaceMetadata } from './types.ts'

import { REPORT_FILES } from './migration-policy.ts'
import { fitFilenameStem, sanitizeFilename, shortDocumentId, yamlString } from './paths.ts'

export interface RegisteredPage {
  id: string
  title: string
  outputPath: string
  frontmatter: string
  tags: string[]
  trash: boolean
}

export class PageRegistryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PageRegistryError'
  }
}

export class PageRegistry {
  readonly pages: readonly RegisteredPage[]
  private readonly byId: ReadonlyMap<string, RegisteredPage>

  constructor(pages: readonly RegisteredPage[]) {
    this.pages = pages
    this.byId = new Map(pages.map(page => [page.id, page]))
  }

  get(documentId: string): RegisteredPage | undefined {
    return this.byId.get(documentId)
  }

  require(documentId: string): RegisteredPage {
    const page = this.get(documentId)
    if (page === undefined) {
      throw new PageRegistryError(`Unknown AFFiNE page ID: ${documentId}`)
    }
    return page
  }

  requirePath(documentId: string): string {
    return this.require(documentId).outputPath
  }
}

function outputKey(path: string): string {
  return path.normalize('NFC').toLowerCase()
}

const EMPTY_PARENTS: ReadonlyMap<string, string> = new Map()

function validateParents(
  pageIds: ReadonlySet<string>,
  parents: ReadonlyMap<string, string>,
): void {
  for (const [childId, parentId] of parents) {
    if (!pageIds.has(childId)) {
      throw new PageRegistryError(`Hierarchy references unknown child page ID: ${childId}`)
    }
    if (!pageIds.has(parentId)) {
      throw new PageRegistryError(`Hierarchy references unknown parent page ID: ${parentId}`)
    }
  }
  for (const pageId of pageIds) {
    const seen = new Set<string>()
    let current = pageId
    for (;;) {
      if (seen.has(current)) {
        throw new PageRegistryError(`AFFiNE page hierarchy contains a cycle at ${current}.`)
      }
      seen.add(current)
      const parentId = parents.get(current)
      if (parentId === undefined) {
        break
      }
      current = parentId
    }
  }
}

interface CollisionState {
  readonly stems: Set<string>
  readonly files: Set<string>
  readonly directories: Set<string>
}

function allocateStem(
  page: AffinePageMetadata,
  parentId: string | undefined,
  container: boolean,
  state: CollisionState,
  containerNoteConflicts: (candidate: string) => boolean,
): string {
  const stem = sanitizeFilename(page.title, page.id, '.md')
  const key = (candidate: string): string => outputKey(`${candidate}.md`)
  const appendSuffix = (suffix: string): string =>
    `${fitFilenameStem(stem, `${suffix}.md`)}${suffix}`.replace(/[. ]+$/u, '')
  const rootActive = parentId === undefined && !page.trash
  const conflicts = (candidate: string): boolean => {
    if (state.stems.has(key(candidate))) {
      return true
    }
    const pathKey = container ? outputKey(candidate) : key(candidate)
    if (state.files.has(pathKey) || state.directories.has(pathKey)) {
      return true
    }
    if (container && containerNoteConflicts(candidate)) {
      return true
    }
    if (!rootActive) {
      return false
    }
    if (container && (outputKey(candidate) === 'assets' || outputKey(candidate) === '_trash')) {
      return true
    }
    return !container && REPORT_FILES.some(file => outputKey(file) === key(candidate))
  }

  let candidateStem = stem
  let uniqueSuffix = ''
  if (conflicts(candidateStem)) {
    uniqueSuffix = `--${shortDocumentId(page.id)}`
    candidateStem = appendSuffix(uniqueSuffix)
  }
  if (conflicts(candidateStem)) {
    // eslint-disable-next-line no-control-regex -- ID sanitization intentionally replaces control characters.
    const id = page.id.replace(/[<>:"/\\|?*\u0000-\u001F\u007F-\u009F]/gu, '_')
    uniqueSuffix = `--${id}`
    candidateStem = appendSuffix(uniqueSuffix)
  }
  let sequence = 2
  while (conflicts(candidateStem)) {
    const sequenceSuffix = `${uniqueSuffix}--${sequence}`
    candidateStem = appendSuffix(sequenceSuffix)
    sequence += 1
  }

  state.stems.add(key(candidateStem))
  if (container) {
    state.directories.add(outputKey(candidateStem))
  }
  else {
    state.files.add(key(candidateStem))
  }
  return candidateStem
}

function isoDate(value: number, field: string, documentId: string): string {
  try {
    return new Date(value).toISOString()
  }
  catch (error) {
    throw new PageRegistryError(
      `Invalid ${field} for AFFiNE page ${documentId}.`,
      { cause: error },
    )
  }
}

function frontmatter(
  page: AffinePageMetadata,
  tags: readonly string[],
): string {
  const lines = [
    '---',
    `title: ${yamlString(page.title)}`,
    `affine_id: ${yamlString(page.id)}`,
  ]
  if (page.createDate !== undefined) {
    lines.push(`created: ${isoDate(page.createDate, 'createDate', page.id)}`)
  }
  if (page.updatedDate !== undefined) {
    lines.push(`updated: ${isoDate(page.updatedDate, 'updatedDate', page.id)}`)
  }
  lines.push(`trash: ${page.trash}`)
  if (page.trashDate !== undefined) {
    lines.push(`trash_date: ${isoDate(page.trashDate, 'trashDate', page.id)}`)
  }
  if (page.primaryMode !== undefined) {
    lines.push(`affine_primary_mode: ${yamlString(page.primaryMode)}`)
  }
  lines.push(`tags: [${tags.map(yamlString).join(', ')}]`, '---', '')
  return lines.join('\n')
}

function collectTagLabels(metadata: AffineWorkspaceMetadata): Map<string, string> {
  const tagLabels = new Map<string, string>()
  for (const tag of metadata.tags) {
    if (tagLabels.has(tag.id)) {
      throw new PageRegistryError(`Duplicate AFFiNE tag ID: ${tag.id}`)
    }
    tagLabels.set(tag.id, tag.value)
  }
  return tagLabels
}

function collectPageIds(metadata: AffineWorkspaceMetadata): Set<string> {
  const pageIds = new Set<string>()
  for (const page of metadata.pages) {
    if (pageIds.has(page.id)) {
      throw new PageRegistryError(`Duplicate AFFiNE page ID: ${page.id}`)
    }
    pageIds.add(page.id)
  }
  return pageIds
}

function groupChildren(
  sortedPages: readonly AffinePageMetadata[],
  parents: ReadonlyMap<string, string>,
): Map<string, AffinePageMetadata[]> {
  const children = new Map<string, AffinePageMetadata[]>()
  for (const page of sortedPages) {
    const parentId = parents.get(page.id)
    if (parentId === undefined) {
      continue
    }
    const siblings = children.get(parentId) ?? []
    siblings.push(page)
    children.set(parentId, siblings)
  }
  return children
}

function allocateOutputPaths(
  sortedPages: readonly AffinePageMetadata[],
  parents: ReadonlyMap<string, string>,
  children: ReadonlyMap<string, readonly AffinePageMetadata[]>,
): Map<string, string> {
  const outputPaths = new Map<string, string>()
  const directories = new Map<string, string>()
  const collisionStates = new Map<string, CollisionState>()
  const stateFor = (directory: string): CollisionState => {
    const key = outputKey(directory)
    const existing = collisionStates.get(key)
    if (existing !== undefined) {
      return existing
    }
    const state: CollisionState = {
      stems: new Set<string>(),
      files: new Set<string>(),
      directories: new Set<string>(),
    }
    collisionStates.set(key, state)
    return state
  }
  const allocate = (page: AffinePageMetadata): void => {
    const parentId = parents.get(page.id)
    const parentDirectory = parentId === undefined ? '' : directories.get(parentId)
    if (parentDirectory === undefined) {
      throw new PageRegistryError(`Parent path for ${parentId} was not allocated before ${page.id}.`)
    }
    const container = children.has(page.id)
    const containingDirectory = `${page.trash ? '_trash/' : ''}${parentDirectory}`
    const state = stateFor(containingDirectory)
    const containerNoteConflicts = (candidate: string): boolean => {
      const directory = parentDirectory.length > 0 ? `${parentDirectory}/${candidate}` : candidate
      const childDirectory = `${page.trash ? '_trash/' : ''}${directory}`
      const childState = collisionStates.get(outputKey(childDirectory))
      const noteKey = outputKey(`${candidate}.md`)
      if (childState === undefined) {
        return false
      }
      return childState.stems.has(noteKey)
        || childState.files.has(noteKey)
        || childState.directories.has(noteKey)
    }
    const stem = allocateStem(page, parentId, container, state, containerNoteConflicts)
    const directory = parentDirectory.length > 0 ? `${parentDirectory}/${stem}` : stem
    const relativePath = container ? `${directory}/${stem}.md` : `${directory}.md`
    outputPaths.set(page.id, `${page.trash ? '_trash/' : ''}${relativePath}`)
    directories.set(page.id, container ? directory : parentDirectory)
    if (container) {
      const noteState = stateFor(`${page.trash ? '_trash/' : ''}${directory}`)
      const noteKey = outputKey(`${stem}.md`)
      noteState.stems.add(noteKey)
      noteState.files.add(noteKey)
    }
    for (const child of children.get(page.id) ?? []) {
      allocate(child)
    }
  }

  // Parent-first traversal assigns deterministic sibling names before note paths.
  for (const page of sortedPages) {
    if (!parents.has(page.id)) {
      allocate(page)
    }
  }
  if (outputPaths.size !== sortedPages.length) {
    throw new PageRegistryError('Not every AFFiNE page received an output path.')
  }
  return outputPaths
}

function registerPages(
  sortedPages: readonly AffinePageMetadata[],
  tagLabels: ReadonlyMap<string, string>,
  outputPaths: ReadonlyMap<string, string>,
): PageRegistry {
  return new PageRegistry(sortedPages.map((page) => {
    const tags = page.tags.map((tagId) => {
      const label = tagLabels.get(tagId)
      if (label === undefined) {
        throw new PageRegistryError(`Unknown AFFiNE tag ID: ${tagId}`)
      }
      return label
    })
    const outputPath = outputPaths.get(page.id)
    if (outputPath === undefined) {
      throw new PageRegistryError(`Missing output path for page ${page.id}.`)
    }
    return {
      id: page.id,
      title: page.title,
      outputPath,
      frontmatter: frontmatter(page, tags),
      tags,
      trash: page.trash,
    }
  }))
}

/**
 * Allocate every output path before exposing page metadata, so later converters
 * always resolve links against the final deterministic registry.
 */
export function buildPageRegistry(
  metadata: AffineWorkspaceMetadata,
  parents: ReadonlyMap<string, string> = EMPTY_PARENTS,
): PageRegistry {
  const tagLabels = collectTagLabels(metadata)
  validateParents(collectPageIds(metadata), parents)
  const sortedPages = [...metadata.pages].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  )
  const children = groupChildren(sortedPages, parents)
  const outputPaths = allocateOutputPaths(sortedPages, parents, children)
  return registerPages(sortedPages, tagLabels, outputPaths)
}
