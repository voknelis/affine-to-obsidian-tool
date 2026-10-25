export const JSON_REPORT_FILENAME = "_affine-migration.json";
export const MARKDOWN_REPORT_FILENAME = "_affine-migration.md";
export const REPORT_FILES = [JSON_REPORT_FILENAME, MARKDOWN_REPORT_FILENAME] as const;

export interface MissingGroupChildException {
  readonly documentId: string;
  readonly surfaceId: string;
  readonly groupId: string;
  readonly childId: string;
}

export function allowsMissingGroupChild(
  exceptions: readonly MissingGroupChildException[],
  documentId: string,
  surfaceId: string,
  groupId: string,
  childId: string,
): boolean {
  return exceptions.some((exception) => exception.documentId === documentId
    && exception.surfaceId === surfaceId
    && exception.groupId === groupId
    && exception.childId === childId);
}
