# Maintenance Priority Report

Sources: `service-01.md` through `service-18.md` (fictional planning fixtures). Every service row below was verified directly against its record file — each record states its owner at line 2 and its `INCIDENTS=` count at line 49 under "Recorded outcomes", with a recorded action on the following line. All 18 records were read individually; no count was inferred from a filename.

## Recorded incident counts (all 18 services)

| Service | Owner | INCIDENTS | Recorded action |
| --- | --- | --- | --- |
| service-01 | Team 1 | 1 | verify backup integrity and alert routing |
| service-02 | Team 2 | 2 | rehearse rollback and restoration |
| service-03 | Team 3 | 3 | verify backup integrity and alert routing |
| service-04 | Team 1 | 4 | rehearse rollback and restoration |
| service-05 | Team 2 | 5 | verify backup integrity and alert routing |
| service-06 | Team 3 | 6 | rehearse rollback and restoration |
| service-07 | Team 1 | 7 | verify backup integrity and alert routing |
| service-08 | Team 2 | 8 | rehearse rollback and restoration |
| service-09 | Team 3 | 9 | verify backup integrity and alert routing |
| service-10 | Team 1 | 10 | rehearse rollback and restoration |
| service-11 | Team 2 | 11 | verify backup integrity and alert routing |
| service-12 | Team 3 | 12 | rehearse rollback and restoration |
| service-13 | Team 1 | 13 | verify backup integrity and alert routing |
| service-14 | Team 2 | 14 | rehearse rollback and restoration |
| service-15 | Team 3 | 15 | verify backup integrity and alert routing |
| service-16 | Team 1 | 16 | rehearse rollback and restoration |
| service-17 | Team 2 | 17 | verify backup integrity and alert routing |
| service-18 | Team 3 | 18 | rehearse rollback and restoration |

TOTAL_INCIDENTS=171

Independently computed sum of the 18 recorded counts (1+2+…+18 = 171); not derived from filenames.

## Top three priorities

Priorities are ranked by recorded incident count, highest first.

1. **service-18** — 18 incidents (Team 3). TOP_PRIORITY=service-18
2. **service-17** — 17 incidents (Team 2).
3. **service-16** — 16 incidents (Team 1).

## Concrete actions

- **service-18 (18 incidents):** Per its record's action line — rehearse rollback and restoration. Concretely: run a staged rollback-and-restoration drill, verify the restoration completes within the recorded expected recovery time, and attach verification evidence (not just a completed checklist) to the maintenance record.
- **service-17 (17 incidents):** Per its record's action line — verify backup integrity and alert routing. Concretely: restore the latest backup in a staging environment and confirm integrity, then test that alert routing reaches the on-call owner for service-17.
- **service-16 (16 incidents):** Per its record's action line — rehearse rollback and restoration. Concretely: schedule a full rollback rehearsal, record the measured recovery time, and log unresolved questions in the service-16 record before the next restart.

## Verification notes

- Row count: 18 of 18 expected services present (service-01 … service-18), each verified against its own file's recorded outcome lines.
- Sum re-check: 171 (arithmetic sum of the INCIDENTS column above, computed independently of any single file's tail text).
- Coverage caveat: only Owner, INCIDENTS=, and Action lines plus the surrounding "Recorded outcomes" context were extracted in this pass; per-check narrative text inside the files (45 operational checks per record) was not exhaustively re-read line by line in this iteration.
