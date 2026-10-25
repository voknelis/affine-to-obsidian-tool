import * as Y from "yjs";

import { AssetCollection } from "../assets.ts";
import type { PageRegistry } from "../page-registry.ts";
import type { MissingGroupChildException } from "../migration-policy.ts";
import type { AffineDocument } from "../types.ts";
import { convertBasicPage } from "./basic.ts";
import { convertDatabaseBlock } from "./database.ts";
import { convertEdgelessBlock } from "./edgeless.ts";
import { convertMediaBlock, mediaAssetRequest } from "./media.ts";
import { BlockConversionError } from "./types.ts";
import type {
  AffineBlock,
  BlockConversionContext,
  ConvertedBlock,
  ConvertedPage,
  ConvertCustomBlock,
  RenderBlockSequence,
} from "./types.ts";
import { mapValue } from "./yjs.ts";

export type ConverterKind = "basic" | "media" | "database" | "edgeless";

const REGISTRY_ENTRIES: ReadonlyArray<readonly [string, ConverterKind]> = [
  ["affine:paragraph", "basic"],
  ["affine:list", "basic"],
  ["affine:note", "basic"],
  ["affine:page", "basic"],
  ["affine:surface", "edgeless"],
  ["affine:image", "media"],
  ["affine:edgeless-text", "edgeless"],
  ["affine:code", "basic"],
  ["affine:attachment", "media"],
  ["affine:bookmark", "media"],
  ["affine:divider", "basic"],
  ["affine:embed-youtube", "media"],
  ["affine:database", "database"],
  ["affine:surface-ref", "edgeless"],
  ["affine:frame", "edgeless"],
  ["affine:embed-linked-doc", "media"],
];

/** The strict allowlist of every flavour found during workspace inventory. */
export const CONVERTER_REGISTRY: ReadonlyMap<string, ConverterKind> = new Map(REGISTRY_ENTRIES);

export interface ConvertPageOptions {
  readonly assets?: AssetCollection;
  readonly allowMissingGroupChildren?: readonly MissingGroupChildException[];
}

function customBlockConverter(assets: AssetCollection): ConvertCustomBlock {
  return (
    block: AffineBlock,
    context: BlockConversionContext,
    renderSequence: RenderBlockSequence,
  ): ConvertedBlock => {
    switch (CONVERTER_REGISTRY.get(block.flavour)) {
      case "media": {
        const markdown = convertMediaBlock(block, context, assets);
        if (block.flavour === "affine:image" || block.flavour === "affine:attachment") {
          const request = mediaAssetRequest(block);
          if (assets.require(request.sourceId).status === "missing") {
            return {
              markdown,
              disposition: "approved-loss",
              dispositionReason: `Approved missing asset ${request.sourceId}`,
              warnings: [{
                kind: "missing-asset",
                documentId: context.documentId,
                blockId: block.id,
                sourceId: request.sourceId,
                reason: "Approved missing AFFiNE asset",
              }],
            };
          }
        }
        return { markdown };
      }
      case "database": {
        const converted = convertDatabaseBlock(block, context);
        return {
          markdown: converted.markdown,
          warnings: converted.warnings,
          childrenHandled: true,
          consumedBlockIds: block.children,
          disposition: converted.warnings.length === 0 ? "rendered" : "approved-loss",
          ...(converted.warnings.length === 0 ? {} : {
            dispositionReason: "Database view settings are not fully representable in Markdown",
          }),
        };
      }
      case "edgeless":
        return convertEdgelessBlock(block, context, renderSequence);
      default:
        throw new Error(`Basic flavour ${block.flavour} reached the custom converter.`);
    }
  };
}

/** Reject every unsupported source flavour before conversion or asset extraction. */
export function assertSupportedFlavours(document: AffineDocument): void {
  for (const value of document.doc.getMap<unknown>("blocks").values()) {
    if (!(value instanceof Y.Map)) continue;
    const flavour = mapValue(value, "sys:flavour");
    if (typeof flavour === "string" && !CONVERTER_REGISTRY.has(flavour)) {
      throw new BlockConversionError(`Unsupported AFFiNE block flavour "${flavour}" in document ${document.id}.`);
    }
  }
}

/** Convert a complete page only after every source flavour passes registry preflight. */
export function convertPage(
  document: AffineDocument,
  pages: PageRegistry,
  options: ConvertPageOptions = {},
): ConvertedPage {
  assertSupportedFlavours(document);
  return convertBasicPage(
    document,
    pages,
    customBlockConverter(options.assets ?? new AssetCollection([])),
    options.allowMissingGroupChildren ?? [],
  );
}

export { mediaAssetRequest } from "./media.ts";
export type {
  AffineBlock,
  BlockConversionContext,
  ConvertedPage,
  DatabaseConversionWarning,
  DiagramAsset,
} from "./types.ts";
export { BlockConversionError } from "./types.ts";
