# Data-Import Checklist — Local Notes App

Run top to bottom; stop at the first failed step. Do not tick a checkbox without
actually performing the check it describes.

## 1. backup

- [ ] Locate the app's data store (notes folder or database file); record its size and current note count.
- [ ] Copy the whole store to a timestamped backup, e.g. `notes-backup-YYYYMMDD-HHMM/` (or `notes.db` → `notes.db.bak-<timestamp>`).
- [ ] Check the backup: it exists, is non-zero size, and opens cleanly (for SQLite, `PRAGMA integrity_check` returns `ok`). Keep it until verification passes.

## 2. confirmation

- [ ] Inventory the import source: number of files/records, formats, total size.
- [ ] Show a summary and ask for confirmation: "Import N notes into <store>? Existing notes: M. Type `yes` to continue."
- [ ] Proceed only on an explicit typed `yes`; abort on anything else, on silence, or on timeout.
- [ ] Evaluation (dry run): parse and validate every source record without writing — required fields, encoding, duplicate IDs.
- [ ] Condition (gate before publishing): continue only if `parsed == expected` AND `fatal_errors == 0` AND the duplicate policy is decided (skip / merge / rename). Any failure → stop and report; write nothing.

## 3. rollback

- [ ] Write down the restore command before importing: quit the app, replace the store with the step-1 backup, restart.
- [ ] If the import fails mid-run: stop, quit the app cleanly, restore the backup, restart, and rerun this checklist from step 1.
- [ ] After a rollback, verify: the app opens, and the note count plus a spot-checked note match the pre-import state. Keep the backup; discard failed-import artifacts only afterwards.

## 4. verification

- [ ] Count check: the store now holds the existing M notes plus the imported N (or the count implied by the chosen duplicate policy).
- [ ] Spot-check a sample of at least 5 notes: content, tags, and dates intact; open one note in the UI.
- [ ] Loss check: every pre-import note is still present, and the backup is still intact and untouched.
- [ ] Log the result (date, counts, pass/fail). Retire the backup only after all checks pass.
