import * as Y from 'yjs'

export type RecordValue = Record<string, unknown>
export interface TextDelta {
  readonly insert: unknown
  readonly attributes?: Record<string, unknown>
}

/** Narrow Yjs's untyped delta boundary once for all rich-text consumers. */
export function textDeltas(text: Y.Text): TextDelta[] {
  const deltas: unknown = text.toDelta()
  if (!Array.isArray(deltas)) {
    throw new TypeError('AFFiNE rich-text deltas must be an array.')
  }
  return deltas.map((delta: unknown) => {
    if (typeof delta !== 'object' || delta === null || !('insert' in delta)) {
      throw new Error('AFFiNE rich-text delta must be an object with an insert.')
    }
    const attributes = 'attributes' in delta ? delta.attributes : undefined
    if (attributes !== undefined
      && (typeof attributes !== 'object' || attributes === null || Array.isArray(attributes))) {
      throw new Error('AFFiNE rich-text delta attributes must be an object.')
    }
    return {
      insert: delta.insert,
      ...(attributes === undefined ? {} : { attributes: attributes as Record<string, unknown> }),
    }
  })
}

/** Keep Y.Map.get's any-typed result behind an unknown boundary. */
export function mapValue(map: Y.Map<unknown>, key: string): unknown {
  const value: unknown = map.get(key)
  return value
}

export function decoded(value: unknown): unknown {
  return value instanceof Y.AbstractType ? value.toJSON() : value
}

export function record(value: unknown): RecordValue | undefined {
  const plain = decoded(value)
  return typeof plain === 'object' && plain !== null && !Array.isArray(plain)
    ? plain as RecordValue
    : undefined
}
