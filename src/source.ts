import type {
  AffineDocument,
  AffinePageMetadata,
  AffineTagMetadata,
  AffineWorkspaceMetadata,
  LoadAffineWorkspaceOptions,
  LoadedAffineWorkspace,
} from './types.ts'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'

import * as Y from 'yjs'

interface SnapshotRow {
  data: Uint8Array
}

interface UpdateRow {
  rowid: number
  data: Uint8Array
}

interface DocumentIdRow {
  doc_id: string
}

export class AffineSourceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AffineSourceError'
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AffineSourceError(`Workspace metadata field ${field} must be a non-empty string.`)
  }
  return value
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AffineSourceError(`Workspace metadata field ${field} must be a finite number.`)
  }
  return value
}

function parsePage(value: unknown, index: number): AffinePageMetadata {
  const page = asRecord(value)
  if (page === undefined) {
    throw new AffineSourceError(`Workspace metadata page ${index} must be an object.`)
  }

  const rawTags = page.tags ?? []
  if (!Array.isArray(rawTags) || rawTags.some(tag => typeof tag !== 'string')) {
    throw new AffineSourceError(`Workspace metadata page ${index} tags must be strings.`)
  }
  if (page.trash !== undefined && typeof page.trash !== 'boolean') {
    throw new AffineSourceError(`Workspace metadata page ${index} trash must be boolean.`)
  }
  if (page.title !== undefined && typeof page.title !== 'string') {
    throw new AffineSourceError(`Workspace metadata page ${index} title must be a string.`)
  }
  if (page.primaryMode !== undefined && typeof page.primaryMode !== 'string') {
    throw new AffineSourceError(`Workspace metadata page ${index} primaryMode must be a string.`)
  }

  const parsed: AffinePageMetadata = {
    id: requiredString(page.id, `pages[${index}].id`),
    title: page.title ?? '',
    tags: rawTags as string[],
    trash: page.trash ?? false,
  }
  const createDate = optionalNumber(page.createDate, `pages[${index}].createDate`)
  const updatedDate = optionalNumber(page.updatedDate, `pages[${index}].updatedDate`)
  const trashDate = optionalNumber(page.trashDate, `pages[${index}].trashDate`)
  if (createDate !== undefined) {
    parsed.createDate = createDate
  }
  if (updatedDate !== undefined) {
    parsed.updatedDate = updatedDate
  }
  if (trashDate !== undefined) {
    parsed.trashDate = trashDate
  }
  if (page.primaryMode !== undefined) {
    parsed.primaryMode = page.primaryMode
  }
  return parsed
}

function parseTag(value: unknown, index: number): AffineTagMetadata {
  const tag = asRecord(value)
  if (tag === undefined) {
    throw new AffineSourceError(`Workspace metadata tag ${index} must be an object.`)
  }
  if (tag.color !== undefined && typeof tag.color !== 'string') {
    throw new AffineSourceError(`Workspace metadata tag ${index} color must be a string.`)
  }

  const parsed: AffineTagMetadata = {
    id: requiredString(tag.id, `tags[${index}].id`),
    value: requiredString(tag.value, `tags[${index}].value`),
  }
  const createDate = optionalNumber(tag.createDate, `tags[${index}].createDate`)
  const updateDate = optionalNumber(tag.updateDate, `tags[${index}].updateDate`)
  if (tag.color !== undefined) {
    parsed.color = tag.color
  }
  if (createDate !== undefined) {
    parsed.createDate = createDate
  }
  if (updateDate !== undefined) {
    parsed.updateDate = updateDate
  }
  return parsed
}

function parseWorkspaceMetadata(doc: Y.Doc): AffineWorkspaceMetadata {
  if (!doc.share.has('meta')) {
    throw new AffineSourceError('AFFiNE workspace metadata is missing.')
  }
  const raw = asRecord(doc.getMap('meta').toJSON())
  if (raw === undefined || !Array.isArray(raw.pages)) {
    throw new AffineSourceError('AFFiNE workspace metadata must contain a pages array.')
  }

  const properties = asRecord(raw.properties)
  const tagCollection = properties === undefined ? undefined : asRecord(properties.tags)
  const rawTags = tagCollection?.options ?? []
  if (!Array.isArray(rawTags)) {
    throw new AffineSourceError('Workspace metadata tag options must be an array.')
  }

  const rawVersions = raw.blockVersions ?? {}
  const versionRecord = asRecord(rawVersions)
  if (versionRecord === undefined) {
    throw new AffineSourceError('Workspace metadata blockVersions must be an object.')
  }
  const blockVersions: Record<string, number> = {}
  for (const [flavour, version] of Object.entries(versionRecord)) {
    if (typeof version !== 'number' || !Number.isFinite(version)) {
      throw new AffineSourceError(`Block version for ${flavour} must be a finite number.`)
    }
    blockVersions[flavour] = version
  }
  if (raw.name !== undefined && typeof raw.name !== 'string') {
    throw new AffineSourceError('Workspace metadata name must be a string.')
  }

  const metadata: AffineWorkspaceMetadata = {
    pages: raw.pages.map(parsePage),
    tags: rawTags.map(parseTag),
    blockVersions,
  }
  const workspaceVersion = optionalNumber(raw.workspaceVersion, 'workspaceVersion')
  const pageVersion = optionalNumber(raw.pageVersion, 'pageVersion')
  if (raw.name !== undefined) {
    metadata.name = raw.name
  }
  if (workspaceVersion !== undefined) {
    metadata.workspaceVersion = workspaceVersion
  }
  if (pageVersion !== undefined) {
    metadata.pageVersion = pageVersion
  }
  return metadata
}

function workspaceId(database: DatabaseSync): string {
  let rows: unknown[]
  try {
    rows = database.prepare('SELECT space_id FROM meta').all()
  }
  catch (error) {
    throw new AffineSourceError('Could not read AFFiNE workspace metadata.', { cause: error })
  }
  if (rows.length !== 1) {
    throw new AffineSourceError('AFFiNE workspace metadata must contain exactly one space ID.')
  }
  return requiredString(asRecord(rows[0])?.space_id, 'space_id')
}

function applyDocumentUpdates(
  database: DatabaseSync,
  id: string,
): AffineDocument {
  const snapshot = database.prepare('SELECT data FROM snapshots WHERE doc_id = ?')
    .get(id) as SnapshotRow | undefined
  const doc = new Y.Doc({ guid: id })
  let updateCount = 0

  try {
    if (snapshot !== undefined) {
      try {
        Y.applyUpdate(doc, snapshot.data)
      }
      catch (error) {
        throw new AffineSourceError(
          `Could not decode Yjs snapshot for document ${id}: ${errorMessage(error)}`,
          { cause: error },
        )
      }
    }

    const updates = database.prepare(
      'SELECT rowid, data FROM updates WHERE doc_id = ? ORDER BY created_at ASC, rowid ASC',
    ).iterate(id) as Iterable<UpdateRow>
    for (const update of updates) {
      try {
        Y.applyUpdate(doc, update.data)
      }
      catch (error) {
        throw new AffineSourceError(
          `Could not decode Yjs update row ${update.rowid} for document ${id}: ${errorMessage(error)}`,
          { cause: error },
        )
      }
      updateCount += 1
    }
  }
  catch (error) {
    doc.destroy()
    throw error
  }

  return {
    id,
    doc,
    snapshotApplied: snapshot !== undefined,
    updateCount,
  }
}

export async function createConsistentBackup(
  sourcePath: string,
  destinationPath: string,
): Promise<void> {
  let source: DatabaseSync | undefined
  try {
    source = new DatabaseSync(sourcePath, { readOnly: true })
    await backup(source, destinationPath)
  }
  catch (error) {
    throw new AffineSourceError(
      `Could not create a consistent read-only SQLite backup: ${errorMessage(error)}`,
      { cause: error },
    )
  }
  finally {
    source?.close()
  }

  let copy: DatabaseSync | undefined
  try {
    copy = new DatabaseSync(destinationPath, { readOnly: true })
    const results = copy.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>
    if (results.length !== 1 || results[0]?.integrity_check !== 'ok') {
      const details = results.map(row => String(row.integrity_check)).join('; ')
      throw new AffineSourceError(`SQLite integrity check failed: ${details || 'no result'}.`)
    }
  }
  catch (error) {
    if (error instanceof AffineSourceError) {
      throw error
    }
    throw new AffineSourceError(`SQLite integrity check could not run: ${errorMessage(error)}`, {
      cause: error,
    })
  }
  finally {
    copy?.close()
  }
}

/** Decode an existing backup whose SQLite integrity has already been verified. */
function decodeAffineWorkspaceBackupSync(
  backupPath: string,
): LoadedAffineWorkspace {
  const database = new DatabaseSync(backupPath, { readOnly: true })
  const documents = new Map<string, AffineDocument>()
  try {
    const id = workspaceId(database)
    const documentIds = database.prepare(`
      SELECT doc_id FROM snapshots
      UNION
      SELECT doc_id FROM updates
      ORDER BY doc_id ASC
    `).all() as unknown as DocumentIdRow[]

    for (const row of documentIds) {
      documents.set(row.doc_id, applyDocumentUpdates(database, row.doc_id))
    }

    const workspaceDocument = documents.get(id)
    if (workspaceDocument === undefined) {
      throw new AffineSourceError(`AFFiNE workspace metadata document ${id} is missing.`)
    }
    const metadata = parseWorkspaceMetadata(workspaceDocument.doc)
    let destroyed = false
    return {
      workspaceId: id,
      metadata,
      documents,
      destroy: () => {
        if (destroyed) {
          return
        }
        destroyed = true
        for (const document of documents.values()) {
          document.doc.destroy()
        }
      },
    }
  }
  catch (error) {
    for (const document of documents.values()) {
      document.doc.destroy()
    }
    throw error
  }
  finally {
    database.close()
  }
}

/** Decode an existing backup whose SQLite integrity has already been verified. */
export async function decodeAffineWorkspaceBackup(backupPath: string): Promise<LoadedAffineWorkspace> {
  return Promise.resolve(decodeAffineWorkspaceBackupSync(backupPath))
}

export async function loadAffineWorkspace(
  sourcePath: string,
  options: LoadAffineWorkspaceOptions = {},
): Promise<LoadedAffineWorkspace> {
  const tempRoot = options.tempRoot ?? tmpdir()
  await mkdir(tempRoot, { recursive: true })
  const temporaryDirectory = await mkdtemp(join(tempRoot, 'affine-source-'))

  try {
    const backupPath = join(temporaryDirectory, 'storage.db')
    await createConsistentBackup(sourcePath, backupPath)
    return await decodeAffineWorkspaceBackup(backupPath)
  }
  finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}
