import * as Y from "yjs";

import { DocumentCoverageLedger, type CoverageDisposition } from "../coverage.ts";
import { escapeMarkdownInlineText } from "../markdown.ts";
import type { PageRegistry } from "../page-registry.ts";
import { shortDocumentId } from "../paths.ts";
import { renderRichText } from "../richtext.ts";
import type { AffineDocument } from "../types.ts";
import {
  BlockConversionError,
  type AffineBlock,
  type BlockConversionContext,
  type ConvertedPage,
  type ConvertCustomBlock,
  type ConversionWarning,
  type DiagramAsset,
} from "./types.ts";

const HEADING_TYPES: Record<string, true> = {
  h1: true, h2: true, h3: true, h4: true, h5: true, h6: true,
};
const LIST_TYPES: Record<string, true> = { bulleted: true, numbered: true, todo: true };
const CODE_FORMAT_ATTRIBUTES = ["bold", "italic", "underline", "strike"] as const;
type CodeFormatAttribute = (typeof CODE_FORMAT_ATTRIBUTES)[number];

function isCodeFormatAttribute(attribute: string): attribute is CodeFormatAttribute {
  return (CODE_FORMAT_ATTRIBUTES as readonly string[]).includes(attribute);
}

function requiredText(block: AffineBlock, property: string): Y.Text {
  const value = block.source.get(property);
  if (!(value instanceof Y.Text)) {
    throw new BlockConversionError(
      `AFFiNE block ${block.id} (${block.flavour}) property ${property} must be a Y.Text.`,
    );
  }
  return value;
}

function renderText(block: AffineBlock, context: BlockConversionContext): string {
  const rendered = renderRichText(requiredText(block, "prop:text"), context.pages, context.coverage);
  context.losses.push(...rendered.losses);
  return rendered.markdown;
}

function decodeBlocks(document: AffineDocument): ReadonlyMap<string, AffineBlock> {
  const blocks = new Map<string, AffineBlock>();
  const entries = [...document.doc.getMap<unknown>("blocks").entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  for (const [key, value] of entries) {
    if (!(value instanceof Y.Map)) {
      throw new BlockConversionError(
        `AFFiNE block ${key} in document ${document.id} must be a Y.Map.`,
      );
    }
    const id = value.get("sys:id");
    if (typeof id !== "string" || id.length === 0 || id !== key) {
      throw new BlockConversionError(
        `AFFiNE block ${key} in document ${document.id} has an invalid sys:id.`,
      );
    }
    const flavour = value.get("sys:flavour");
    if (typeof flavour !== "string" || flavour.length === 0) {
      throw new BlockConversionError(
        `AFFiNE block ${id} in document ${document.id} has an invalid sys:flavour.`,
      );
    }
    const sourceChildren = value.get("sys:children");
    if (!(sourceChildren instanceof Y.Array)) {
      throw new BlockConversionError(
        `AFFiNE block ${id} in document ${document.id} property sys:children must be a Y.Array.`,
      );
    }
    const children = sourceChildren.toArray().map((child) => {
      if (typeof child !== "string" || child.length === 0) {
        throw new BlockConversionError(
          `AFFiNE block ${id} in document ${document.id} has a non-string child ID.`,
        );
      }
      return child;
    });
    blocks.set(id, { id, flavour, children, source: value });
  }
  return blocks;
}

function renderCodeBlock(block: AffineBlock, context: BlockConversionContext): string {
  if (block.children.length > 0) {
    throw new BlockConversionError(`AFFiNE code block ${block.id} cannot have children.`);
  }
  const languageValue = block.source.get("prop:language");
  if (languageValue !== undefined && languageValue !== null && typeof languageValue !== "string") {
    throw new BlockConversionError(
      `AFFiNE code block ${block.id} property prop:language must be a string or null.`,
    );
  }
  const language = typeof languageValue === "string" ? languageValue.trim() : "";
  if (/[`\r\n]/u.test(language)) {
    throw new BlockConversionError(
      `AFFiNE code block ${block.id} has an unsafe prop:language info string.`,
    );
  }
  const sourceText = requiredText(block, "prop:text");
  const deltas = sourceText.toDelta() as Array<{ insert: unknown; attributes?: Record<string, unknown> }>;
  const source = context.coverage?.richTextSource(sourceText);
  for (const [deltaIndex, delta] of deltas.entries()) {
    if (typeof delta.insert !== "string") {
      throw new BlockConversionError(
        `AFFiNE code block ${block.id} delta insert must be a string.`,
      );
    }
    const lostColors: Array<"color" | "background"> = [];
    const lostFormats: CodeFormatAttribute[] = [];
    for (const [attribute, value] of Object.entries(delta.attributes ?? {})) {
      if (value === undefined || value === null || value === false || value === "") continue;
      if (isCodeFormatAttribute(attribute)) {
        if (value !== true) {
          throw new BlockConversionError(
            `AFFiNE code block ${block.id} ${attribute} attribute must be true when present.`,
          );
        }
        lostFormats.push(attribute);
        context.losses.push({
          kind: "visual-formatting",
          attribute,
          value: "true",
          text: delta.insert,
          ...(source === undefined ? {} : { ...source, deltaIndex }),
        });
        continue;
      }
      if (attribute !== "color" && attribute !== "background") {
        throw new BlockConversionError(
          `AFFiNE code block ${block.id} has unsupported rich-text attribute "${attribute}".`,
        );
      }
      if (typeof value !== "string") {
        throw new BlockConversionError(
          `AFFiNE code block ${block.id} ${attribute} attribute must be a string.`,
        );
      }
      lostColors.push(attribute);
      context.losses.push({
        kind: "visual-color",
        attribute,
        value,
        text: delta.insert,
        ...(source === undefined ? {} : { ...source, deltaIndex }),
      });
    }
    const reasons = [
      ...(lostColors.length === 0 ? [] : [`visual-color:${lostColors.join(",")}`]),
      ...(lostFormats.length === 0 ? [] : [`visual-formatting:${lostFormats.join(",")}`]),
    ];
    context.coverage?.recordRichTextDelta(
      sourceText,
      deltaIndex,
      reasons.length === 0 ? "rendered" : "approved-loss",
      reasons.length === 0 ? undefined : reasons.join(";"),
    );
  }
  const code = deltas.map((delta) => delta.insert as string).join("").replace(/\r\n?/gu, "\n");
  const runs = code.match(/`+/gu) ?? [];
  const longestRun = runs.reduce((longest, run) => Math.max(longest, run.length), 0);
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${language}\n${code}${code.endsWith("\n") ? "" : "\n"}${fence}`;
}

function renderTree(
  context: BlockConversionContext,
  root: AffineBlock,
  convertCustomBlock: ConvertCustomBlock,
): { markdown: string; diagrams: DiagramAsset[]; warnings: ConversionWarning[] } {
  const diagrams: DiagramAsset[] = [];
  const warnings: ConversionWarning[] = [];
  const active = new Set<string>();
  const activePath: string[] = [];
  const rendered = new Set<string>();

  function renderSequence(ids: readonly string[], depth: number): string {
    let markdown = "";
    let previous: AffineBlock | undefined;
    for (const id of ids) {
      const block = context.blocks.get(id);
      if (block === undefined) {
        throw new BlockConversionError(
          `Missing AFFiNE block "${id}" referenced by document ${context.documentId}.`,
        );
      }
      const current = renderBlock(block, depth);
      if (previous !== undefined) {
        markdown += previous.flavour === "affine:list" && block.flavour === "affine:list"
          ? "\n"
          : "\n\n";
      }
      markdown += current;
      previous = block;
    }
    return markdown;
  }

  function finishBlock(
    block: AffineBlock,
    own: string | undefined,
    children: string | undefined,
    depth: number,
    disposition: CoverageDisposition,
    dispositionReason: string | undefined,
    consumedBlockIds: readonly string[] = [],
  ): string {
    context.coverage?.recordBlock(block.id, disposition, dispositionReason);
    for (const consumedId of consumedBlockIds) {
      if (rendered.has(consumedId)) {
        throw new BlockConversionError(
          `AFFiNE block is processed multiple times: ${consumedId} in document ${context.documentId}.`,
        );
      }
      context.coverage?.recordBlock(consumedId, "rendered");
      rendered.add(consumedId);
    }
    const indentation = " ".repeat(depth * 4);
    let markdown = own === undefined || own.length === 0
      ? own ?? ""
      : `${indentation}${own.replaceAll("\n", `\n${indentation}`)}`;
    if (children !== undefined) {
      if (own !== undefined) {
        markdown += block.flavour === "affine:list" ? "\n" : "\n\n";
      }
      markdown += children;
    }
    activePath.pop();
    active.delete(block.id);
    rendered.add(block.id);
    return markdown;
  }

  function renderBlock(block: AffineBlock, depth: number): string {
    if (active.has(block.id)) {
      const cycleStart = activePath.indexOf(block.id);
      const cycle = [...activePath.slice(cycleStart), block.id].join(" -> ");
      throw new BlockConversionError(
        `AFFiNE block cycle in document ${context.documentId}: ${cycle}.`,
      );
    }
    if (rendered.has(block.id)) {
      throw new BlockConversionError(
        `AFFiNE block is referenced multiple times: ${block.id} in document ${context.documentId}.`,
      );
    }
    active.add(block.id);
    activePath.push(block.id);

    let own: string | undefined;
    let childDepth = depth;
    let disposition: CoverageDisposition = block.flavour === "affine:page" || block.flavour === "affine:note"
      ? "structural/metadata-only"
      : "rendered";
    let dispositionReason: string | undefined;
    switch (block.flavour) {
      case "affine:page": {
        const title = requiredText(block, "prop:title");
        context.coverage?.recordRichText(title, "structural/metadata-only");
        break;
      }
      case "affine:note":
        break;
      case "affine:paragraph": {
        const type = block.source.get("prop:type");
        if (typeof type !== "string") {
          throw new BlockConversionError(
            `AFFiNE paragraph ${block.id} property prop:type must be a string.`,
          );
        }
        const text = renderText(block, context);
        if (type === "text") {
          own = text;
        } else if (type === "quote") {
          own = text.split("\n").map((line) => line.length === 0 ? ">" : `> ${line}`).join("\n");
        } else if (HEADING_TYPES[type] === true) {
          own = `${"#".repeat(Number(type.slice(1)))} ${text}`;
        } else {
          throw new BlockConversionError(
            `Unsupported AFFiNE paragraph type "${type}" in block ${block.id}.`,
          );
        }
        break;
      }
      case "affine:list": {
        const type = block.source.get("prop:type");
        if (typeof type !== "string" || LIST_TYPES[type] !== true) {
          throw new BlockConversionError(
            `Unsupported AFFiNE list type "${String(type)}" in block ${block.id}.`,
          );
        }
        const text = renderText(block, context);
        let marker = type === "bulleted" ? "- " : "1. ";
        if (type === "todo") {
          const checked = block.source.get("prop:checked") ?? false;
          if (typeof checked !== "boolean") {
            throw new BlockConversionError(
              `AFFiNE todo block ${block.id} property prop:checked must be a boolean.`,
            );
          }
          marker = checked ? "- [x] " : "- [ ] ";
        }
        own = `${marker}${text.replaceAll("\n", `\n${" ".repeat(marker.length)}`)}`;
        childDepth += 1;
        break;
      }
      case "affine:code":
        own = renderCodeBlock(block, context);
        break;
      case "affine:divider":
        if (block.children.length > 0) {
          throw new BlockConversionError(`AFFiNE divider block ${block.id} cannot have children.`);
        }
        own = "---";
        break;
      default: {
        const converted = convertCustomBlock(block, context, renderSequence);
        own = converted.markdown;
        childDepth += converted.childDepth ?? 0;
        disposition = converted.disposition ?? disposition;
        dispositionReason = converted.dispositionReason;
        diagrams.push(...converted.diagrams ?? []);
        warnings.push(...converted.warnings ?? []);
        if (converted.childrenHandled === true) {
          return finishBlock(
            block,
            own,
            undefined,
            depth,
            disposition,
            dispositionReason,
            converted.consumedBlockIds ?? [],
          );
        }
        break;
      }
    }

    const children = block.children.length > 0
      ? renderSequence(block.children, childDepth)
      : undefined;
    return finishBlock(block, own, children, depth, disposition, dispositionReason);
  }

  const markdown = renderBlock(root, 0);
  if (rendered.size !== context.blocks.size) {
    const unreferenced = [...context.blocks.keys()].find((id) => !rendered.has(id));
    throw new BlockConversionError(
      `Unreferenced AFFiNE block ${unreferenced} in document ${context.documentId}.`,
    );
  }
  return { markdown, diagrams, warnings };
}

/** Convert one page's validated block tree and prepend registry-owned metadata. */
export function convertBasicPage(
  document: AffineDocument,
  pages: PageRegistry,
  convertCustomBlock: ConvertCustomBlock,
): ConvertedPage {
  const page = pages.require(document.id);
  const blocks = decodeBlocks(document);
  const coverage = new DocumentCoverageLedger(document.id, blocks.values());
  const context: BlockConversionContext = {
    documentId: document.id,
    pages,
    blocks,
    losses: [],
    coverage,
  };
  let root = blocks.get(document.id);
  if (root === undefined) {
    const roots = [...blocks.values()].filter((block) => block.flavour === "affine:page");
    const onlyRoot = roots[0];
    if (roots.length !== 1 || onlyRoot === undefined) {
      throw new BlockConversionError(
        `Expected exactly one AFFiNE page root in document ${document.id}; received ${roots.length}.`,
      );
    }
    root = onlyRoot;
  }
  if (root.flavour !== "affine:page") {
    throw new BlockConversionError(
      `AFFiNE document root ${document.id} must have flavour affine:page, received ${root.flavour}.`,
    );
  }
  const converted = renderTree(context, root, convertCustomBlock);
  const body = converted.markdown;
  const title = page.title.trim().length === 0
    ? `Untitled--${shortDocumentId(page.id)}`
    : page.title;
  const heading = `# ${escapeMarkdownInlineText(title)}`;
  return {
    markdown: `${page.frontmatter}\n${heading}${body.length === 0 ? "" : `\n\n${body}`}\n`,
    losses: context.losses,
    diagrams: converted.diagrams,
    warnings: converted.warnings,
    coverage: coverage.complete(),
  };
}
