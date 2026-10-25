import type * as Y from "yjs";

import { textDeltas } from "./converters/yjs.ts";

import type { DocumentCoverageLedger } from "./coverage.ts";

import {
  escapeInlineCode,
  escapeMarkdownText,
  escapeMarkdownUrl,
  escapeWikilinkAlias,
  escapeWikilinkTarget,
  normalizeExternalUrl,
} from "./markdown.ts";
import type { PageRegistry } from "./page-registry.ts";

const BOOLEAN_MARKS: Record<string, true> = {
  bold: true,
  italic: true,
  underline: true,
  strike: true,
  code: true,
};
const KNOWN_ATTRIBUTES: Record<string, true> = {
  ...BOOLEAN_MARKS,
  background: true,
  color: true,
  link: true,
  reference: true,
};
const COLOR_ATTRIBUTES = ["background", "color"] as const;

type ColorAttribute = (typeof COLOR_ATTRIBUTES)[number];
type FormatAttribute = "bold" | "italic" | "underline" | "strike";
type Attributes = Record<string, unknown>;

export interface RichTextLoss {
  kind: "visual-color" | "visual-formatting";
  attribute: ColorAttribute | FormatAttribute;
  value: string;
  text: string;
  readonly blockId?: string;
  readonly property?: string;
  readonly deltaIndex?: number;
}

export interface RenderedRichText {
  markdown: string;
  losses: RichTextLoss[];
}

interface LinkedPageReference {
  type: "LinkedPage";
  pageId: string;
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false && value !== "";
}

function validateAttributes(attributes: Attributes): void {
  for (const [name, value] of Object.entries(attributes)) {
    if (KNOWN_ATTRIBUTES[name] !== true) {
      throw new Error(`AFFiNE delta has unknown rich-text attribute "${name}"`);
    }
    if (BOOLEAN_MARKS[name] === true && isPresent(value) && value !== true) {
      throw new Error(`AFFiNE rich-text attribute ${name} must be true when present`);
    }
  }
}

function optionalString(attributes: Attributes, name: ColorAttribute | "link"): string | undefined {
  const value = attributes[name];
  if (!isPresent(value)) return undefined;
  if (typeof value !== "string") {
    throw new Error(`AFFiNE rich-text attribute ${name} must be a string`);
  }
  return value;
}

function linkedPage(attributes: Attributes): LinkedPageReference | undefined {
  const value = attributes.reference;
  if (!isPresent(value)) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("AFFiNE rich-text reference must be an object");
  }

  const reference = value as Record<string, unknown>;
  if (reference.type !== "LinkedPage") {
    throw new Error(`Unsupported AFFiNE rich-text reference type "${String(reference.type)}"`);
  }
  if (typeof reference.pageId !== "string" || reference.pageId.length === 0) {
    throw new Error("AFFiNE LinkedPage reference requires a nonempty pageId");
  }
  return { type: "LinkedPage", pageId: reference.pageId };
}

function enabled(attributes: Attributes, name: string): boolean {
  return attributes[name] === true;
}

function renderInlineBreaks(value: string): string {
  return value.replaceAll("\n", "<br>");
}

function renderPlainText(value: string): string {
  return renderInlineBreaks(escapeMarkdownText(value));
}

function escapeCodeWikilinkAlias(value: string): string {
  return value.replace(/([\\[\]|])/gu, "\\$1");
}

/** Render one Y.Text delta stream; every source delta is consumed exactly once. */
export function renderRichText(
  text: Y.Text,
  pages: PageRegistry,
  coverage?: DocumentCoverageLedger,
): RenderedRichText {
  const markdown: string[] = [];
  const losses: RichTextLoss[] = [];
  const source = coverage?.richTextSource(text);

  for (const [deltaIndex, delta] of textDeltas(text).entries()) {
    if (typeof delta.insert !== "string") {
      throw new Error("AFFiNE rich-text delta insert must be a string");
    }
    const attributes = delta.attributes ?? {};
    validateAttributes(attributes);
    const sourceText = delta.insert;
    const reference = linkedPage(attributes);
    const link = optionalString(attributes, "link");
    if (reference !== undefined && link !== undefined) {
      throw new Error("AFFiNE rich-text delta cannot have both link and reference attributes");
    }

    const lostColors: ColorAttribute[] = [];
    for (const attribute of COLOR_ATTRIBUTES) {
      const value = optionalString(attributes, attribute);
      if (value !== undefined) {
        losses.push({
          kind: "visual-color",
          attribute,
          value,
          text: sourceText,
          ...(source === undefined ? {} : { ...source, deltaIndex }),
        });
        lostColors.push(attribute);
      }
    }

    const code = enabled(attributes, "code");
    const boundaries = code ? undefined : /^(\s*)(.*?)(\s*)$/su.exec(sourceText);
    const leading = boundaries?.[1] ?? "";
    const core = boundaries?.[2] ?? sourceText;
    const trailing = boundaries?.[3] ?? "";

    let rendered = reference === undefined ? renderPlainText(core) : escapeWikilinkAlias(core);
    if (code) rendered = escapeInlineCode(sourceText);
    if (core.length > 0 || code) {
      if (optionalString(attributes, "background") !== undefined) rendered = `==${rendered}==`;
      if (enabled(attributes, "underline")) rendered = `<u>${rendered}</u>`;
      if (enabled(attributes, "strike")) rendered = `~~${rendered}~~`;
      if (enabled(attributes, "italic")) rendered = `*${rendered}*`;
      if (enabled(attributes, "bold")) rendered = `**${rendered}**`;
    }

    if (reference !== undefined) {
      const target = pages.require(reference.pageId);
      const path = escapeWikilinkTarget(target.outputPath);
      const alias = code ? escapeCodeWikilinkAlias(rendered) : rendered;
      rendered = core.length === 0 && !code ? `[[${path}]]` : `[[${path}|${alias}]]`;
    } else if (link !== undefined) {
      rendered = `[${rendered}](${escapeMarkdownUrl(normalizeExternalUrl(link))})`;
    }
    coverage?.recordRichTextDelta(
      text,
      deltaIndex,
      lostColors.length === 0 ? "rendered" : "approved-loss",
      lostColors.length === 0 ? undefined : `visual-color:${lostColors.join(",")}`,
    );
    markdown.push(`${renderPlainText(leading)}${rendered}${renderPlainText(trailing)}`);
  }

  return { markdown: markdown.join(""), losses };
}
