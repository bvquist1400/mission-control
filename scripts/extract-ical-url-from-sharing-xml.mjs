#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';

async function main() {
  const sourcePath = process.argv[2] ?? 'data/calendar/work-calendar.xml';
  const resolvedPath = path.isAbsolute(sourcePath) ? sourcePath : path.join(process.cwd(), sourcePath);

  const xml = await readFile(resolvedPath, 'utf8');
  const match = xml.match(/<ICalUrl[^>]*>([\s\S]*?)<\/ICalUrl>/i);

  if (!match?.[1]) {
    console.error('No <ICalUrl> found in sharing XML.');
    process.exitCode = 1;
    return;
  }

  const icalUrl = match[1].trim();
  console.log(icalUrl);
}

main().catch((error) => {
  console.error(`Failed to read XML: ${error instanceof Error ? error.message : 'Unknown error'}`);
  process.exitCode = 1;
});
