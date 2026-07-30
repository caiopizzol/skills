#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { localLinks, validateCatalog } from "@caiopizzol/catalog-validation";
import { markdownFiles, readCatalog } from "./read-catalog.ts";

const root = resolve(process.argv[2] ?? resolve(import.meta.dirname, "..", "..", ".."));
const errors: string[] = [];

const catalog = readCatalog(root);
for (const violation of validateCatalog(catalog)) {
  errors.push(`${violation.skill}: ${violation.detail} [${violation.rule}]`);
}

for (const markdownPath of markdownFiles(root)) {
  for (const link of localLinks(readFileSync(markdownPath, "utf8"))) {
    const where = relative(root, markdownPath);
    if (link.target === null) errors.push(`${where} has an invalid encoded link: ${link.raw}`);
    else if (!existsSync(resolve(dirname(markdownPath), link.target)))
      errors.push(`${where} links to missing ${link.target}`);
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`- ${error}`);
  console.error(
    `Skill validation failed with ${errors.length} error${errors.length === 1 ? "" : "s"}.`,
  );
  process.exit(1);
}

console.log(`Validated ${catalog.skills.length} skills and local Markdown links.`);
