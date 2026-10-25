import * as Y from "yjs";

export type RecordValue = Record<string, unknown>;

export function decoded(value: unknown): unknown {
  return value instanceof Y.AbstractType ? value.toJSON() : value;
}

export function record(value: unknown): RecordValue | undefined {
  const plain = decoded(value);
  return typeof plain === "object" && plain !== null && !Array.isArray(plain)
    ? plain as RecordValue
    : undefined;
}
