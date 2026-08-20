# Task external source backfill

After migration 054 has been applied, the TaskAdvisor backfill is read-only
unless `--apply` is supplied.

```bash
npm run backfill:task-external-source:dry-run
npm run backfill:task-external-source:apply
```

The dry run prints a `Proposed writes` table containing each task UUID, title,
resolved TaskAdvisor ID, and whether the ID came from `source_url` or a
`csv-*` tag. It then prints the proposed-write and conflict counts.

If two tasks for the same user resolve to the same TaskAdvisor ID, the script
prints both task UUIDs and titles. Dry-run still exits without writing; apply
mode refuses all writes and exits unsuccessfully until the duplicate is
resolved manually. Existing `csv-*` tags are never removed.
