import { REPORT_FILES } from "./migration-policy.ts";

import { fitFilenameStem, sanitizeFilename, shortDocumentId, yamlString } from "./paths.ts";
import type { AffinePageMetadata, AffineWorkspaceMetadata } from "./types.ts";

export interface RegisteredPage {
  id: string;
  title: string;
  outputPath: string;
  frontmatter: string;
  tags: string[];
  trash: boolean;
}

export class PageRegistryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PageRegistryError";
  }
}

export class PageRegistry {
  readonly pages: readonly RegisteredPage[];
  private readonly byId: ReadonlyMap<string, RegisteredPage>;

  constructor(pages: readonly RegisteredPage[]) {
    this.pages = pages;
    this.byId = new Map(pages.map((page) => [page.id, page]));
  }

  get(documentId: string): RegisteredPage | undefined {
    return this.byId.get(documentId);
  }

  require(documentId: string): RegisteredPage {
    const page = this.get(documentId);
    if (page === undefined) {
      throw new PageRegistryError(`Unknown AFFiNE page ID: ${documentId}`);
    }
    return page;
  }

  requirePath(documentId: string): string {
    return this.require(documentId).outputPath;
  }
}


function outputKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

const EMPTY_PARENTS: ReadonlyMap<string, string> = new Map();

function validateParents(
  pageIds: ReadonlySet<string>,
  parents: ReadonlyMap<string, string>,
): void {
  for (const [childId, parentId] of parents) {
    if (!pageIds.has(childId)) {
      throw new PageRegistryError(`Hierarchy references unknown child page ID: ${childId}`);
    }
    if (!pageIds.has(parentId)) {
      throw new PageRegistryError(`Hierarchy references unknown parent page ID: ${parentId}`);
    }
  }
  for (const pageId of pageIds) {
    const seen = new Set<string>();
    let current = pageId;
    for (;;) {
      if (seen.has(current)) {
        throw new PageRegistryError(`AFFiNE page hierarchy contains a cycle at ${current}.`);
      }
      seen.add(current);
      const parentId = parents.get(current);
      if (parentId === undefined) break;
      current = parentId;
    }
  }
}

function allocateStem(
  page: AffinePageMetadata,
  parentId: string | undefined,
  container: boolean,
  used: Set<string>,
  files: Set<string>,
  directories: Set<string>,
): string {
  const stem = sanitizeFilename(page.title, page.id, ".md");
  const key = (candidate: string) => outputKey(`${candidate}.md`);
  const appendSuffix = (suffix: string) =>
    `${fitFilenameStem(stem, `${suffix}.md`)}${suffix}`.replace(/[. ]+$/u, "");
  const rootActive = parentId === undefined && !page.trash;
  const conflicts = (candidate: string): boolean => {
    if (used.has(key(candidate))) return true;
    const pathKey = container ? outputKey(candidate) : key(candidate);
    if (files.has(pathKey) || directories.has(pathKey)) return true;
    if (!rootActive) return false;
    if (container && (outputKey(candidate) === "assets" || outputKey(candidate) === "_trash")) {
      return true;
    }
    return !container && REPORT_FILES.some((file) => outputKey(file) === key(candidate));
  };

  let candidateStem = stem;
  let uniqueSuffix = "";
  if (conflicts(candidateStem)) {
    uniqueSuffix = `--${shortDocumentId(page.id)}`;
    candidateStem = appendSuffix(uniqueSuffix);
  }
  if (conflicts(candidateStem)) {
    // eslint-disable-next-line no-control-regex -- ID sanitization intentionally replaces control characters.
    const id = page.id.replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/gu, "_");
    uniqueSuffix = `--${id}`;
    candidateStem = appendSuffix(uniqueSuffix);
  }
  let sequence = 2;
  while (conflicts(candidateStem)) {
    const sequenceSuffix = `${uniqueSuffix}--${sequence}`;
    candidateStem = appendSuffix(sequenceSuffix);
    sequence += 1;
  }

  used.add(key(candidateStem));
  if (container) directories.add(outputKey(candidateStem));
  else files.add(key(candidateStem));
  return candidateStem;
}

function isoDate(value: number, field: string, documentId: string): string {
  try {
    return new Date(value).toISOString();
  } catch (error) {
    throw new PageRegistryError(
      `Invalid ${field} for AFFiNE page ${documentId}.`,
      { cause: error },
    );
  }
}

function frontmatter(
  page: AffinePageMetadata,
  tags: readonly string[],
): string {
  const lines = [
    "---",
    `title: ${yamlString(page.title)}`,
    `affine_id: ${yamlString(page.id)}`,
  ];
  if (page.createDate !== undefined) {
    lines.push(`created: ${isoDate(page.createDate, "createDate", page.id)}`);
  }
  if (page.updatedDate !== undefined) {
    lines.push(`updated: ${isoDate(page.updatedDate, "updatedDate", page.id)}`);
  }
  lines.push(`trash: ${page.trash}`);
  if (page.trashDate !== undefined) {
    lines.push(`trash_date: ${isoDate(page.trashDate, "trashDate", page.id)}`);
  }
  if (page.primaryMode !== undefined) {
    lines.push(`affine_primary_mode: ${yamlString(page.primaryMode)}`);
  }
  lines.push(`tags: [${tags.map(yamlString).join(", ")}]`, "---", "");
  return lines.join("\n");
}

/**
 * Allocate every output path before exposing page metadata, so later converters
 * always resolve links against the final deterministic registry.
 */
export function buildPageRegistry(
  metadata: AffineWorkspaceMetadata,
  parents: ReadonlyMap<string, string> = EMPTY_PARENTS,
): PageRegistry {
  const tagLabels = new Map<string, string>();
  for (const tag of metadata.tags) {
    if (tagLabels.has(tag.id)) {
      throw new PageRegistryError(`Duplicate AFFiNE tag ID: ${tag.id}`);
    }
    tagLabels.set(tag.id, tag.value);
  }

  const pageIds = new Set<string>();
  for (const page of metadata.pages) {
    if (pageIds.has(page.id)) {
      throw new PageRegistryError(`Duplicate AFFiNE page ID: ${page.id}`);
    }
    pageIds.add(page.id);
  }
  validateParents(pageIds, parents);

  const sortedPages = [...metadata.pages].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  );
  const children = new Map<string, AffinePageMetadata[]>();
  for (const page of sortedPages) {
    const parentId = parents.get(page.id);
    if (parentId === undefined) continue;
    const siblings = children.get(parentId) ?? [];
    siblings.push(page);
    children.set(parentId, siblings);
  }

  const outputPaths = new Map<string, string>();
  const directories = new Map<string, string>();
  const usedStems = new Map<string, Set<string>>();
  const usedFiles = new Map<string, Set<string>>();
  const usedDirectories = new Map<string, Set<string>>();
  const allocate = (page: AffinePageMetadata): void => {
    const parentId = parents.get(page.id);
    const parentDirectory = parentId === undefined ? "" : directories.get(parentId);
    if (parentDirectory === undefined) {
      throw new PageRegistryError(`Parent path for ${parentId} was not allocated before ${page.id}.`);
    }
    const container = children.has(page.id);
    const group = `${page.trash ? "trash" : "active"}:${parentId ?? ""}`;
    const used = usedStems.get(group) ?? new Set<string>();
    const files = usedFiles.get(group) ?? new Set<string>();
    const directoryNames = usedDirectories.get(group) ?? new Set<string>();
    usedStems.set(group, used);
    usedFiles.set(group, files);
    usedDirectories.set(group, directoryNames);
    const stem = allocateStem(page, parentId, container, used, files, directoryNames);
    const directory = parentDirectory.length > 0 ? `${parentDirectory}/${stem}` : stem;
    const relativePath = container ? `${directory}/${stem}.md` : `${directory}.md`;
    outputPaths.set(page.id, `${page.trash ? "_trash/" : ""}${relativePath}`);
    directories.set(page.id, container ? directory : parentDirectory);
    for (const child of children.get(page.id) ?? []) {
      const childGroup = `${child.trash ? "trash" : "active"}:${page.id}`;
      const childUsed = usedStems.get(childGroup) ?? new Set<string>();
      const childFiles = usedFiles.get(childGroup) ?? new Set<string>();
      usedStems.set(childGroup, childUsed);
      usedFiles.set(childGroup, childFiles);
      if (child.trash === page.trash) {
        childUsed.add(outputKey(`${stem}.md`));
        childFiles.add(outputKey(`${stem}.md`));
      }
      allocate(child);
    }
  };

  // Parent-first traversal assigns deterministic sibling names before note paths.
  for (const page of sortedPages) {
    if (!parents.has(page.id)) allocate(page);
  }
  if (outputPaths.size !== sortedPages.length) {
    throw new PageRegistryError("Not every AFFiNE page received an output path.");
  }

  return new PageRegistry(sortedPages.map((page) => {
    const tags = page.tags.map((tagId) => {
      const label = tagLabels.get(tagId);
      if (label === undefined) {
        throw new PageRegistryError(`Unknown AFFiNE tag ID: ${tagId}`);
      }
      return label;
    });
    const outputPath = outputPaths.get(page.id);
    if (outputPath === undefined) throw new PageRegistryError(`Missing output path for page ${page.id}.`);
    return {
      id: page.id,
      title: page.title,
      outputPath,
      frontmatter: frontmatter(page, tags),
      tags,
      trash: page.trash,
    };
  }));
}
