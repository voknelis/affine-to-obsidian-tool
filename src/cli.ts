#!/usr/bin/env node

import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { CliUsageError, parseArgs } from './args.ts'
import { migrateWorkspace } from './migrate.ts'

const HELP = `Usage: affine-to-obsidian-tool --source <path> [options]

Options:
  --source <path>                 AFFiNE workspace SQLite database (required)
  --target <path>                 Output directory (default: from_affine)
  --allow-missing <source-id>     Allow a missing asset; repeatable
  --allow-missing-group-child <documentId:surfaceId:groupId:childId>
                                Allow one stale edgeless group child; repeatable
  --dry-run                       Convert, stage, validate and report without replacing target
  -h, --help                      Show this help
`

interface TextWriter {
  write: (chunk: string) => unknown
}

export interface CliIo {
  stdout: TextWriter
  stderr: TextWriter
  cwd: string
}

export async function runCli(
  args: readonly string[],
  io: CliIo = { stdout: process.stdout, stderr: process.stderr, cwd: process.cwd() },
): Promise<number> {
  try {
    const options = parseArgs(args, io.cwd)
    if (options.help) {
      io.stdout.write(HELP)
      return 0
    }
    const result = await migrateWorkspace(options)
    io.stdout.write(
      `${result.dryRun ? 'Dry run validated' : 'Migrated'} ${result.pages} pages, ${result.files} files, ${result.assetFiles} asset files, ${result.warnings} warnings.\n`,
    )
    return 0
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    io.stderr.write(`Error: ${message}\n`)
    if (error instanceof CliUsageError) {
      io.stderr.write('Try \'affine-to-obsidian-tool --help\' for usage.\n')
    }
    return 1
  }
}

if (
  process.argv[1] !== undefined
  && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  process.exitCode = await runCli(process.argv.slice(2))
}
