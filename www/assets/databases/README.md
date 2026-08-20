# Packaged databases

`@capacitor-community/sqlite` copies any `.db` file placed here out of the APK
on first run. A file named `ironbox.db` is installed as `ironboxSQLite.db`,
which is what the connection named `ironbox` opens.

`npm run db:build` generates `ironbox.db` from `database/seed.csv`, and
`npm run build:apk` runs it automatically, so the file is a build artifact and
is not committed.

To ship a large corpus instead of the seed:

```bash
node tools/generate-database.js --count 1000000 --output build/corpus.jsonl
node tools/import-database.js --input build/corpus.jsonl
npm run build:apk
```

Be aware that a million rows adds roughly 430 MB to the APK — for corpora that
size, prefer importing on the device (developer panel → Import Dialogues…).
