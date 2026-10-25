# AFFiNE to Obsidian

A deterministic TypeScript CLI that converts one local AFFiNE Desktop SQLite workspace into Obsidian Flavored Markdown. It reads Yjs snapshots and updates directly; it does not use BlockSuite, AFFiNE Cloud, a cloud account, or network APIs.

## Prerequisites

- Node.js 24 or newer (`node:sqlite` and native TypeScript execution are required).
- npm, for installing dependencies and running the package scripts.
- Read access to the local AFFiNE workspace `storage.db` and write access to the parent of the target directory.
- A consistent AFFiNE snapshot. Synchronize AFFiNE before migration; this tool does not download or synchronize cloud data.

Install the locked dependencies from the workspace root:

```sh
npm --prefix tools/affine-to-obsidian ci
```

## Source safety

The source database is opened with SQLite `readOnly: true`. The CLI creates one consistent temporary SQLite backup, checks that copy with `PRAGMA integrity_check`, and decodes Yjs data directly from that verified copy rather than converting the source in place. Temporary work directories are removed on success and ordinary failure. No AFFiNE tokens, cookies, authentication sessions, or Cloud credentials are read or written to the output.

Conversion or validation failure leaves the source and previous target unchanged. A failed replacement rolls the previous target back; if both replacement and rollback fail, cleanup deliberately preserves the work directory and the error discloses the exact recovery path containing the previous target.

## Commands

Show CLI help:

```sh
npm --prefix tools/affine-to-obsidian run migrate -- --help
```

Run the full pipeline without replacing the target:

```sh
npm --prefix tools/affine-to-obsidian run migrate -- \
  --source "/path/to/AFFiNE/workspaces/<workspace>/storage.db" \
  --target "/path/to/vault/from_affine" \
  --dry-run
```

Dry-run still performs backup, decoding, conversion, asset extraction, staging, report generation, and output validation. It removes staging afterward and leaves an existing or missing target untouched.

Run the verified baseline migration used for this workspace:

```sh
npm --prefix tools/affine-to-obsidian run migrate -- \
  --source "/mnt/c/Users/pavel/AppData/Roaming/AFFiNE/workspaces/affine-cloud/37b19c5e-61bb-463d-835f-458ddd925f15/storage.db" \
  --target "/mnt/d/Obsidian/from_affine" \
  --allow-missing "smjDCoUasPTP7xbGv6P71V5ZCmvIl5Q2AR-85qlSVEw="
```

`--target` defaults to `from_affine` under the current working directory. For repeatable use, pass it explicitly as above. `--allow-missing <source-id>` is repeatable and approves only the named absent asset. Every other missing, deleted, or zero-length blob remains fatal. For an approved absence, the note receives an Obsidian warning callout containing document/source IDs, never a broken file link. The ID in the baseline command is the only approved gap in the inspected snapshot; after that HTML attachment is restored in AFFiNE, rerun without `--allow-missing`.

### Strict target guard

Replacement is deliberately narrow: the target basename must be exactly `from_affine`. The CLI refuses a source-equal target, filesystem root, current working directory, home directory, a target containing the source database, symbolic-link parents or targets, and an existing non-directory target. Source and target containment is checked through canonical existing ancestors and repeated immediately before commit. It does not provide a general-purpose directory replacement mode.

A normal run stages and validates every note byte-for-byte against its freshly converted Markdown, complete frontmatter, internal target, asset hash, required report, saved JSON manifest, and coverage entry before replacing the target. Truncated bodies, omitted database content, and missing required callouts therefore fail closed. The previous target is retained during replacement so a failed commit can be rolled back.

## Output layout

```text
from_affine/
├── <Root note>.md
├── <Parent>/
│   ├── <Parent>.md
│   └── <Child>.md
├── _trash/
│   └── <Parent>/
│       └── <Deleted child>.md
├── assets/
│   ├── <sanitized-name>--<short-sha256>.<ext>
│   └── diagrams/
│       └── <document-id>--<block-id>.svg
├── _affine-migration.json
└── _affine-migration.md
```

Page hierarchy is reconstructed from internal document links, not from the deleted AFFiNE folder tree. For each page, the earliest referencing page in workspace metadata order becomes its parent; candidates that would close a cycle are skipped deterministically. Pages without a viable parent remain at the root. A container note uses `Parent/Parent.md`, while a leaf uses `Parent/Child.md`; `_trash/` mirrors ancestry without mixing active and deleted notes. Titles are normalized to Unicode NFC, sanitized for portable paths, and truncated at UTF-8 code-point boundaries to keep each path component within 255 bytes while retaining deterministic ID/hash suffixes and extensions. Empty titles, sibling collisions, report filename collisions, and reserved root container names receive deterministic document-ID suffixes. Notes contain AFFiNE metadata frontmatter and a normalized single-line level-one title.

`_affine-migration.json` records the workspace ID, deterministic source fingerprint, page/asset mappings, actual asset bytes/MIME/SHA-256, per-document block and rich-text coverage, warnings, missing assets, and counts. `_affine-migration.md` is the human-readable report. Outputs contain no generation timestamp, absolute temporary paths, or authentication data.

## Conversion and loss rules

- Paragraphs, headings, quotes, nested bulleted/numbered/todo lists with CommonMark-safe indentation, language-aware fenced code, and dividers become Markdown with escaping and safe code fences. Literal math/comment/entity markers, ordered-list delimiters, and line-leading code indentation are escaped.
- Rich text preserves bold, italic, underline, strikethrough, inline code, highlight, external links, and path-qualified `LinkedPage` wikilinks. Boundary whitespace stays outside formatting delimiters and multiline inline content uses explicit breaks. Unsupported foreground/background colors are recorded as explicit visual-color losses; text remains present.
- Fenced code preserves all literal text. Source colors and bold/italic/underline/strike formatting that code fences cannot represent are recorded as exact per-delta visual losses; links, references, unknown attributes, and non-string inserts remain fatal.
- Images and attachments use deterministic content-based asset names and deduplicate repeated source IDs only when bytes and normalized media types agree. Supported types are embedded; other files are linked. Actual bytes and file signatures are validated instead of trusting `prop:size`.
- Bookmarks and YouTube blocks become normalized external links, including bare-domain and protocol-relative source URLs. Linked documents use the page registry, including links into `_trash/`.
- Databases become escaped Markdown tables. Kanban grouping retains every configured lane, including empty lanes. Table `groupBy` and other nonrepresentable settings become structured warnings. Columns hidden in every view, including rich-text cells and row titles, are retained in an `All data` table; schemas without a title column also preserve every row's `prop:text` there. Filters are not applied to source rows.
- Edgeless text becomes ordered text. Shapes, groups, connectors, and native surface text become deterministic, self-contained static SVG without scripts or external hrefs. SVG bounds include only the current surface's rendered native shapes/text and direct children plus its connector paths/endpoints; document-wide geometry remains available solely for connector endpoint resolution. Supported palette and CSS colors are retained; unsupported nonempty colors are fatal rather than silently replaced with black or white. Edgeless `prop:text` not consumed by surface SVG, including geometry-less and standalone blocks, is rendered through the rich-text converter with delta/loss accounting; plain strings are Markdown-escaped. Frames and surface references become named sections and links/embeds. Surface references embed only surfaces that generate a diagram; references to geometry-less/text-only surfaces instead link to the containing note, avoiding nonexistent SVG targets. Only the single inventoried stale group-child tuple documented in the migration plan is warning-approved; every other missing reference is fatal.
- Unknown flavours/element types, malformed content, unsupported code links/attributes or formatted native SVG text, unresolved internal references, or unapproved warnings stop migration before target replacement.

Every source block and rich-text delta must be accounted exactly once as rendered, structural/metadata-only, or explicitly approved loss. Approved-loss identities reconcile with their exact warning or structured conversion-loss authorization. Missing-asset losses require a `missing-asset` warning for the same document, block, and `sourceId`; every missing source reference must have a corresponding warning, and database warnings cannot authorize attachment losses. Whole-output validation requires exactly the registered notes, source assets, expected diagrams, and reports; complete note and SVG contents are compared with fresh conversion results, so missing, unexpected, stale, truncated, or corrupted files are fatal. The generated reports expose conversion losses and warnings; they are not silently discarded. In the verified real snapshot, 2,805 blocks and 2,850 deltas reconciled across all 175 documents with zero unaccounted or double-processed items: 2,267 blocks and 2,679 deltas rendered, 529 blocks and 168 deltas structural/metadata-only, and 9 blocks and 3 deltas explicitly approved-loss. Three formerly hidden code-formatting losses are now reported (two visual-color and one bold). Its 11 accepted report warnings comprise nine `header.iconColumn` database-view settings, one stale edgeless group-child reference, and the single approved missing HTML asset.

## Repeatability

For an unchanged source and options, reruns produce the same paths and bytes: names, traversal, reports, and asset content hashes are deterministic, and no run timestamp is emitted. The final hierarchical real second-run verification compared all 267 output files and found identical paths and SHA-256 values (tree-hash manifest `33e151c90bc3128aaec9e9528a63cdc134c0e8bc4a6a2a4154c9c73e234460f2`). The source SHA-256 stayed `13abb58225befe8203eda1578e9cebcadc0d7493cd36bc38ffe3240fa9b8a441`, with size and modification time unchanged.

## Tests and typecheck

Run the complete isolated test suite:

```sh
npm --prefix tools/affine-to-obsidian test
```

Run TypeScript checking:

```sh
npm --prefix tools/affine-to-obsidian run typecheck
```

The tests use temporary synthetic SQLite/Yjs fixtures, not personal notes or a running AFFiNE instance. The hierarchy refactor passed 229/229 tests plus typecheck. Coverage includes all 16 discovered flavours, parent inference and nested path allocation, success/error paths, strict target protection, dry-run behavior, rollback, approved missing assets, coverage accounting, and repeatable output hashes.

## Real migration and Obsidian verification

The inspected cloud-workspace snapshot produced 175 notes (147 active and 28 trash), 88 extracted source assets, two edgeless SVGs, and two reports: 267 files and 90 asset files in total. All 134 `LinkedPage` references resolved, all 88 available asset hashes matched, and the only missing source asset was the explicitly approved HTML attachment.

Actual Obsidian 1.14.5 reading-view and preview-renderer DOM checks were performed through `C:\Program Files\Obsidian\Obsidian.com`:

- `Reading List--YkCnZzfR` rendered one table with 24 rows and three resolved internal-link DOM nodes, with no literal table wikilinks after reload.
- `-template- tag` rendered code and underline formatting and loaded its PNG (`complete=true`, 421×186).
- `Ozon (оффер)` rendered a loaded `internal-embed pdf-embed` with toolbar/container.
- Trash note `Habit Tracker Printable` retained `trash: true` and, after the surface-local bounds fix, loaded both embeds of its regenerated edgeless SVG (`complete=true`, 3315×1755 each).
- Post-review `Reflow, repaint` rendered `Reflow` and `Composite` as actual `<strong>` elements with no literal `**` delimiters; `backend setup for macos` produced one nested ordered list containing all three expected child items; `2023.10.05` preserved literal `$7` text with zero `.math` elements. The hidden window had a zero-sized viewport, so these checks synchronously materialized Obsidian's own parsed preview sections before inspecting their DOM.
- Hierarchical output preserved all 65 comparable Notion parent→child relationships. `from_affine/IT/IT.md` exposed resolved nested links and clicking `IT/Languages/Languages` navigated to `from_affine/IT/Languages/Languages.md`; the trashed container `from_affine/_trash/Learn Notion in 3 steps/Learn Notion in 3 steps.md` retained `trash: true` and three resolved links.

These were manual UI verification results, not a new automated UI/e2e suite. Screenshots were recorded as `%LOCALAPPDATA%\Temp\obsidian-task11-active.png`, `obsidian-task11-trash.png`, and `%LOCALAPPDATA%\Temp\obsidian-hierarchy.png` during those checks.
