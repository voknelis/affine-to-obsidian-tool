import { Buffer } from 'node:buffer'

// eslint-disable-next-line no-control-regex -- Filename sanitization intentionally removes control characters.
const WINDOWS_FORBIDDEN = /[<>:"/\\|?*\u0000-\u001F\u007F-\u009F]/gu
const TRAILING_DOTS_AND_SPACES = /[. ]+$/u
const RESERVED_WINDOWS_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu

const MAX_FILENAME_BYTES = 255

/** Compare UTF-16 code units without host locale or collation settings. */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.byteLength <= maximumBytes) {
    return value
  }
  let end = maximumBytes
  while (end > 0 && (bytes[end]! & 0xC0) === 0x80) {
    end -= 1
  }
  return bytes.subarray(0, end).toString('utf8')
}

/** Truncate a stem while leaving room for its complete deterministic suffix. */
export function fitFilenameStem(stem: string, suffix: string): string {
  const maximumStemBytes = MAX_FILENAME_BYTES - Buffer.byteLength(suffix, 'utf8')
  if (maximumStemBytes <= 0) {
    throw new RangeError('Filename suffix exceeds the 255-byte component limit.')
  }
  return truncateUtf8(stem, maximumStemBytes).replace(TRAILING_DOTS_AND_SPACES, '')
}

/** Return a stable, Windows-safe stem; omitted suffixes reserve a four-byte extension. */
export function sanitizeFilename(title: string, documentId: string, suffix?: string): string {
  let name = title.normalize('NFC')
    .replace(WINDOWS_FORBIDDEN, '-')
    .replace(TRAILING_DOTS_AND_SPACES, '')

  if (name.length === 0) {
    name = `Untitled--${shortDocumentId(documentId)}`
  }
  if (RESERVED_WINDOWS_NAME.test(name)) {
    name = `_${name}`
  }
  const reservedSuffix = suffix ?? '.svg'
  name = fitFilenameStem(name, reservedSuffix)
  return name.length === 0
    ? fitFilenameStem(`Untitled--${shortDocumentId(documentId)}`, reservedSuffix)
    : name
}

/** JSON string syntax is a safe YAML double-quoted scalar. */
export function yamlString(value: string): string {
  return JSON.stringify(value)
    .replace(/\u2028/gu, '\\u2028')
    .replace(/\u2029/gu, '\\u2029')
}

export function shortDocumentId(documentId: string): string {
  return documentId.slice(0, 8).replace(WINDOWS_FORBIDDEN, '_')
}
