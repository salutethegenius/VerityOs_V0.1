import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function repoRootFromModuleUrl(moduleUrl: string = import.meta.url): string {
  let dir = dirname(fileURLToPath(moduleUrl));
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error("could not locate repository root (pnpm-workspace.yaml)");
}

export function writeRepoSeedFile(
  filename: "verity-dev-seed.json" | "verity-demo-seed.json",
  payload: unknown,
  moduleUrl: string = import.meta.url
): { absolute: string; relative: string } {
  const root = repoRootFromModuleUrl(moduleUrl);
  const dir = join(root, "tmp");
  mkdirSync(dir, { recursive: true });
  const absolute = resolve(join(dir, filename));
  writeFileSync(absolute, JSON.stringify(payload, null, 2));
  return { absolute, relative: relative(root, absolute) };
}
