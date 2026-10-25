import { isAbsolute, parse, relative, resolve } from "node:path";

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

/** Return the shared lexical target-safety error, if any. */
export function targetPathError(
  source: string,
  target: string,
  cwd: string,
  home: string,
): string | undefined {
  if (source === target) {
    return "Source and target must be different paths.";
  }
  if (target === parse(target).root || target === resolve(cwd) || target === resolve(home)) {
    return "Unsafe target path: refusing a filesystem root, working directory, or home directory.";
  }
  if (isWithin(target, source)) {
    return "Unsafe target path: the target must not contain the source database.";
  }
  return undefined;
}
