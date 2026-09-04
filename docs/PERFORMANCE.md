# Index Performance Evidence

Measured against the seeded dataset: 200 doctors, 2,029,903 appointments
(300,682 cancelled, 14.8%), 2,081,654 notifications, 60,000 waiting-list
entries, spread over 24 months with a skewed distribution (`docs/TESTING.md`).
Busiest doctor holds 24,386 rows; quietest holds 3,875 (6.3× skew).

Every query is measured against the **busiest** doctor, not an average one.
The context block at the top of `docs/performance/raw-2026-09-04.txt` records which
doctor, patient, month and slot were used.

**Method.** Each "without index" plan is produced by dropping the index inside a
transaction and rolling that transaction back, so the index is genuinely absent
for the measurement and genuinely present afterwards. `SET jit = off` is applied
throughout, because JIT compilation adds variance to large sequential scans and
none to index lookups. The whole script is run twice and the second transcript
is kept, so both sides are measured warm.

**Environment.** Windows 10 Education (build 19045), Intel Core i7-8750H (6 cores /
12 threads), 16 GB RAM, Docker Desktop running PostgreSQL 16.15 on
`x86_64-pc-linux-musl` (Alpine). Seed load (`npm run seed:reset`) took 1,404.9 s
wall time; the `appointments+notifs` COPY phase alone took 1,377.7 s.

| # | Index | Named query | Scan without | Rows removed by filter | Exec ms without | Scan with | Exec ms with | Speed-up |
|---|---|---|---|---|---|---|---|---|
| Q1 | `appointments_no_overlap` | taken slots, one doctor, 30 days | Bitmap Heap Scan (via patient GiST) | 71,142 | 277.6 | Bitmap Index Scan (GiST) | 0.6 | 454× |
| Q1b | (btree fallback) | same query, GiST dropped, btree kept | Bitmap Heap Scan | 0 | 251.2 | — | — | — |
| Q2 | `appointments_patient_start_idx` | list my appointments | Parallel Seq Scan | 676,621 | 105.5 | Index Scan Backward (btree) | 0.2 | 507× |
| Q2b | (GiST fallback) | same query, btree dropped | Parallel Seq Scan | 676,621 | 70.3 | — | — | — |
| Q3 | `appointments_doctor_start_at_idx` | monthly analytics aggregate | Parallel Seq Scan | 676,249 | 71.0 | Bitmap Index Scan (btree) | 0.7 | 95× |
| Q4 | `blocks_doctor_id_start_at_end_at_idx` | blocks overlapping a window | Bitmap Heap Scan (GiST) | 19 | 0.1 | Bitmap Index Scan (btree) | 0.1 | 2× |
| Q5 | `waiting_list_slot_status_idx` | FIFO candidates for a freed slot | Index Scan (`one_active`) | 0 | 0.1 | Index Scan (slot+status) | 0.1 | 1.4× |
| Q6 | `waiting_list_one_active` | already in this queue? | Seq Scan | 59,999 | 6.8 | Index Scan (unique partial) | 0.05 | 144× |
| Q7 | `notifications_unique_per_type` | job idempotency lookup | Parallel Seq Scan | 693,884 | 65.3 | Index Scan (unique) | 0.06 | 1,070× |
| Q8 | `notifications_pending_due_idx` | due but unsent notifications | Parallel Seq Scan + sort | 178,719 | 116.6 | Index Scan (partial) | 0.4 | 284× |

Index names match the live schema (see `scripts/perf/explain-evidence.sql` header).

## Q1 — availability

**Without any appointments index (a)**

```text
 Bitmap Heap Scan on appointments
   Filter: (doctor_id = '7c11aa55-fc25-43b1-9f5e-73c8fdb08569')
   Rows Removed by Filter: 71142
   -> Bitmap Index Scan on appointments_patient_no_overlap
 Execution Time: 277.614 ms
```

Dropping both doctor indexes leaves the patient GiST constraint index as the only
range-capable structure, so (a) is not a pure sequential scan — but the heap
recheck still discards 71k rows that belong to other doctors.

**With the GiST exclusion index (c)**

```text
 Bitmap Heap Scan on appointments
   -> Bitmap Index Scan on appointments_no_overlap
       Index Cond: (doctor_id = ... AND tstzrange(...) && tstzrange(...))
 Execution Time: 0.612 ms
```

Both `doctor_id` equality and the half-open range overlap are resolved in the
GiST index condition. No rows are discarded on the heap filter for doctor
identity; the planner reads 869 confirmed slots in under a millisecond.

**Q1b (btree only).** Keeping `appointments_doctor_start_at_idx` while dropping the
GiST constraint still costs 251 ms. The btree narrows to one doctor quickly, but
the range-overlap predicate still forces a bitmap over tens of thousands of rows.
The GiST index exists for this query shape, not the btree.

## Q2 — list my appointments

**Without the patient btree (a)**

```text
 Parallel Seq Scan on appointments
   Filter: (patient_id = '3668c3cb-9f46-4890-9384-6549b7001606')
   Rows Removed by Filter: 676621
 Execution Time: 105.515 ms
```

**With the btree index (c)**

```text
 Index Scan Backward using appointments_patient_start_idx
   Index Cond: (patient_id = '3668c3cb-9f46-4890-9384-6549b7001606')
 Execution Time: 0.208 ms
```

The backward index scan returns 39 rows already sorted by `start_at DESC`, which
is exactly what the cancel-ownership and list endpoints need.

**Q2b (GiST only).** Dropping the btree but keeping `appointments_patient_no_overlap`
still performs a parallel sequential scan with 676,621 rows removed. The GiST
index cannot serve `ORDER BY start_at DESC` and does not eliminate the sort.
The btree is not redundant.

## Q3 — monthly analytics

**Without the index (a)**

```text
 Parallel Seq Scan on appointments
   Filter: (doctor_id = ... AND start_at >= ... AND start_at < ...)
   Rows Removed by Filter: 676249
 Execution Time: 71.038 ms
```

**With the index (b)**

```text
 Bitmap Index Scan on appointments_doctor_start_at_idx
   Index Cond: (doctor_id = ... AND start_at >= ... AND start_at < ...)
 Execution Time: 0.747 ms
```

This query counts cancelled appointments, so it cannot use the partial GiST index
on confirmed rows only. The non-partial `(doctor_id, start_at)` btree is what
makes month-bounded analytics stay sub-millisecond on the busiest doctor.

## Q4 — blocks overlapping a window

**Without the btree (a)** — 4,153 blocks, 1.3 MB total:

```text
 Bitmap Heap Scan on blocks
   Rows Removed by Filter: 19
   -> Bitmap Index Scan on blocks_no_overlap
 Execution Time: 0.122 ms
```

**With the btree (b)**

```text
 Bitmap Index Scan on blocks_doctor_id_start_at_end_at_idx
   Index Cond: (doctor_id = ... AND start_at < ... AND end_at > ...)
 Execution Time: 0.054 ms
```

Neither plan uses a sequential scan. The GiST constraint index already covers
`doctor_id` equality; the btree adds the time-range predicates into the index
condition and avoids 19 heap recheck rows. At seed scale both plans are
sub-millisecond — the btree does not pay for itself measurably yet, but blocks
are written rarely and the table will grow with clinic history.

## Q5 — waiting-list assignment

**Without `waiting_list_slot_status_idx` (a)**

```text
 Index Scan using waiting_list_one_active
 Execution Time: 0.120 ms
```

**With the index (b)**

```text
 Index Scan using waiting_list_slot_status_idx
   Index Cond: (doctor_id = ... AND slot_start_at = ... AND status = 'WAITING')
 Execution Time: 0.084 ms
```

Dropping the Q5 index leaves the partial unique index, which still finds rows for
the same doctor and slot. The dedicated `(doctor_id, slot_start_at, status)`
index includes `status = 'WAITING'` in the index condition and avoids a sort over
five rows. The gain is small at 60k entries but the index matches the assignment
job's exact predicate.

## Q6 — already in this queue?

**Without the index (a)**

```text
 Seq Scan on waiting_list
   Rows Removed by Filter: 59999
 Execution Time: 6.753 ms
```

**With the index (b)**

```text
 Index Scan using waiting_list_one_active
 Execution Time: 0.047 ms
```

The partial unique index is an exact match for the lookup — one index tuple, no
filter waste.

## Q7 — notification idempotency

**Without the unique constraint (a)**

```text
 Parallel Seq Scan on notifications
   Rows Removed by Filter: 693884
 Execution Time: 65.274 ms
```

**With the index (b)**

```text
 Index Scan using notifications_unique_per_type
 Execution Time: 0.061 ms
```

Every reminder job asks "have I already enqueued this appointment?" once. Without
the unique index that is a scan of two million rows; with it, one index lookup.

## Q8 — sweeper due notifications

**Without the partial index (a)**

```text
 Parallel Seq Scan on notifications
   Filter: ((status = 'PENDING') AND (scheduled_at <= now()))
   Rows Removed by Filter: 178719
 Execution Time: 116.638 ms
```

**With the index (b)**

```text
 Index Scan using notifications_pending_due_idx
   Index Cond: (scheduled_at <= now())
 Execution Time: 0.411 ms
```

815,835 pending notifications exist. Without the partial index PostgreSQL reads
and sorts hundreds of thousands of rows to find the first 100 due; with it, the
walk stops after 100 index entries.

## Findings

- **GiST on appointments (`appointments_no_overlap`)** is essential for
  availability range queries — 454× faster than any alternative measured here,
  and the btree doctor index does not substitute for overlap semantics.
- **`appointments_patient_start_idx`** is essential for patient list/cancel
  lookups. The patient GiST constraint index does not help (Q2b still scans 2M
  rows).
- **`appointments_doctor_start_at_idx`** is essential for analytics that include
  cancelled rows (95× speed-up). This is the justification for a second index on
  the write-heavy table.
- **`blocks_doctor_id_start_at_end_at_idx`** shows marginal benefit at 4k rows
  because `blocks_no_overlap` already indexes `doctor_id`. Keep it: write cost
  is negligible for blocks, and range predicates move into the index as the
  table grows.
- **`waiting_list_slot_status_idx`** helps modestly while **`waiting_list_one_active`**
  is decisive for duplicate detection (144×).
- **Notification indexes** both earn their place on a 2M-row table (1,070× and
  284×).

No index measured here should be dropped. Q2b explicitly shows the patient GiST
index is not a substitute for the patient btree.

## What this does not measure

Write cost. Every index on `appointments` is paid for on insert, and
`appointments` is the write-heavy table. The index list is deliberately short
for that reason (`docs/DATABASE.md`), but no benchmark here quantifies it.

Raw transcript: [`docs/performance/raw-2026-09-04.txt`](performance/raw-2026-09-04.txt)
