# AFFiNE to Obsidian tool

Read-only, repeatable migration of an AFFiNE Desktop workspace into an Obsidian vault. The tool decodes local SQLite/Yjs data and writes Markdown, attachments, database tables, internal links, and static SVGs for edgeless content.

## Requirements

- Node.js 24 or newer.
- A local AFFiNE Desktop `storage.db` file.
- An Obsidian vault or another destination for the generated Markdown.

AFFiNE and Obsidian are not required to run during conversion. AFFiNE Cloud APIs, accounts, cookies, and authentication tokens are not used.

## Install

```sh
npm ci
```

## Usage

Always start with a dry run. It performs the complete backup, conversion, staging, and validation pipeline without creating or changing the target directory.

```sh
npm run migrate -- \
  --source "/path/to/AFFiNE/workspaces/<workspace>/storage.db" \
  --target "/path/to/vault/from_affine" \
  --dry-run
```

After reviewing the summary, run the same command without `--dry-run` to replace the target:

```sh
npm run migrate -- \
  --source "/path/to/AFFiNE/workspaces/<workspace>/storage.db" \
  --target "/path/to/vault/from_affine"
```

Show all options:

```sh
npm run migrate -- --help
```

### Options

| Option | Meaning |
| --- | --- |
| `--source <path>` | AFFiNE workspace SQLite database. Required. |
| `--target <path>` | Output directory. Defaults to `from_affine` in the invocation directory. |
| `--dry-run` | Build and validate staging output without touching the target. |
| `--allow-missing <source-id>` | Explicitly approve one missing asset. Repeatable. |
| `--allow-missing-group-child <document:surface:group:child>` | Explicitly approve one known stale edgeless group-child reference. Repeatable. |
| `--help`, `-h` | Print CLI usage. |

Approved exceptions are migration-specific policy, not defaults. The tool never embeds workspace-specific waivers in its conversion code.

## Source and target safety

- The source database is opened read-only. A consistent SQLite backup is checked with `PRAGMA integrity_check` before Yjs decoding.
- The target basename must be exactly `from_affine`. Filesystem root, cwd, home, source paths, ancestors of the source, and symlink targets are rejected.
- Conversion writes to a staging directory. Notes, links, assets, coverage, manifests, and SVGs are validated before target replacement.
- A failed dry-run or pre-commit validation leaves the existing target untouched.
- If replacement and rollback both fail, recovery output is preserved and its path is reported.

## Output

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
│   ├── <attachment-name>--<sha256>.<ext>
│   └── diagrams/
│       └── <document-id>--<block-id>.svg
├── _affine-migration.json
└── _affine-migration.md
```

Page hierarchy is reconstructed from internal document links, not from the deleted AFFiNE folder tree. For each page, the earliest referencing page in workspace metadata order becomes its parent; candidates that would form cycles are skipped deterministically. Pages without a viable parent remain at the root.

A container note uses `Parent/Parent.md`; a leaf uses `Parent/Child.md`. `_trash/` mirrors ancestry without mixing active and deleted notes. Titles are normalized, sanitized, truncated to portable path-component limits, and given deterministic ID suffixes when needed.

`_affine-migration.json` contains source-to-output mappings, asset hashes, warnings, conversion losses, and an exhaustive per-document coverage ledger. `_affine-migration.md` is the human-readable report.

## Conversion and validation

The converter handles all block flavours found during the original migration, including:

- paragraphs, headings, quotes, nested lists, code, dividers, and rich-text formatting;
- internal and external links, bookmarks, YouTube embeds, images, and attachments;
- database table/kanban views and explicit warnings for nonrepresentable view settings;
- edgeless text, shapes, groups, connectors, frames, and surface references.

Validation reconciles source blocks and rich-text deltas exactly once, checks approved losses against their specific authorization, verifies internal links and asset hashes, compares generated notes and SVGs byte-for-byte with expected output, and rejects unexpected files or flavours.

For an unchanged source and options, reruns produce identical paths and file bytes. No run timestamp is emitted.

## Development

```sh
npm run lint
npm run typecheck
npm test
```

- ESLint uses type-aware rules from `typescript-eslint`; warnings are errors.
- TypeScript runs in strict mode with no emit.
- Tests use temporary synthetic SQLite/Yjs fixtures, not personal workspaces or a running AFFiNE instance.
- The CLI runs directly on Node 24's native TypeScript support; no build step is required.
