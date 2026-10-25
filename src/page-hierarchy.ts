import type { AffineDocument, LoadedAffineWorkspace } from './types.ts'

import * as Y from 'yjs'
import { mapValue, textDeltas } from './converters/yjs.ts'

import { compareCodeUnits } from './paths.ts'

export class PageHierarchyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PageHierarchyError'
  }
}

function requireDocument(workspace: LoadedAffineWorkspace, id: string): AffineDocument {
  const document = workspace.documents.get(id)
  if (document === undefined) {
    throw new PageHierarchyError(`AFFiNE page document ${id} is missing while building hierarchy.`)
  }
  return document
}

function createsCycle(
  childId: string,
  parentId: string,
  candidates: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  const seen = new Set([childId])
  const pending = [parentId]
  while (pending.length > 0) {
    const current = pending.pop()!
    if (current === childId) {
      return true
    }
    if (seen.has(current)) {
      continue
    }
    seen.add(current)
    for (const next of candidates.get(current) ?? []) {
      pending.push(next)
    }
  }
  return false
}

function collectLinkedPages(value: unknown, visit: (pageId: string) => void): void {
  if (value instanceof Y.Text) {
    for (const delta of textDeltas(value)) {
      const reference = delta.attributes?.reference
      if (
        typeof reference === 'object' && reference !== null
        && 'type' in reference && reference.type === 'LinkedPage'
        && 'pageId' in reference && typeof reference.pageId === 'string'
      ) {
        visit(reference.pageId)
      }
    }
    return
  }
  if (value instanceof Y.Map) {
    for (const child of value.values()) {
      collectLinkedPages(child, visit)
    }
    return
  }
  if (value instanceof Y.Array) {
    for (const child of value.toArray()) {
      collectLinkedPages(child, visit)
    }
  }
}

function collectParentCandidates(
  workspace: LoadedAffineWorkspace,
  order: ReadonlyMap<string, number>,
): Map<string, Set<string>> {
  const candidates = new Map<string, Set<string>>()
  const addCandidate = (sourceId: string, targetId: string): void => {
    if (sourceId === targetId || !order.has(targetId)) {
      return
    }
    const sources = candidates.get(targetId) ?? new Set<string>()
    sources.add(sourceId)
    candidates.set(targetId, sources)
  }

  for (const page of workspace.metadata.pages) {
    const document = requireDocument(workspace, page.id)
    if (!document.doc.share.has('blocks')) {
      throw new PageHierarchyError(`AFFiNE page ${page.id} has no blocks root for hierarchy inference.`)
    }
    for (const block of document.doc.getMap<unknown>('blocks').values()) {
      if (!(block instanceof Y.Map)) {
        continue
      }
      if (mapValue(block, 'sys:flavour') === 'affine:embed-linked-doc') {
        const target = mapValue(block, 'prop:pageId')
        if (typeof target === 'string') {
          addCandidate(page.id, target)
        }
      }
      collectLinkedPages(block, targetId => addCandidate(page.id, targetId))
    }
  }
  return candidates
}

function selectPageParents(
  workspace: LoadedAffineWorkspace,
  order: ReadonlyMap<string, number>,
  candidates: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, string> {
  const parents = new Map<string, string>()
  for (const page of workspace.metadata.pages) {
    const sources = [...(candidates.get(page.id) ?? [])].sort((left, right) => {
      const difference = (order.get(left) ?? -1) - (order.get(right) ?? -1)
      return difference !== 0 ? difference : compareCodeUnits(left, right)
    })
    for (const sourceId of sources) {
      if (!createsCycle(page.id, sourceId, candidates)) {
        parents.set(page.id, sourceId)
        break
      }
    }
  }
  return parents
}

/**
 * Treat the earliest referencing page in workspace metadata order as the parent.
 * Candidates are checked against the complete reference graph, so any edge
 * that would participate in a cycle is skipped before selection. Pages with
 * no viable parent remain roots and never recurse during path allocation.
 */
export function inferPageParents(workspace: LoadedAffineWorkspace): ReadonlyMap<string, string> {
  const order = new Map(workspace.metadata.pages.map((page, index) => [page.id, index]))
  const candidates = collectParentCandidates(workspace, order)
  return selectPageParents(workspace, order, candidates)
}
