import type * as Y from 'yjs'

export interface AffinePageMetadata {
  id: string
  title: string
  tags: string[]
  trash: boolean
  createDate?: number
  updatedDate?: number
  trashDate?: number
  /** AFFiNE page/edgeless display mode stored in page metadata. */
  primaryMode?: string
}

export interface AffineTagMetadata {
  id: string
  value: string
  color?: string
  createDate?: number
  updateDate?: number
}

export interface AffineWorkspaceMetadata {
  name?: string
  pages: AffinePageMetadata[]
  tags: AffineTagMetadata[]
  workspaceVersion?: number
  pageVersion?: number
  blockVersions: Record<string, number>
}

export interface AffineDocument {
  id: string
  doc: Y.Doc
  snapshotApplied: boolean
  updateCount: number
}

export interface LoadedAffineWorkspace {
  workspaceId: string
  metadata: AffineWorkspaceMetadata
  documents: ReadonlyMap<string, AffineDocument>
  destroy: () => void
}

export interface LoadAffineWorkspaceOptions {
  /** Parent directory in which the loader creates its private backup directory. */
  tempRoot?: string
}
