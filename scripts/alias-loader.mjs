import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptsDir, "..");
const srcRoot = path.join(projectRoot, "src");

function resolveCandidatePath(target) {
  const candidates = [
    target,
    `${target}.ts`,
    `${target}.tsx`,
    `${target}.js`,
    `${target}.mjs`,
    path.join(target, "index.ts"),
    path.join(target, "index.tsx"),
    path.join(target, "index.js"),
    path.join(target, "index.mjs"),
  ];

  return candidates.find((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  }) ?? null;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const aliasPath = resolveCandidatePath(path.join(srcRoot, specifier.slice(2)));
    if (aliasPath) {
      return {
        url: pathToFileURL(aliasPath).href,
        shortCircuit: true,
      };
    }
  }

  if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
    const parentPath = fileURLToPath(context.parentURL);
    const relativePath = resolveCandidatePath(path.resolve(path.dirname(parentPath), specifier));
    if (relativePath) {
      return {
        url: pathToFileURL(relativePath).href,
        shortCircuit: true,
      };
    }
  }

  if (specifier.startsWith("file:")) {
    const filePath = resolveCandidatePath(fileURLToPath(specifier));
    if (filePath) {
      return {
        url: pathToFileURL(filePath).href,
        shortCircuit: true,
      };
    }
  }

  return nextResolve(specifier, context);
}
