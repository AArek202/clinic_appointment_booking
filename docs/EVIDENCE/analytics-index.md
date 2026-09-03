# Index evidence: `appointments_doctor_start_at_idx`

**Query:** the doctor monthly analytics query
(`clinic_appointment_booking/src/analytics/analytics.sql.ts`), run for the busiest doctor and one month.
Reproduce with `clinic_appointment_booking/scripts/analytics-explain.sql`.

**Dataset:** `clinic_appointment_booking/scripts/analytics-perf-seed.sql` — 200 doctors, skewed so ten of
them hold 8,000 appointments each and the rest hold 500, roughly 14% cancelled (175,000 perf rows total).

**Index:** `CREATE INDEX appointments_doctor_start_at_idx ON appointments (doctor_id, start_at)`

**Why it is separate from the exclusion index:** `appointments_no_overlap` is
`WHERE status = 'CONFIRMED'`, and this query has to count cancelled rows too.
The `stats` CTE therefore cannot use the partial GiST index. Plan 5 created the
same btree as `appointments_doctor_start_idx`; migration
`AddAppointmentsDoctorStartAtIndex1757462400000` standardises the name.

**Result:** execution time fell from **29.1 ms** to **3.4 ms** (~8.5× faster).
The `stats` scan changed from `Seq Scan on appointments` (175,012 rows) to
`Bitmap Index Scan on appointments_doctor_start_at_idx` (1,440 rows for the
month). The `hourly` CTE also uses the new index after creation; before
measurement it used the partial GiST exclusion index because it filters
`CONFIRMED` only.

## Before

```text
Busiest doctor id: 0cf9ab5f-4298-4439-a3df-51b3617f38cb
                                                                                       QUERY PLAN                                                                                        
-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 Nested Loop  (cost=7390.81..7390.89 rows=1 width=100) (actual time=27.380..27.388 rows=1 loops=1)
   Buffers: shared hit=3293
   CTE params
     ->  Result  (cost=0.00..0.01 rows=1 width=64) (actual time=0.003..0.004 rows=1 loops=1)
   CTE hourly
     ->  GroupAggregate  (cost=1800.49..1802.57 rows=83 width=12) (actual time=1.727..1.849 rows=24 loops=1)
           Group Key: ((EXTRACT(hour FROM (a_1.start_at AT TIME ZONE p_4.tz)))::integer)
           Buffers: shared hit=257
           ->  Sort  (cost=1800.49..1800.70 rows=83 width=4) (actual time=1.717..1.773 rows=1234 loops=1)
                 Sort Key: ((EXTRACT(hour FROM (a_1.start_at AT TIME ZONE p_4.tz)))::integer)
                 Sort Method: quicksort  Memory: 49kB
                 Buffers: shared hit=257
                 ->  Nested Loop  (cost=57.90..1797.85 rows=83 width=4) (actual time=0.598..1.563 rows=1234 loops=1)
                       Buffers: shared hit=257
                       ->  CTE Scan on params p_4  (cost=0.00..0.02 rows=1 width=64) (actual time=0.001..0.001 rows=1 loops=1)
                       ->  Bitmap Heap Scan on appointments a_1  (cost=57.90..1796.37 rows=83 width=24) (actual time=0.546..0.977 rows=1234 loops=1)
                             Recheck Cond: ((p_4.doctor_id = doctor_id) AND (status = 'CONFIRMED'::text))
                             Filter: ((start_at >= p_4.month_start) AND (start_at < p_4.month_end))
                             Rows Removed by Filter: 5624
                             Heap Blocks: exact=139
                             Buffers: shared hit=257
                             ->  Bitmap Index Scan on appointments_no_overlap  (cost=0.00..57.88 rows=747 width=0) (actual time=0.338..0.338 rows=6858 loops=1)
                                   Index Cond: (doctor_id = p_4.doctor_id)
                                   Buffers: shared hit=118
   ->  Nested Loop  (cost=5443.22..5443.25 rows=1 width=80) (actual time=26.871..26.874 rows=1 loops=1)
         Buffers: shared hit=3278
         ->  Aggregate  (cost=5439.45..5439.46 rows=1 width=48) (actual time=24.857..24.859 rows=1 loops=1)
               Buffers: shared hit=3018
               ->  Hash Join  (cost=0.03..5437.51 rows=97 width=26) (actual time=11.021..24.311 rows=1440 loops=1)
                     Hash Cond: (a.doctor_id = p.doctor_id)
                     Join Filter: ((a.start_at >= p.month_start) AND (a.start_at < p.month_end))
                     Rows Removed by Join Filter: 6560
                     Buffers: shared hit=3018
                     ->  Seq Scan on appointments a  (cost=0.00..4768.12 rows=175012 width=42) (actual time=0.009..9.873 rows=175012 loops=1)
                           Buffers: shared hit=3018
                     ->  Hash  (cost=0.02..0.02 rows=1 width=32) (actual time=0.023..0.024 rows=1 loops=1)
                           Buckets: 1024  Batches: 1  Memory Usage: 9kB
                           ->  CTE Scan on params p  (cost=0.00..0.02 rows=1 width=32) (actual time=0.007..0.008 rows=1 loops=1)
         ->  Aggregate  (cost=3.76..3.77 rows=1 width=32) (actual time=2.009..2.010 rows=1 loops=1)
               Buffers: shared hit=260
               InitPlan 3 (returns $5)
                 ->  Aggregate  (cost=1.87..1.88 rows=1 width=8) (actual time=0.132..0.133 rows=1 loops=1)
                       ->  CTE Scan on hourly h2  (cost=0.00..1.66 rows=83 width=8) (actual time=0.000..0.129 rows=24 loops=1)
               ->  Sort  (cost=1.88..1.88 rows=1 width=4) (actual time=1.955..1.956 rows=11 loops=1)
                     Sort Key: h.hour
                     Sort Method: quicksort  Memory: 25kB
                     Buffers: shared hit=260
                     ->  CTE Scan on hourly h  (cost=0.00..1.87 rows=1 width=4) (actual time=1.864..1.866 rows=11 loops=1)
                           Filter: (bookings = $5)
                           Rows Removed by Filter: 13
                           Buffers: shared hit=257
   ->  Aggregate  (cost=145.01..145.02 rows=1 width=32) (actual time=0.471..0.473 rows=1 loops=1)
         Buffers: shared hit=15
         ->  Nested Loop  (cost=30.49..109.01 rows=2400 width=32) (actual time=0.374..0.457 rows=20 loops=1)
               Buffers: shared hit=15
               ->  Nested Loop  (cost=30.45..60.97 rows=24 width=124) (actual time=0.328..0.363 rows=21 loops=1)
                     Buffers: shared hit=15
                     ->  Aggregate  (cost=4.38..4.39 rows=1 width=32) (actual time=0.101..0.102 rows=1 loops=1)
                           Buffers: shared hit=3
                           ->  Nested Loop  (cost=0.28..4.37 rows=1 width=16) (actual time=0.068..0.071 rows=2 loops=1)
                                 Buffers: shared hit=3
                                 ->  CTE Scan on params p_3  (cost=0.00..0.02 rows=1 width=32) (actual time=0.000..0.001 rows=1 loops=1)
                                 ->  Index Only Scan using blocks_doctor_id_start_at_end_at_idx on blocks b  (cost=0.28..4.34 rows=1 width=32) (actual time=0.066..0.067 rows=2 loops=1)
                                       Index Cond: ((doctor_id = p_3.doctor_id) AND (start_at < p_3.month_end) AND (end_at > p_3.month_start))
                                       Heap Fetches: 0
                                       Buffers: shared hit=3
                     ->  Hash Join  (cost=26.08..56.35 rows=24 width=92) (actual time=0.225..0.258 rows=21 loops=1)
                           Hash Cond: ((EXTRACT(dow FROM (((p_2.month_start AT TIME ZONE p_2.tz))::date + offset_days.offset_days)))::integer = s.day_of_week)
                           Buffers: shared hit=12
                           ->  Nested Loop  (cost=0.02..20.04 rows=1000 width=44) (actual time=0.017..0.022 rows=31 loops=1)
                                 ->  CTE Scan on params p_2  (cost=0.00..0.02 rows=1 width=48) (actual time=0.000..0.000 rows=1 loops=1)
                                 ->  Function Scan on generate_series offset_days  (cost=0.02..10.02 rows=1000 width=4) (actual time=0.015..0.017 rows=31 loops=1)
                           ->  Hash  (cost=26.00..26.00 rows=5 width=50) (actual time=0.177..0.177 rows=5 loops=1)
                                 Buckets: 1024  Batches: 1  Memory Usage: 9kB
                                 Buffers: shared hit=12
                                 ->  Hash Join  (cost=0.03..26.00 rows=5 width=50) (actual time=0.039..0.170 rows=5 loops=1)
                                       Hash Cond: (s.doctor_id = p_1.doctor_id)
                                       Buffers: shared hit=12
                                       ->  Seq Scan on schedules s  (cost=0.00..22.12 rows=1012 width=34) (actual time=0.006..0.080 rows=1012 loops=1)
                                             Buffers: shared hit=12
                                       ->  Hash  (cost=0.02..0.02 rows=1 width=48) (actual time=0.008..0.008 rows=1 loops=1)
                                             Buckets: 1024  Batches: 1  Memory Usage: 9kB
                                             ->  CTE Scan on params p_1  (cost=0.00..0.02 rows=1 width=48) (actual time=0.001..0.001 rows=1 loops=1)
               ->  Function Scan on unnest free  (cost=0.03..1.03 rows=100 width=32) (actual time=0.004..0.004 rows=1 loops=21)
 Planning:
   Buffers: shared hit=592 read=4
 Planning Time: 20.400 ms
 Execution Time: 29.095 ms
(88 rows)
```

## After

```text
Busiest doctor id: 0cf9ab5f-4298-4439-a3df-51b3617f38cb
                                                                                       QUERY PLAN                                                                                        
-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 Nested Loop  (cost=825.01..825.09 rows=1 width=100) (actual time=2.724..2.740 rows=1 loops=1)
   Buffers: shared hit=80 read=10
   CTE params
     ->  Result  (cost=0.00..0.01 rows=1 width=64) (actual time=0.003..0.003 rows=1 loops=1)
   CTE hourly
     ->  GroupAggregate  (cost=337.82..339.87 rows=82 width=12) (actual time=0.957..1.065 rows=24 loops=1)
           Group Key: ((EXTRACT(hour FROM (a_1.start_at AT TIME ZONE p_4.tz)))::integer)
           Buffers: shared hit=36
           ->  Sort  (cost=337.82..338.03 rows=82 width=4) (actual time=0.948..0.992 rows=1234 loops=1)
                 Sort Key: ((EXTRACT(hour FROM (a_1.start_at AT TIME ZONE p_4.tz)))::integer)
                 Sort Method: quicksort  Memory: 49kB
                 Buffers: shared hit=36
                 ->  Nested Loop  (cost=5.63..335.21 rows=82 width=4) (actual time=0.088..0.813 rows=1234 loops=1)
                       Buffers: shared hit=36
                       ->  CTE Scan on params p_4  (cost=0.00..0.02 rows=1 width=64) (actual time=0.001..0.002 rows=1 loops=1)
                       ->  Bitmap Heap Scan on appointments a_1  (cost=5.63..333.76 rows=82 width=24) (actual time=0.076..0.278 rows=1234 loops=1)
                             Recheck Cond: ((p_4.doctor_id = doctor_id) AND (start_at >= p_4.month_start) AND (start_at < p_4.month_end))
                             Filter: (status = 'CONFIRMED'::text)
                             Rows Removed by Filter: 206
                             Heap Blocks: exact=26
                             Buffers: shared hit=36
                             ->  Bitmap Index Scan on appointments_doctor_start_at_idx  (cost=0.00..5.61 rows=95 width=0) (actual time=0.067..0.068 rows=1440 loops=1)
                                   Index Cond: ((doctor_id = p_4.doctor_id) AND (start_at >= p_4.month_start) AND (start_at < p_4.month_end))
                                   Buffers: shared hit=10
   ->  Nested Loop  (cost=340.12..340.15 rows=1 width=80) (actual time=2.037..2.044 rows=1 loops=1)
         Buffers: shared hit=65 read=10
         ->  Aggregate  (cost=336.40..336.41 rows=1 width=48) (actual time=0.892..0.896 rows=1 loops=1)
               Buffers: shared hit=26 read=10
               ->  Nested Loop  (cost=5.63..334.50 rows=95 width=26) (actual time=0.184..0.446 rows=1440 loops=1)
                     Buffers: shared hit=26 read=10
                     ->  CTE Scan on params p  (cost=0.00..0.02 rows=1 width=32) (actual time=0.005..0.006 rows=1 loops=1)
                     ->  Bitmap Heap Scan on appointments a  (cost=5.63..333.53 rows=95 width=42) (actual time=0.175..0.295 rows=1440 loops=1)
                           Recheck Cond: ((p.doctor_id = doctor_id) AND (start_at >= p.month_start) AND (start_at < p.month_end))
                           Heap Blocks: exact=26
                           Buffers: shared hit=26 read=10
                           ->  Bitmap Index Scan on appointments_doctor_start_at_idx  (cost=0.00..5.61 rows=95 width=0) (actual time=0.166..0.167 rows=1440 loops=1)
                                 Index Cond: ((doctor_id = p.doctor_id) AND (start_at >= p.month_start) AND (start_at < p.month_end))
                                 Buffers: shared read=10
         ->  Aggregate  (cost=3.72..3.73 rows=1 width=32) (actual time=1.143..1.146 rows=1 loops=1)
               Buffers: shared hit=39
               InitPlan 3 (returns $5)
                 ->  Aggregate  (cost=1.85..1.86 rows=1 width=8) (actual time=0.112..0.113 rows=1 loops=1)
                       ->  CTE Scan on hourly h2  (cost=0.00..1.64 rows=82 width=8) (actual time=0.000..0.110 rows=24 loops=1)
               ->  Sort  (cost=1.85..1.86 rows=1 width=4) (actual time=1.136..1.137 rows=11 loops=1)
                     Sort Key: h.hour
                     Sort Method: quicksort  Memory: 25kB
                     Buffers: shared hit=39
                     ->  CTE Scan on hourly h  (cost=0.00..1.84 rows=1 width=4) (actual time=1.072..1.074 rows=11 loops=1)
                           Filter: (bookings = $5)
                           Rows Removed by Filter: 13
                           Buffers: shared hit=36
   ->  Aggregate  (cost=145.01..145.02 rows=1 width=32) (actual time=0.678..0.683 rows=1 loops=1)
         Buffers: shared hit=15
         ->  Nested Loop  (cost=30.49..109.01 rows=2400 width=32) (actual time=0.581..0.665 rows=20 loops=1)
               Buffers: shared hit=15
               ->  Nested Loop  (cost=30.45..60.97 rows=24 width=124) (actual time=0.564..0.600 rows=21 loops=1)
                     Buffers: shared hit=15
                     ->  Aggregate  (cost=4.38..4.39 rows=1 width=32) (actual time=0.154..0.155 rows=1 loops=1)
                           Buffers: shared hit=3
                           ->  Nested Loop  (cost=0.28..4.37 rows=1 width=16) (actual time=0.124..0.127 rows=2 loops=1)
                                 Buffers: shared hit=3
                                 ->  CTE Scan on params p_3  (cost=0.00..0.02 rows=1 width=32) (actual time=0.000..0.001 rows=1 loops=1)
                                 ->  Index Only Scan using blocks_doctor_id_start_at_end_at_idx on blocks b  (cost=0.28..4.34 rows=1 width=32) (actual time=0.121..0.122 rows=2 loops=1)
                                       Index Cond: ((doctor_id = p_3.doctor_id) AND (start_at < p_3.month_end) AND (end_at > p_3.month_start))
                                       Heap Fetches: 0
                                       Buffers: shared hit=3
                     ->  Hash Join  (cost=26.08..56.35 rows=24 width=92) (actual time=0.407..0.440 rows=21 loops=1)
                           Hash Cond: ((EXTRACT(dow FROM (((p_2.month_start AT TIME ZONE p_2.tz))::date + offset_days.offset_days)))::integer = s.day_of_week)
                           Buffers: shared hit=12
                           ->  Nested Loop  (cost=0.02..20.04 rows=1000 width=44) (actual time=0.024..0.031 rows=31 loops=1)
                                 ->  CTE Scan on params p_2  (cost=0.00..0.02 rows=1 width=48) (actual time=0.000..0.001 rows=1 loops=1)
                                 ->  Function Scan on generate_series offset_days  (cost=0.02..10.02 rows=1000 width=4) (actual time=0.021..0.023 rows=31 loops=1)
                           ->  Hash  (cost=26.00..26.00 rows=5 width=50) (actual time=0.344..0.346 rows=5 loops=1)
                                 Buckets: 1024  Batches: 1  Memory Usage: 9kB
                                 Buffers: shared hit=12
                                 ->  Hash Join  (cost=0.03..26.00 rows=5 width=50) (actual time=0.173..0.338 rows=5 loops=1)
                                       Hash Cond: (s.doctor_id = p_1.doctor_id)
                                       Buffers: shared hit=12
                                       ->  Seq Scan on schedules s  (cost=0.00..22.12 rows=1012 width=34) (actual time=0.010..0.105 rows=1012 loops=1)
                                             Buffers: shared hit=12
                                       ->  Hash  (cost=0.02..0.02 rows=1 width=48) (actual time=0.131..0.131 rows=1 loops=1)
                                             Buckets: 1024  Batches: 1  Memory Usage: 9kB
                                             ->  CTE Scan on params p_1  (cost=0.00..0.02 rows=1 width=48) (actual time=0.001..0.002 rows=1 loops=1)
               ->  Function Scan on unnest free  (cost=0.03..1.03 rows=100 width=32) (actual time=0.003..0.003 rows=1 loops=21)
 Planning:
   Buffers: shared hit=588
 Planning Time: 8.354 ms
 Execution Time: 3.420 ms
(88 rows)
```
