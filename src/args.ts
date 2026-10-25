import { homedir } from "node:os";
import { resolve } from "node:path";

import { targetPathError } from "./path-guard.ts";

export type CliArguments =
  | { help: true }
  | {
      help: false;
      source: string;
      target: string;
      allowMissing: string[];
      dryRun: boolean;
    };

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

function optionValue(
  args: readonly string[],
  index: number,
  option: string,
): { value: string; nextIndex: number } {
  const argument = args[index];
  const prefix = `${option}=`;

  if (argument?.startsWith(prefix)) {
    const value = argument.slice(prefix.length);
    if (value.length === 0) {
      throw new CliUsageError(`${option} requires a non-empty value.`);
    }
    return { value, nextIndex: index };
  }

  const value = args[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new CliUsageError(`${option} requires a value.`);
  }
  return { value, nextIndex: index + 1 };
}

function validateTarget(source: string, target: string, cwd: string): void {
  const error = targetPathError(source, target, cwd, homedir());
  if (error !== undefined) throw new CliUsageError(error);
}

export function parseArgs(
  args: readonly string[],
  cwd: string = process.cwd(),
): CliArguments {
  let source: string | undefined;
  let target: string | undefined;
  const allowMissing: string[] = [];

  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--help" || argument === "-h") {
      return { help: true };
    }

    if (argument === "--dry-run") {
      dryRun = true;
    } else if (argument === "--source" || argument?.startsWith("--source=")) {
      const result = optionValue(args, index, "--source");
      source = result.value;
      index = result.nextIndex;
    } else if (argument === "--target" || argument?.startsWith("--target=")) {
      const result = optionValue(args, index, "--target");
      target = result.value;
      index = result.nextIndex;
    } else if (
      argument === "--allow-missing" ||
      argument?.startsWith("--allow-missing=")
    ) {
      const result = optionValue(args, index, "--allow-missing");
      allowMissing.push(result.value);
      index = result.nextIndex;
    } else {
      throw new CliUsageError(`Unknown argument: ${argument ?? ""}`);
    }
  }

  if (source === undefined) {
    throw new CliUsageError("Missing required --source <path>.");
  }

  const resolvedSource = resolve(cwd, source);
  const resolvedTarget = resolve(cwd, target ?? "from_affine");
  validateTarget(resolvedSource, resolvedTarget, cwd);

  return {
    help: false,
    source: resolvedSource,
    target: resolvedTarget,
    allowMissing,
    dryRun,
  };
}
