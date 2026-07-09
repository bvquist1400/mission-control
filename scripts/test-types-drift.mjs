// Schema-type drift check.
//
// Regenerates Supabase types from the linked project and diffs against the
// committed src/types/supabase.generated.ts. Fails when a migration has been
// applied without regenerating types (npm run gen:types).
//
// Requires the Supabase CLI to be installed and the project to be linked —
// this is a local/developer check, not a CI one.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const committedPath = path.join(root, "src", "types", "supabase.generated.ts");

let fresh;
try {
  fresh = execFileSync("supabase", ["gen", "types", "typescript", "--linked"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
} catch (error) {
  console.error("Could not regenerate types (is the Supabase CLI installed and the project linked?)");
  console.error(String(error?.message ?? error));
  process.exit(2);
}

const committed = fs.readFileSync(committedPath, "utf8");

const normalize = (s) => s.replace(/\r\n/g, "\n").trimEnd();

if (normalize(fresh) === normalize(committed)) {
  console.log("Schema types are in sync with the database.");
  process.exit(0);
}

console.error("Schema type drift detected: the database schema no longer matches src/types/supabase.generated.ts.");
console.error("Run `npm run gen:types` and commit the result (then fix any type errors it surfaces).");

const freshLines = normalize(fresh).split("\n");
const committedLines = normalize(committed).split("\n");
const max = Math.max(freshLines.length, committedLines.length);
let shown = 0;
for (let i = 0; i < max && shown < 20; i++) {
  if (freshLines[i] !== committedLines[i]) {
    console.error(`  line ${i + 1}:`);
    console.error(`    committed: ${committedLines[i] ?? "<missing>"}`);
    console.error(`    database:  ${freshLines[i] ?? "<missing>"}`);
    shown++;
  }
}
process.exit(1);
