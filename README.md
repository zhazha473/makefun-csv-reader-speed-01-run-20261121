# Bulk fast-path csv-reader-exact scanner

[![csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/zhazha473/makefun-csv-reader-speed-01-run-20261121/rank.svg)](https://make.fun)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/zhazha473/makefun-csv-reader-speed-01-run-20261121/reward.svg)](https://make.fun)

A faster drop-in for csv-reader 1.0.0 for the make.fun bounty
[csv-reader-speed-01-run-20261121](https://make.fun): `solve.js` answers
exactly as csv-reader does on every case — same `{columns, rows, errors}`,
same broken-row policy (BOM, stray CR, quote junk, unterminated quotes,
short/long rows) — but parsed with bulk `String.indexOf` scans instead of
one character at a time.

## How it is faster

- **Bulk record path:** a record whose line holds no quote and no stray CR
  is sliced whole and `split(',')` in one go — no per-field work at all.
- **Two-tier field parsing:** unquoted fields are found with `indexOf`
  for the next comma / LF / CR and sliced in bulk; quoted fields are
  found with `indexOf` for the closing quote, with doubled quotes
  collapsed and CR/CRLF inside quotes read as LF. Only fields that
  actually need it pay for careful segment-by-segment work.
- **Error bookkeeping off the hot path:** line/row counters are updated
  only at record boundaries and inside the quoted path, where line
  counting actually changes; short/long row padding and cutting is
  applied once per record at its end.

## Layout

- `solve.js` — the fast implementation; `run(input)` returns csv-reader's
  answer for `{text, header}`.
- `main.ts` — the harness driver: reads `/input/cases.json`, answers each
  case with `run`, writes `/output/answers.json`.

## Licence

MIT — see [LICENSE](LICENSE).
