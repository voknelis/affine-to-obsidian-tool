import type { AssetCollection, AssetManifestEntry, MissingAssetReference } from './assets.ts'
import type { ConversionWarning } from './converters/types.ts'
import type {
  BlockCoverageItem,
  CoverageDisposition,
  DocumentCoverage,
  RichTextDeltaCoverageItem,
} from './coverage.ts'
import type { MissingGroupChildException } from './migration-policy.ts'

import type { PageRegistry } from './page-registry.ts'
import type { DocumentConversionLoss } from './report.ts'
import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { isCoverageDisposition } from './coverage.ts'
import { allowsMissingGroupChild, REPORT_FILES } from './migration-policy.ts'

import { compareCodeUnits } from './paths.ts'
import { createMigrationReport, createMigrationReportInput, renderMigrationMarkdown } from './report.ts'

export interface ValidateOutputOptions {
  readonly outputDirectory: string
  readonly workspaceId: string
  readonly sourceFingerprint: string
  readonly pages: PageRegistry
  readonly assets: AssetCollection
  readonly coverage: readonly DocumentCoverage[]
  readonly expectedNotes: ReadonlyMap<string, string>
  readonly expectedDiagrams: ReadonlyMap<string, string>
  readonly allowMissing?: Iterable<string>
  readonly allowMissingGroupChildren?: readonly MissingGroupChildException[]
  readonly warnings?: readonly ConversionWarning[]
  readonly conversionLosses?: readonly DocumentConversionLoss[]
  readonly missingAssetReferences?: readonly MissingAssetReference[]
}

export interface OutputValidationSummary {
  readonly files: number
  readonly pages: number
  readonly assetFiles: number
  readonly warnings: number
}

export class OutputValidationError extends Error {
  override readonly name = 'OutputValidationError'
}

async function outputFiles(root: string, directory = ''): Promise<string[]> {
  const entries = await readdir(join(root, directory), { withFileTypes: true })
  entries.sort((left, right) => compareCodeUnits(left.name, right.name))

  const files: string[] = []
  for (const entry of entries) {
    const relative = directory.length === 0 ? entry.name : `${directory}/${entry.name}`
    if (entry.isSymbolicLink()) {
      throw new OutputValidationError(`Symbolic link output is forbidden: ${relative}.`)
    }

    if (entry.isDirectory()) {
      files.push(...await outputFiles(root, relative))
    }
    else if (entry.isFile()) {
      files.push(relative)
    }
    else {
      throw new OutputValidationError(`Unsupported output filesystem entry: ${relative}.`)
    }
  }

  return files
}

function safeRelativePath(path: string, description: string): string {
  if (path.length === 0 || path.includes('\\') || posix.isAbsolute(path) || posix.normalize(path) !== path
    || path === '..' || path.startsWith('../') || path.includes('/../')) {
    throw new OutputValidationError(`Unsafe ${description} path "${path}".`)
  }
  return path
}

interface MutableCoverageCounts {
  total: number
  rendered: number
  structuralMetadataOnly: number
  approvedLoss: number
}

function addItem(counts: MutableCoverageCounts, disposition: CoverageDisposition): void {
  counts.total += 1
  if (disposition === 'rendered') {
    counts.rendered += 1
  }
  else if (disposition === 'structural/metadata-only') {
    counts.structuralMetadataOnly += 1
  }
  else {
    counts.approvedLoss += 1
  }
}

function validateCoverageCounts(coverage: DocumentCoverage): void {
  const blocks: MutableCoverageCounts = { total: 0, rendered: 0, structuralMetadataOnly: 0, approvedLoss: 0 }
  const richTextDeltas: MutableCoverageCounts = { total: 0, rendered: 0, structuralMetadataOnly: 0, approvedLoss: 0 }
  const identities = new Set<string>()
  for (const item of coverage.items) {
    const disposition = item.disposition
    if (!isCoverageDisposition(disposition)) {
      throw new OutputValidationError(`Coverage for ${coverage.documentId} has an unknown disposition.`)
    }
    let identity: string
    if (item.kind === 'block') {
      identity = `block\0${item.blockId}`
      addItem(blocks, disposition)
    }
    else if (item.kind === 'rich-text-delta') {
      if (item.property.length === 0 || !Number.isInteger(item.deltaIndex) || item.deltaIndex < 0) {
        throw new OutputValidationError(`Coverage for ${coverage.documentId} has an invalid rich-text delta identity.`)
      }
      identity = `delta\0${item.blockId}\0${item.property}\0${item.deltaIndex}`
      addItem(richTextDeltas, disposition)
    }
    else {
      throw new OutputValidationError(`Coverage for ${coverage.documentId} has an unknown item kind.`)
    }
    if (identities.has(identity)) {
      throw new OutputValidationError(`Duplicate coverage item in document ${coverage.documentId}.`)
    }
    identities.add(identity)
  }
  if (blocks.total !== coverage.blocks.total || blocks.rendered !== coverage.blocks.rendered
    || blocks.structuralMetadataOnly !== coverage.blocks.structuralMetadataOnly
    || blocks.approvedLoss !== coverage.blocks.approvedLoss
    || richTextDeltas.total !== coverage.richTextDeltas.total
    || richTextDeltas.rendered !== coverage.richTextDeltas.rendered
    || richTextDeltas.structuralMetadataOnly !== coverage.richTextDeltas.structuralMetadataOnly
    || richTextDeltas.approvedLoss !== coverage.richTextDeltas.approvedLoss) {
    throw new OutputValidationError(`Coverage for ${coverage.documentId} has inconsistent counts.`)
  }
}

function separator(value: string, characters: readonly string[]): number {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '\\') {
      index += 1
    }
    else if (characters.includes(value[index] ?? '')) {
      return index
    }
  }

  return -1
}

function wikilinkTarget(inner: string): string {
  const alias = separator(inner, ['|'])
  const tableAlias = alias === -1 ? inner.indexOf('\\|') : alias
  const withoutAlias = tableAlias === -1 ? inner : inner.slice(0, tableAlias)
  const fragment = separator(withoutAlias, ['#', '^'])
  const target = fragment === -1 ? withoutAlias : withoutAlias.slice(0, fragment)
  return target.replace(/\\(.)/gu, '$1')
}

function markdownDestination(destination: string): string {
  const value = destination.startsWith('<') && destination.endsWith('>')
    ? destination.slice(1, -1)
    : destination
  return value.split('#', 1)[0] ?? ''
}

function maskRange(characters: string[], start: number, end: number): void {
  for (let index = start; index < end; index += 1) {
    if (characters[index] !== '\n' && characters[index] !== '\r') {
      characters[index] = ' '
    }
  }
}

function escapedBacktick(markdown: string, index: number): boolean {
  let backslashes = 0
  for (let cursor = index - 1; cursor >= 0 && markdown[cursor] === '\\'; cursor -= 1) {
    backslashes += 1
  }

  return backslashes % 2 === 1
}

/** Blank YAML and code without moving offsets, then scan only actual Markdown links. */
function linkScanningMarkdown(markdown: string): string {
  const characters = markdown.split('')
  const frontmatter = /^---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/u.exec(markdown)
  const frontmatterLength = frontmatter?.[0].length ?? 0
  maskRange(characters, 0, frontmatterLength)

  let fence: { readonly marker: string, readonly length: number } | undefined
  let offset = 0
  for (const line of markdown.split(/(?<=\n)/u)) {
    const content = line.replace(/\r?\n$/u, '')
    if (offset >= frontmatterLength) {
      const fenceMatch = /^[ \t]*(`+|~+)/u.exec(content)
      const run = fenceMatch?.[1]
      if (fence !== undefined) {
        maskRange(characters, offset, offset + line.length)
        if (run !== undefined && run[0] === fence.marker && run.length >= fence.length
          && /^[ \t]*(?:`+|~+)[ \t]*\r?$/u.test(content)) {
          fence = undefined
        }
      }
      else if (run !== undefined && run.length >= 3) {
        fence = { marker: run[0] ?? '`', length: run.length }
        maskRange(characters, offset, offset + line.length)
      }
    }
    offset += line.length
  }

  const maskedMarkdown = characters.join('')
  let index = frontmatterLength
  while (index < maskedMarkdown.length) {
    if (maskedMarkdown[index] !== '`' || escapedBacktick(maskedMarkdown, index)) {
      index += 1
      continue
    }

    const start = index
    while (maskedMarkdown[index] === '`') {
      index += 1
    }

    const delimiterLength = index - start
    let closing = index
    while (closing < maskedMarkdown.length) {
      if (maskedMarkdown[closing] !== '`') {
        closing += 1
        continue
      }

      const closingStart = closing
      while (maskedMarkdown[closing] === '`') {
        closing += 1
      }

      if (closing - closingStart === delimiterLength) {
        break
      }
    }

    if (closing < maskedMarkdown.length) {
      maskRange(characters, start, closing)
      index = closing
    }
  }
  return characters.join('')
}

function validateInternalLinks(markdown: string, notePath: string, linkableFiles: ReadonlySet<string>): void {
  const targets: string[] = []
  const scannable = linkScanningMarkdown(markdown)
  for (const match of scannable.matchAll(/!?\[\[((?:\\.|(?!\]\]).)*)\]\]/gu)) {
    const target = wikilinkTarget(match[1] ?? '')
    if (target.length > 0) {
      targets.push(target)
    }
  }
  for (const match of scannable.matchAll(/\[[^\]\n]*\]\((<[^>\n]+>|[^)\s]+)\)/gu)) {
    const destination = markdownDestination(match[1] ?? '')
    if (destination.length === 0 || destination.startsWith('#') || destination.startsWith('//')
      || /^[a-z][a-z0-9+.-]*:/iu.test(destination)) { continue }
    if (destination.startsWith('/')) {
      throw new OutputValidationError(`Absolute internal target "${destination}" in ${notePath}.`)
    }
    targets.push(posix.normalize(posix.join(posix.dirname(notePath), destination)))
  }
  for (const target of targets) {
    safeRelativePath(target, `internal target in ${notePath}`)
    const noteTarget = target.toLowerCase().endsWith('.md') ? target : `${target}.md`
    if (!linkableFiles.has(target) && !linkableFiles.has(noteTarget)) {
      throw new OutputValidationError(`Unresolved internal target "${target}" in ${notePath}.`)
    }
  }
}

function validateWarnings(
  warnings: readonly ConversionWarning[],
  pages: PageRegistry,
  coverage: ReadonlyMap<string, DocumentCoverage>,
  missingIds: ReadonlySet<string>,
  allowMissing: ReadonlySet<string>,
  allowMissingGroupChildren: readonly MissingGroupChildException[],
): void {
  for (const warning of warnings) {
    const kind: unknown = warning.kind
    if (kind !== 'missing-asset' && kind !== 'database-view-filter' && kind !== 'database-view-setting'
      && kind !== 'edgeless-missing-group-child') {
      throw new OutputValidationError(`Unapproved conversion warning kind "${String(kind)}".`)
    }
    if (pages.get(warning.documentId) === undefined) {
      throw new OutputValidationError(`Conversion warning references unknown document "${warning.documentId}".`)
    }
    const block = coverage.get(warning.documentId)?.items.find(item => item.kind === 'block' && item.blockId === warning.blockId)
    if (block === undefined) {
      throw new OutputValidationError(`Conversion warning references uncovered block "${warning.blockId}".`)
    }
    if ((warning.kind === 'missing-asset' || warning.kind === 'database-view-filter'
      || warning.kind === 'database-view-setting') && block.disposition !== 'approved-loss') {
      throw new OutputValidationError(
        `${warning.kind} warning for ${warning.documentId}/${warning.blockId} requires approved-loss coverage.`,
      )
    }
    if (warning.kind === 'missing-asset'
      && (!missingIds.has(warning.sourceId) || !allowMissing.has(warning.sourceId))) {
      throw new OutputValidationError(`Unapproved missing-asset warning "${warning.sourceId}".`)
    }
    if (warning.kind === 'edgeless-missing-group-child'
      && !allowsMissingGroupChild(
        allowMissingGroupChildren,
        warning.documentId,
        warning.blockId,
        warning.groupId,
        warning.childId,
      )) {
      throw new OutputValidationError('Unapproved edgeless-missing-group-child warning identity.')
    }
  }
}

function addLossAuthorization(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1)
}

function missingReferenceKey(reference: MissingAssetReference): string {
  return `${reference.documentId}\0${reference.blockId}\0${reference.sourceId}`
}

function reconcileApprovedLossBlock(
  document: DocumentCoverage,
  item: BlockCoverageItem,
  authorizedBlocks: ReadonlySet<string>,
  usedBlockAuthorizations: Set<string>,
): void {
  const missingPrefix = 'Approved missing asset '
  const sourceId = item.reason?.startsWith(missingPrefix) === true
    ? item.reason.slice(missingPrefix.length)
    : undefined
  if (sourceId !== undefined) {
    const authorization = `missing-asset\0${document.documentId}\0${item.blockId}\0${sourceId}`
    if (sourceId.length === 0 || !authorizedBlocks.has(authorization)) {
      throw new OutputValidationError(
        `Missing-asset loss ${document.documentId}/${item.blockId} for "${sourceId}" requires its specific missing-asset warning.`,
      )
    }

    usedBlockAuthorizations.add(authorization)
    return
  }

  const authorizations = ['database-view-filter', 'database-view-setting']
    .map(kind => `${kind}\0${document.documentId}\0${item.blockId}`)
    .filter(key => authorizedBlocks.has(key))
  if (authorizations.length === 0) {
    throw new OutputValidationError(
      `Unexplained approved-loss block ${document.documentId}/${item.blockId}.`,
    )
  }

  for (const authorization of authorizations) {
    usedBlockAuthorizations.add(authorization)
  }
}

function reconcileApprovedLossDelta(
  document: DocumentCoverage,
  item: RichTextDeltaCoverageItem,
  expectedLosses: Map<string, number>,
): void {
  const seen = new Set<string>()
  for (const segment of (item.reason ?? '').split(';')) {
    const reason = /^(visual-color|visual-formatting):([a-z]+(?:,[a-z]+)*)$/u.exec(segment)
    if (reason === null) {
      throw new OutputValidationError(
        `Unexplained approved-loss rich-text delta ${document.documentId}/${item.blockId}/${item.property}/${item.deltaIndex}.`,
      )
    }

    const kind = reason[1]
    const attributes = reason[2]?.split(',') ?? []
    for (const attribute of attributes) {
      const supported = kind === 'visual-color'
        ? attribute === 'color' || attribute === 'background'
        : attribute === 'bold' || attribute === 'italic' || attribute === 'underline' || attribute === 'strike'
      if (!supported) {
        throw new OutputValidationError(`Unapproved ${kind} attribute "${attribute}".`)
      }

      const authorization = `${kind}:${attribute}`
      if (seen.has(authorization)) {
        throw new OutputValidationError(`Duplicate loss authorization for ${document.documentId}/${item.blockId}.`)
      }

      seen.add(authorization)
      addLossAuthorization(expectedLosses, `${document.documentId}\0${item.blockId}\0${item.property}\0${item.deltaIndex}\0${kind}\0${attribute}`)
    }
  }
}

function collectApprovedLosses(
  coverage: ReadonlyMap<string, DocumentCoverage>,
  authorizedBlocks: ReadonlySet<string>,
): {
  expectedLosses: Map<string, number>
  usedBlockAuthorizations: Set<string>
} {
  const expectedLosses = new Map<string, number>()
  const usedBlockAuthorizations = new Set<string>()
  for (const document of coverage.values()) {
    for (const item of document.items) {
      if (item.disposition !== 'approved-loss') {
        continue
      }

      if (item.kind === 'block') {
        reconcileApprovedLossBlock(document, item, authorizedBlocks, usedBlockAuthorizations)
      }
      else {
        reconcileApprovedLossDelta(document, item, expectedLosses)
      }
    }
  }

  return { expectedLosses, usedBlockAuthorizations }
}

function validateUsedBlockAuthorizations(
  authorizedBlocks: ReadonlySet<string>,
  usedBlockAuthorizations: ReadonlySet<string>,
): void {
  for (const authorization of authorizedBlocks) {
    if (!usedBlockAuthorizations.has(authorization)) {
      throw new OutputValidationError(`Conversion warning does not reconcile with an approved-loss block: "${authorization.split('\0')[0]}".`)
    }
  }
}

function validateMissingReferences(
  coverage: ReadonlyMap<string, DocumentCoverage>,
  warnings: readonly ConversionWarning[],
  missingIds: ReadonlySet<string>,
  missingReferences: readonly MissingAssetReference[],
): void {
  const expectedMissingReferences = new Map<string, MissingAssetReference>()
  for (const reference of missingReferences) {
    if (reference.documentId.length === 0 || reference.blockId.length === 0 || reference.sourceId.length === 0
      || !missingIds.has(reference.sourceId)) {
      throw new OutputValidationError('Expected missing-asset reference has an invalid source identity.')
    }

    const block = coverage.get(reference.documentId)?.items.find(item => item.kind === 'block' && item.blockId === reference.blockId)
    if (block === undefined) {
      throw new OutputValidationError(
        `Expected missing-asset reference ${reference.documentId}/${reference.blockId} is not covered.`,
      )
    }

    const key = missingReferenceKey(reference)
    if (expectedMissingReferences.has(key)) {
      throw new OutputValidationError(`Duplicate expected missing-asset reference ${reference.documentId}/${reference.blockId}.`)
    }

    expectedMissingReferences.set(key, reference)
  }

  const missingWarningCounts = new Map<string, number>()
  for (const warning of warnings) {
    if (warning.kind === 'missing-asset') {
      addLossAuthorization(missingWarningCounts, missingReferenceKey(warning))
    }
  }

  for (const [key, reference] of expectedMissingReferences) {
    const received = missingWarningCounts.get(key) ?? 0
    if (received !== 1) {
      throw new OutputValidationError(
        `Missing asset "${reference.sourceId}" reference ${reference.documentId}/${reference.blockId} requires exactly one missing-asset warning; received ${received}.`,
      )
    }
  }

  for (const key of missingWarningCounts.keys()) {
    if (!expectedMissingReferences.has(key)) {
      throw new OutputValidationError('Missing-asset warning has no expected source reference.')
    }
  }

  for (const sourceId of missingIds) {
    if (![...expectedMissingReferences.values()].some(reference => reference.sourceId === sourceId)) {
      throw new OutputValidationError(`Missing asset "${sourceId}" has no expected source references.`)
    }
  }
}

function reconcileConversionLosses(
  coverage: ReadonlyMap<string, DocumentCoverage>,
  conversionLosses: readonly DocumentConversionLoss[],
  expectedLosses: ReadonlyMap<string, number>,
): void {
  const actualLosses = new Map<string, number>()
  for (const loss of conversionLosses) {
    if (!coverage.has(loss.documentId)) {
      throw new OutputValidationError(`Conversion loss references unknown document "${loss.documentId}".`)
    }

    const supportedLoss = (loss.kind === 'visual-color'
      && (loss.attribute === 'color' || loss.attribute === 'background'))
    || (loss.kind === 'visual-formatting'
      && (loss.attribute === 'bold' || loss.attribute === 'italic'
        || loss.attribute === 'underline' || loss.attribute === 'strike') && loss.value === 'true')
    if (!supportedLoss) {
      throw new OutputValidationError(`Unapproved conversion loss kind "${String(loss.kind)}".`)
    }

    if (typeof loss.blockId !== 'string' || typeof loss.property !== 'string'
      || !Number.isInteger(loss.deltaIndex) || (loss.deltaIndex ?? -1) < 0) {
      throw new OutputValidationError('Conversion loss is missing its rich-text source identity.')
    }

    addLossAuthorization(actualLosses, `${loss.documentId}\0${loss.blockId}\0${loss.property}\0${loss.deltaIndex}\0${loss.kind}\0${loss.attribute}`)
  }

  for (const key of new Set([...expectedLosses.keys(), ...actualLosses.keys()])) {
    if (expectedLosses.get(key) !== actualLosses.get(key)) {
      throw new OutputValidationError(`Conversion losses do not reconcile with approved-loss coverage for "${key.split('\0')[0]}".`)
    }
  }
}

function validateApprovedLosses(
  coverage: ReadonlyMap<string, DocumentCoverage>,
  warnings: readonly ConversionWarning[],
  conversionLosses: readonly DocumentConversionLoss[],
  missingIds: ReadonlySet<string>,
  missingReferences: readonly MissingAssetReference[],
): void {
  const authorizedBlocks = new Set(warnings
    .filter(warning => warning.kind !== 'edgeless-missing-group-child')
    .map(warning => warning.kind === 'missing-asset'
      ? `missing-asset\0${warning.documentId}\0${warning.blockId}\0${warning.sourceId}`
      : `${warning.kind}\0${warning.documentId}\0${warning.blockId}`))
  const { expectedLosses, usedBlockAuthorizations } = collectApprovedLosses(coverage, authorizedBlocks)
  validateUsedBlockAuthorizations(authorizedBlocks, usedBlockAuthorizations)
  validateMissingReferences(coverage, warnings, missingIds, missingReferences)
  reconcileConversionLosses(coverage, conversionLosses, expectedLosses)
}

interface ExpectedOutput {
  readonly allowedFiles: ReadonlySet<string>
  readonly assetPaths: readonly string[]
  readonly availableAssets: readonly AssetManifestEntry[]
  readonly diagramPaths: readonly string[]
  readonly pagePaths: readonly string[]
}

async function validateOutputFiles(outputDirectory: string): Promise<string[]> {
  const files = await outputFiles(outputDirectory)
  if (files.length === 0) {
    throw new OutputValidationError('Output contains zero files.')
  }

  for (const path of files) {
    if ((await stat(join(outputDirectory, path))).size === 0) {
      throw new OutputValidationError(`Zero-length output file: ${path}.`)
    }
  }

  return files
}

function collectExpectedOutput(options: ValidateOutputOptions): ExpectedOutput {
  const diagramPaths = [...options.expectedDiagrams.keys()]
    .map(path => safeRelativePath(path, 'diagram'))
  const pagePaths = options.pages.pages.map(page => safeRelativePath(page.outputPath, 'page'))
  for (const page of options.pages.pages) {
    if (!options.expectedNotes.has(page.id)) {
      throw new OutputValidationError(`Missing expected converted note for document ${page.id}.`)
    }
  }

  for (const documentId of options.expectedNotes.keys()) {
    if (options.pages.get(documentId) === undefined) {
      throw new OutputValidationError(`Unexpected expected converted note for document ${documentId}.`)
    }
  }

  const availableAssets = options.assets.entries.filter((entry): entry is AssetManifestEntry => entry.status === 'available')
  const assetPaths = availableAssets.map(entry => safeRelativePath(entry.path, 'asset'))
  const requiredFiles = new Set([...pagePaths, ...assetPaths, ...diagramPaths, ...REPORT_FILES])

  return {
    allowedFiles: new Set(requiredFiles),
    assetPaths,
    availableAssets,
    diagramPaths,
    pagePaths,
  }
}

async function validateOutputManifest(
  options: ValidateOutputOptions,
  files: readonly string[],
  expected: ExpectedOutput,
): Promise<void> {
  const actualFiles = new Set(files)
  for (const path of files) {
    if (!expected.allowedFiles.has(path)) {
      throw new OutputValidationError(`Unexpected output file: ${path}.`)
    }
  }

  for (const page of options.pages.pages) {
    if (!actualFiles.has(page.outputPath)) {
      throw new OutputValidationError(`Missing note: ${page.outputPath}.`)
    }
  }

  for (const path of expected.assetPaths) {
    if (!actualFiles.has(path)) {
      throw new OutputValidationError(`Missing asset: ${path}.`)
    }
  }

  for (const path of expected.diagramPaths) {
    if (!actualFiles.has(path)) {
      throw new OutputValidationError(`Missing diagram: ${path}.`)
    }

    const contents = await readFile(join(options.outputDirectory, path), 'utf8')
    if (contents !== options.expectedDiagrams.get(path)) {
      throw new OutputValidationError(`Diagram content mismatch for ${path}: expected converted SVG contents.`)
    }
  }

  for (const path of REPORT_FILES) {
    if (!actualFiles.has(path)) {
      throw new OutputValidationError(`Missing required report: ${path}.`)
    }
  }
}

function indexCoverage(options: ValidateOutputOptions): Map<string, DocumentCoverage> {
  const coverage = new Map<string, DocumentCoverage>()
  for (const document of options.coverage) {
    if (coverage.has(document.documentId)) {
      throw new OutputValidationError(`Duplicate coverage for document ${document.documentId}.`)
    }

    validateCoverageCounts(document)
    coverage.set(document.documentId, document)
  }

  for (const page of options.pages.pages) {
    if (!coverage.has(page.id)) {
      throw new OutputValidationError(`Missing coverage for document ${page.id}.`)
    }
  }

  for (const documentId of coverage.keys()) {
    if (options.pages.get(documentId) === undefined) {
      throw new OutputValidationError(`Unexpected coverage for document ${documentId}.`)
    }
  }

  return coverage
}

function validateMissingAssetAllowances(options: ValidateOutputOptions): ReadonlySet<string> {
  const allowMissing = new Set(options.allowMissing ?? [])
  const missingIds = new Set(options.assets.missing.map(asset => asset.sourceId))
  for (const sourceId of missingIds) {
    if (!allowMissing.has(sourceId)) {
      throw new OutputValidationError(`Unapproved missing asset "${sourceId}".`)
    }
  }

  return allowMissing
}

async function validateAssetContents(
  outputDirectory: string,
  availableAssets: readonly AssetManifestEntry[],
): Promise<void> {
  const assetsByPath = new Map<string, AssetManifestEntry[]>()
  for (const asset of availableAssets) {
    const entries = assetsByPath.get(asset.path) ?? []
    entries.push(asset)
    assetsByPath.set(asset.path, entries)
  }

  for (const [path, entries] of assetsByPath) {
    const bytes = await readFile(join(outputDirectory, path))
    const digest = createHash('sha256').update(bytes).digest('hex')
    for (const asset of entries) {
      if (bytes.byteLength !== asset.bytes) {
        throw new OutputValidationError(`Asset length mismatch for ${path}: expected ${asset.bytes}, received ${bytes.byteLength}.`)
      }

      if (digest !== asset.sha256) {
        throw new OutputValidationError(`Asset SHA-256 mismatch for ${path}.`)
      }
    }
  }
}

async function validateReports(options: ValidateOutputOptions): Promise<void> {
  let savedReport: unknown
  try {
    savedReport = JSON.parse(await readFile(join(options.outputDirectory, REPORT_FILES[0]), 'utf8'))
  }
  catch (error) {
    throw new OutputValidationError('Migration JSON report is corrupt or unparseable.', { cause: error })
  }

  if (typeof savedReport !== 'object' || savedReport === null || Array.isArray(savedReport)) {
    throw new OutputValidationError('Migration JSON report must contain an object.')
  }

  const savedRecord = savedReport as Record<string, unknown>
  if (typeof savedRecord.workspaceId !== 'string' || savedRecord.workspaceId.trim().length === 0
    || typeof savedRecord.sourceFingerprint !== 'string'
    || !/^[a-f0-9]{64}$/u.test(savedRecord.sourceFingerprint)) {
    throw new OutputValidationError('Migration JSON report has invalid source identity metadata.')
  }

  const expectedReport = createMigrationReport(createMigrationReportInput(options))
  if (!isDeepStrictEqual(savedReport, expectedReport)) {
    throw new OutputValidationError('Migration JSON report is stale or inconsistent with conversion results.')
  }

  const savedMarkdown = await readFile(join(options.outputDirectory, REPORT_FILES[1]), 'utf8')
  if (savedMarkdown !== renderMigrationMarkdown(expectedReport)) {
    throw new OutputValidationError('Migration Markdown report is stale or inconsistent with the JSON report.')
  }
}

async function validateNotes(options: ValidateOutputOptions, expected: ExpectedOutput): Promise<void> {
  const linkableFiles = new Set([...expected.pagePaths, ...expected.assetPaths, ...expected.diagramPaths])
  for (const page of options.pages.pages) {
    const markdown = await readFile(join(options.outputDirectory, page.outputPath), 'utf8')
    if (!markdown.startsWith(`${page.frontmatter}\n`)) {
      throw new OutputValidationError(`Note ${page.outputPath} frontmatter mismatch with registered page metadata.`)
    }

    const expectedMarkdown = options.expectedNotes.get(page.id)
    if (expectedMarkdown === undefined || markdown !== expectedMarkdown) {
      throw new OutputValidationError(`Note ${page.outputPath} content mismatch with converted Markdown.`)
    }

    validateInternalLinks(markdown, page.outputPath, linkableFiles)
  }
}

/** Validate a complete staging tree before any target replacement. */
export async function validateOutput(options: ValidateOutputOptions): Promise<OutputValidationSummary> {
  const files = await validateOutputFiles(options.outputDirectory)
  const expected = collectExpectedOutput(options)
  await validateOutputManifest(options, files, expected)

  const coverage = indexCoverage(options)
  const allowMissing = validateMissingAssetAllowances(options)
  const missingIds = new Set(options.assets.missing.map(asset => asset.sourceId))
  const warnings = options.warnings ?? []
  const conversionLosses = options.conversionLosses ?? []
  validateWarnings(warnings, options.pages, coverage, missingIds, allowMissing, options.allowMissingGroupChildren ?? [])
  validateApprovedLosses(coverage, warnings, conversionLosses, missingIds, options.missingAssetReferences ?? [])

  await validateAssetContents(options.outputDirectory, expected.availableAssets)
  await validateReports(options)
  await validateNotes(options, expected)

  return {
    files: files.length,
    pages: options.pages.pages.length,
    assetFiles: new Set([...expected.assetPaths, ...expected.diagramPaths]).size,
    warnings: warnings.length,
  }
}
