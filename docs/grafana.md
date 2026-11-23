# Sclone logs in Grafana (Loki)

Sclone writes one [logfmt](https://brandur.org/logfmt) line per event on the standard output. Under systemd, journald
stores them and a shipper (Grafana Alloy, Promtail...) sends them to Loki. Every query below parses the lines with
`| logfmt`: no change is required in the shipping pipeline.

A ready-to-import dashboard is available in [`grafana-dashboard.json`](./grafana-dashboard.json).

## Log format

```
ts=2026-11-19T09:57:25.071Z level=info job=my-sync run=089a9f5b event=sync_start msg="Synchronisation started" mode=unidirectional source=s3:my-bucket target=s3:my-bucket-copy delete=true dry_run=false cron=true
ts=2026-11-19T09:57:25.087Z level=info job=my-sync run=089a9f5b event=listing_done msg="target listed" side=target storage=s3 bucket=my-bucket-copy objects=5 bytes=15000 duration_ms=4
ts=2026-11-19T09:57:25.088Z level=info job=my-sync run=089a9f5b event=listing_done msg="source listed" side=source storage=s3 bucket=my-bucket objects=5 bytes=15000 duration_ms=4
ts=2026-11-19T09:57:25.089Z level=info job=my-sync run=089a9f5b event=sync_end msg="Synchronisation success" status=success duration_ms=16 uploaded=0 uploaded_bytes=0 deleted=0 skipped=0 failed=0 source_objects=5 target_objects=5 source_bytes=15000 target_bytes=15000
```

- The first fields are always, in this order: `ts` (ISO 8601, UTC, milliseconds), `level` (`debug`, `info`, `warn`, `error`), `job`, `run` (only during a synchronisation), `event`, `msg`.
- `job`: the `name` option of the configuration, or the `SCLONE_NAME` environment variable (which wins), otherwise the name of the working directory. Give each instance its own name, without spaces: a name with a space is written quoted (`job="my sync"`), which the line filters below do not match.
- `run`: a random id of 8 hexadecimal characters, new for each synchronisation: every line of a run has the same id, use it to read one run (`|= "run=089a9f5b"`).
- `event`: a stable snake_case name. The events and their fields below are the contract of the dashboards: they are not renamed without a major version.
- Values: written as-is when they contain no space, `=`, `"`, `\` or control character, otherwise quoted with `\"`, `\\`, `\n`, `\r`, `\t` escaped, and the other control characters (C0, C1, DEL), the line separators (U+2028, U+2029) and the bidirectional controls written `\uXXXX`. A line never spans several lines. A value longer than 2048 characters (once escaped) ends with `…`; a line longer than 16 000 characters drops the fields which do not fit and ends with `truncated=true`, under the journald limit (`LineMax`). Durations are integers in milliseconds (`*_ms`), sizes integers in bytes. A field without value is omitted. Credentials are never logged.
- Levels: `info` by default, set with the `logLevel` option or the `SCLONE_LOG_LEVEL` environment variable (case-insensitive). A synchronisation without any change writes 4 lines at `info` with a `cron` (6 lines without `cron`: the connection is part of the run, plus 2 `storage_client` lines per Swift storage, "connection..." and "connected!").

## Events

| Event | Level | When | Fields |
|---|---|---|---|
| `sync_start` | info | start of each run | `mode`, `source` (`s3:bucket`), `target`, `delete`, `dry_run`, `cron` (boolean: `true` if the run was started by a cron, unlike the `cron` field of `cron_scheduled` and `config_error`, the expression) |
| `storage_connected` | info | connection of a storage: once at startup with a `cron`, at the start of the run otherwise | `side` (`source`, `target`), `storage` (`s3`, `swift`), `bucket` |
| `storage_connect_failed` | error | a storage cannot be connected. Without `cron` the run ends with `sync_end status=failed` | `side`, `storage`, `bucket`, `error` |
| `cron_scheduled` | info | once at startup with a `cron` | `cron` (the expression, such as `*/3 * * * *`) |
| `listing_done` | info | listing of one storage done | `side`, `storage`, `bucket`, `objects`, `bytes` (sum of the sizes), `duration_ms`, `ranges` (key ranges listed in parallel, `1`: sequential) |
| `listing_sequential` | debug | a storage is listed sequentially | `side`, `storage`, `bucket`, `reason` (`no_cache`: first run, `small`, `concurrency_1`) |
| `listing_fallback` | warn | a listing by key ranges is invalid (not strictly increasing, overlapping or non-contiguous ranges, page over twice the page size: `reason=oversized_page`): the storage is listed again sequentially | `side`, `storage`, `bucket`, `reason` |
| `listing_retry` | warn | a listing page, or the S3 connection check (`op=connect`), failed and is requested again | `side`, `storage`, `bucket`, `op` (connection check only), `retry`, `max_retry`, `delay_ms`, `error` |
| `sync_plan` | info, debug if empty | operations computed. `upload_*` are new files, `update_*` changed files, `upload_*_bytes` the size of both | `upload_target`, `update_target`, `delete_target`, `upload_source`, `update_source`, `delete_source`, `upload_target_bytes`, `upload_source_bytes`, `conflicts` (bidirectional, if any), `etag_resolved` (number of `HEAD` requests sent to resolve opaque etags, if any) |
| `sync_conflict` | warn | bidirectional: both sides changed (or a file differs on both sides without cache), at most 100 lines per run | `key`, `reason` (`both_new`, `both_modified`, `deleted_modified`), `winner` (`source`, `target`), `source_etag`, `source_bytes`, `source_lastmodified`, `target_etag`, `target_bytes`, `target_lastmodified` (`*_etag=deleted` for a deleted version) |
| `deletion_refused` | error | the plan exceeds `maxDeletion`, deletes files while a side is empty (listed empty, or none of its listed files was synchronised: `allowEmptySide`; one line per guard), or deletes files on a Swift container with `X-Versions-Location`: the refused deletions are not done (all of them for `max_deletion` and `empty_side`, the ones of `side` for `swift_versions_stack`), the uploads still run, and the run fails | `reason` (`max_deletion`, `empty_side`, `swift_versions_stack`), `side` (the empty side for `empty_side`, the refused side for `swift_versions_stack`), `delete_target`, `delete_source` (planned), `max_deletion` |
| `deletion_skipped` | warn | files missing from a listing were not deleted from the other side: still present (`HEAD` 2xx, their cache is kept), or not confirmed (the `HEAD` failed after the retries: counted in `failed`, the run fails) | `reason` (`still_present`, `not_confirmed`), `count`, `checked` (deletions checked), `duration_ms` |
| `swift_versions_stack` | error | at connection, with `delete`: the Swift container has `X-Versions-Location` (a `DELETE` restores the previous version). The deletions on this side are refused for the life of the process (`deletion_refused`) | `side`, `storage`, `bucket`, `versions_location` |
| `etag_resolved` | debug | opaque etags resolved with `HEAD` requests | `resolved`, `unresolved`, `duration_ms` |
| `transfer_failed` | warn | an operation failed (one line per attempt, at most `logMaxFailures` per queue and run) | `queue`, `op` (`upload`, `delete`), `direction` (`source_to_target`, `target_to_source`), `phase` (`download`, `upload`, `delete`), `key` (the first key of a deleted chunk), `count` (deleted chunks only), `status` (HTTP status, when known), `code` (S3 error code such as `AccessDenied`, or network error code such as `ECONNRESET`, when known), `reason` (`permanent`: not retried, `too_large`: larger than 5 GiB, the limit of a single upload), `error`, `try` (0 = first attempt) |
| `transfer_skipped` | warn | a file not copied by this run, which is not a failure: deleted after the listing (download `404`). Its cache is kept, the next run plans it again. Shares the `logMaxFailures` cap of `transfer_failed` | `queue`, `op`, `direction`, `phase` (`download`), `key`, `status` (`404`), `reason` (`source_gone`), `error` |
| `transfer_failed_summary` | warn | end of a queue, if `transfer_failed` or `transfer_skipped` lines were omitted | `queue`, `op`, `direction`, `omitted`, `max` |
| `sync_end` | info, error if failed, warn if interrupted | end of each run: the single line used by most panels. `interrupted`: the process received `SIGTERM` (`systemctl stop`/`restart`) or `SIGINT` during the run; the lock is released, the cache is not saved (the previous one is kept), and the process exits with code 143 (`SIGTERM`) or 130 (`SIGINT`). It counts as not successful in the success rate and the last run status | `status` (`success`, `failed`, `dry_run`, `interrupted`), `duration_ms`, `uploaded`, `uploaded_bytes`, `deleted`, `skipped` (files deleted after the listing, see `transfer_skipped`), `failed` (done when the run ended or was interrupted), `source_objects`, `target_objects`, `source_bytes`, `target_bytes` (as listed at the start of the run, absent if the listing failed or was not done), `error` (if failed), `signal` (`SIGTERM`, `SIGINT`: if interrupted) |
| `sync_skipped` | warn, error | a `cron` tick while the previous run is still running, or while another process synchronises the same storages. `error` for `lock_error`, and for `locked` when the holder runs for more than 10 minutes | `reason` (`already_running`, `locked`, `lock_error`: the lock file cannot be created, such as a read-only or missing directory), `running_since_ms`, `pid` (owner of the lock), `held_ms` (age of the lock holder), `error`. An `already_running` line carries the `run` of the running synchronisation |
| `lock_stale` | warn | a stale lock file is taken over: not refreshed for 90 seconds and its process no longer runs on this host, or not refreshed for 10 minutes | `path`, `pid`, `hostname`, `since` |
| `cache_loaded`, `cache_saved` | debug | cache read / written | `path`, `objects`, `duration_ms` |
| `cache_migrated` | info | cache of sclone 1.x migrated | `path`, `objects`, `duration_ms` |
| `cache_error` | warn | an existing cache cannot be used (unreadable, corrupted, written for other storages or another mode): the run is a first synchronisation, nothing is deleted because of it | `path`, `error` |
| `shutdown` | info | the process received `SIGTERM` or `SIGINT` while no run is in progress (a `cron` between two runs), and exits with code 143 or 130 | `signal` |
| `config_error` | error | invalid configuration, the process stops (exit code 1). The reason is in `msg` (an invalid JSON file gives its path and the line/column of the error, never its content) | `cron` (invalid cron expression only) |
| `config_warning` | warn | invalid `logLevel`, `info` is used | `log_level`, `accepted` |
| `storage_client` | info, warn, error | message of the storage client (fallback storage, reconnection...) | `side`, `storage` |
| `queue_start`, `queue_end`, `queue_errors`, `queue_retry`, `queue_failed`, `queue_crash`, `log_file`, `log_file_error`, `log_cleanup_error` | as logged by [cqueue](https://github.com/carboneio/cqueue) | transfer queues (`queue`: `delete-files-target`, `upload-from-source-to-target`, `upload-from-target-to-source`, `delete-files-source`, `list-files-source-target`, `resolve-etags`). The start/end of an empty queue, and of the listing queue, are `debug` | `queue`, `try` (0 = first attempt); `queue_start`: `total`, `concurrency`, `delay` (milliseconds between two elements, without the `_ms` suffix), `retry` (maximum retries); `queue_end`: `total`, `results`, `errors`, `duration_ms`, `avg_ms` (average time of an element, slowest sub-queue); `queue_errors`: `errors`, `summary`; `queue_retry`: `elements`, `delay_ms` (before the retry); `queue_failed`: `errors`, `total`, `duration_ms`; `queue_crash`: `error`; `log_file`, `log_file_error`, `log_cleanup_error`: `label`, `path`, `error` (the last two) |
| `sync_log_file`, `sync_log_error`, `md5_error` | info, warn, error | `logSync` / `dryRun` JSON file written or not, MD5 error | `path`, `error` |

## Queries

Replace `{unit=~"sclone.*"}` by the stream selector of your sclone logs (systemd unit, host...).

If the stream already has a `job` label (the Promtail journal example sets `job="systemd-journal"`), Loki renames the
`job` field of the line `job_extracted`. The queries copy it into a `sclone_job` label that works in both cases:
`| label_format sclone_job="{{ or .job_extracted .job }}"`.

The line filter (`|= "event=sync_end"`) before `| logfmt` only skips the parsing of the other lines.

Success rate per job (successful runs over all runs, dry runs excluded). The `or on(sclone_job) (0 * ...)` part returns 0
instead of no data for a job without any successful run:

```logql
(
  sum by (sclone_job) (count_over_time({unit=~"sclone.*"} |= "event=sync_end" | logfmt | event="sync_end" | label_format sclone_job="{{ or .job_extracted .job }}" | status="success" [1h]))
  /
  sum by (sclone_job) (count_over_time({unit=~"sclone.*"} |= "event=sync_end" | logfmt | event="sync_end" | label_format sclone_job="{{ or .job_extracted .job }}" | status!="dry_run" [1h]))
)
or on(sclone_job)
(0 * sum by (sclone_job) (count_over_time({unit=~"sclone.*"} |= "event=sync_end" | logfmt | event="sync_end" | label_format sclone_job="{{ or .job_extracted .job }}" | status!="dry_run" [1h])))
```

Status of the last run per job (1 = success, 0 = failed), as an instant query:

```logql
last_over_time({unit=~"sclone.*"} |= "event=sync_end" | logfmt | event="sync_end" | label_format sclone_job="{{ or .job_extracted .job }}" | status!="dry_run" | label_format ok=`{{ if eq .status "success" }}1{{ else }}0{{ end }}` | unwrap ok | __error__="" [1d]) by (sclone_job)
```

Time since the last successful run per job, in seconds, as an instant query (`${__to:date:seconds}` is the end of the
Grafana time range; replace it by a Unix timestamp outside Grafana):

```logql
${__to:date:seconds} - max by (sclone_job) (max_over_time({unit=~"sclone.*"} |= "event=sync_end" | logfmt | event="sync_end" | label_format sclone_job="{{ or .job_extracted .job }}" | status="success" | label_format success_at=`{{ __timestamp__ | unixEpoch }}` | unwrap success_at | __error__="" [1d]))
```

Refused and postponed deletions, by reason (`deletion_skipped` carries the number of files in `count`):

```logql
sum by (sclone_job, reason) (count_over_time({unit=~"sclone.*"} |= "event=deletion_refused" | logfmt | event="deletion_refused" | label_format sclone_job="{{ or .job_extracted .job }}" [1h]))
sum by (sclone_job, reason) (sum_over_time({unit=~"sclone.*"} |= "event=deletion_skipped" | logfmt | event="deletion_skipped" | label_format sclone_job="{{ or .job_extracted .job }}" | unwrap count | __error__="" [1h]))
```

Run duration, p50 and p95:

```logql
quantile_over_time(0.5, {unit=~"sclone.*"} |= "event=sync_end" | logfmt | event="sync_end" | label_format sclone_job="{{ or .job_extracted .job }}" | unwrap duration_ms | __error__="" [1h]) by (sclone_job)
quantile_over_time(0.95, {unit=~"sclone.*"} |= "event=sync_end" | logfmt | event="sync_end" | label_format sclone_job="{{ or .job_extracted .job }}" | unwrap duration_ms | __error__="" [1h]) by (sclone_job)
```

Failed operations by HTTP status, and the most frequent errors (a missing `status` is a network error (see `code`), or,
with tiny-storage-client <= 3.6.0, a status 5xx turned into an error by the storage client: the `storage_client` lines of
the same `run` give the status):

```logql
sum by (sclone_job, op, status) (count_over_time({unit=~"sclone.*"} |= "event=transfer_failed" | logfmt | event="transfer_failed" | label_format sclone_job="{{ or .job_extracted .job }}" [1h]))
topk(20, sum by (sclone_job, op, phase, status, error) (count_over_time({unit=~"sclone.*"} |= "event=transfer_failed" | logfmt | event="transfer_failed" | label_format sclone_job="{{ or .job_extracted .job }}" [1d])))
```

Errors of the failed runs (logs panel):

```logql
{unit=~"sclone.*"} |= "event=sync_end" | logfmt | event="sync_end" | status="failed" | line_format "{{ .ts }} {{ or .job_extracted .job }} {{ .error }}"
```

Transfers and bytes (replace `uploaded` by `uploaded_bytes`, `deleted` or `failed`):

```logql
sum by (sclone_job) (sum_over_time({unit=~"sclone.*"} |= "event=sync_end" | logfmt | event="sync_end" | label_format sclone_job="{{ or .job_extracted .job }}" | unwrap uploaded | __error__="" [1h]))
```

Objects and bytes per bucket over time (replace `objects` by `bytes`, or `duration_ms` with `quantile_over_time` for the listing time):

```logql
max by (sclone_job, side, bucket) (max_over_time({unit=~"sclone.*"} |= "event=listing_done" | logfmt | event="listing_done" | label_format sclone_job="{{ or .job_extracted .job }}" | unwrap objects | __error__="" [1h]))
```

## Alerts

No run since 15 minutes, for a cron every 3 minutes. A job that stops logging has no series at all: use one
`absent_over_time` rule per job (the line filter keeps it cheap; the trailing space avoids matching `my-sync-2`,
it requires a job name without spaces):

```logql
absent_over_time({unit=~"sclone.*"} |= "event=sync_end" |= "job=my-sync " [15m])
```

Or one rule for all jobs, firing (when > 0) on each job which ran during the last day but not during the last 15 minutes
(a count over 15 minutes alone has no series for a stopped job, so it can never fire for it; a job stopped for more than
a day is no longer reported):

```logql
sum by (sclone_job) (count_over_time({unit=~"sclone.*"} |= "event=sync_end" | logfmt | event="sync_end" | label_format sclone_job="{{ or .job_extracted .job }}" [1d])) unless sum by (sclone_job) (count_over_time({unit=~"sclone.*"} |= "event=sync_end" | logfmt | event="sync_end" | label_format sclone_job="{{ or .job_extracted .job }}" [15m]))
```

Failed runs (fire when > 0), runs skipped because the previous one is too long (fire when > 0), and skipped runs that
need an action (lock file not writable, lock holder running for more than 10 minutes: fire when > 0):

```logql
sum by (sclone_job) (count_over_time({unit=~"sclone.*"} |= "event=sync_end" | logfmt | event="sync_end" | status="failed" | label_format sclone_job="{{ or .job_extracted .job }}" [15m]))
sum by (sclone_job) (count_over_time({unit=~"sclone.*"} |= "event=sync_skipped" | logfmt | event="sync_skipped" | label_format sclone_job="{{ or .job_extracted .job }}" [1h]))
sum by (sclone_job) (count_over_time({unit=~"sclone.*"} |= "event=sync_skipped" | logfmt | event="sync_skipped" | level="error" | label_format sclone_job="{{ or .job_extracted .job }}" [15m]))
```

Refused deletions (fire when > 0: nothing was deleted and the run failed, a human must check the storages):

```logql
sum by (sclone_job, reason) (count_over_time({unit=~"sclone.*"} |= "event=deletion_refused" | logfmt | event="deletion_refused" | label_format sclone_job="{{ or .job_extracted .job }}" [15m]))
```

## Dashboard import

1. Grafana > Dashboards > New > Import, upload `docs/grafana-dashboard.json`.
2. Select the Loki datasource for `DS_LOKI`.
3. Set the `Loki stream selector` variable to the selector of your sclone logs (default `{unit=~"sclone.*"}`), and
   optionally the `Job` regex. Grafana 10 or higher, a recent Loki (2.9 or higher: `vector()`, `__timestamp__`).

Every panel has a description (the ⓘ tooltip): what it measures, the normal value, and when to worry / what to do.
The duration and "time since last success" thresholds are examples for a cron every few minutes: adjust them to your
schedule and bucket sizes. The rows follow the questions you ask, so the first screen tells whether everything is healthy:

| Row | Panels |
|---|---|
| 🟢 Health | Last run (Success / Failed / Interrupted), Time since last success, Success rate (green ≥ 99 %, orange ≥ 95 %), Re-uploaded files (max per run, see below), Refused deletions, Runs per hour (stacked by result: success, failed, interrupted, dry run, skipped; a gap means missing runs) |
| 🔴 Errors | Failed files, Files too large (`transfer_failed reason=too_large`), Lock errors, Cache errors and stale locks (`cache_error`, `lock_stale`), Failures by HTTP status, Connection and listing failures (`storage_connect_failed`, `listing_retry`), Top errors, Error and warning logs |
| ⏱️ Performance | Run duration p50 / p95, Listing duration p95, Files transferred (uploaded, deleted, failed), Re-uploaded files per run, Upload throughput, Uploaded volume |
| 🪣 Buckets | Target − source gap (objects and bytes), Objects per bucket, Bytes per bucket |
| 🖥️ Host (optional, Prometheus, collapsed) | Sync services (systemd state), Available memory and OOM kills |
| 🔎 Details (collapsed) | Skipped runs by reason (`already_running`, `locked`, `lock_error`), Bidirectional conflicts (`sync_conflict`), Refused deletions by reason (`max_deletion`, `empty_side`, `swift_versions_stack`), Postponed deletions (`deletion_skipped`: `still_present`, `not_confirmed`), Blocking lock age (`held_ms`, red above the 10 minutes stale delay) |

- **Re-uploaded files**: `update_target` + `update_source` of `sync_plan`, the files already present on the other side
  and copied again. Close to 0 is normal (orange above 100 per run, red above 1,000); the same high number on every run
  means files are copied in a loop. An empty plan is logged at `debug` level, so no `sync_plan` line means 0.
- **Target − source gap**: objects (and bytes) of the target minus the source, from `listing_done`. About 0 with
  `delete: true`; positive and growing slowly with `delete: false`. A sudden jump, or a growing gap with `delete: true`,
  needs a look.
- Variables: `Loki stream selector`, `Job (regex)`, and `Event (regex, logs)`, which filters the logs panel on the
  `event` field (for example `deletion_refused` or `transfer_failed|sync_skipped`).
- Annotations: failed runs (with their `error`) and refused deletions are marked on every time series.
- The dashboard links to this page.

### Host row (optional, Prometheus)

The collapsed **Host** row needs [node_exporter](https://github.com/prometheus/node_exporter) scraped by Prometheus,
with the systemd collector enabled (`--collector.systemd`) for *Sync services*; without it the panels show *No data*
and the rest of the dashboard works as usual. Pick the Prometheus datasource in the `Prometheus (host row)` variable,
set `Instance (regex)` to your servers (`instance` label) and `Unit (regex)` to your systemd unit names (default
`sclone.*`). The queries:

```promql
max by (instance, name) (node_systemd_unit_state{instance=~"$instance", name=~"$unit_regex", state="active"})
node_memory_MemAvailable_bytes{instance=~"$instance"}
increase(node_vmstat_oom_kill{instance=~"$instance"}[$__rate_interval])
```

During the transfers sclone holds up to `transfers` × about 2.2 × the file size in memory, plus the listings of both
sides: an OOM kill usually shows as a run without `sync_end`.

### Label dropdowns instead of the stream selector

The `Loki stream selector` textbox works with any labels. If your log shipper sets stable labels, for example `host`
and `unit` with systemd/journald, you can replace it with dropdowns (Dashboard settings > Variables):

1. Add a **Query** variable `host` on the Loki datasource: query type *Label values*, label `host`, stream selector
   `{unit=~"sclone.*"}`, *Multi-value* and *Include All option* on, custom all value `.*`.
2. Add a **Query** variable `unit`: label `unit`, stream selector `{unit=~"sclone.*", host=~"${host:pipe}"}`,
   *Multi-value* and *Include All* on, custom all value `sclone.*`.
3. In the JSON model (Dashboard settings > JSON Model), replace every `${selector}` with
   `{host=~"${host:pipe}", unit=~"${unit:pipe}"}`, save, then delete the `selector` variable.
   The `Job` variable is then redundant when there is one sclone instance per unit: leave it on `.*`.

With the same names on the Prometheus side (`instance` equal to the Loki `host`), the Host row can use
`instance=~"${host:pipe}"` and `name=~"${unit:pipe}"` too.

## Several instances on the same server

- Give each instance a `name` (or `SCLONE_NAME`): it is the `job` of every line and the key of every panel.
- Run each instance from its own working directory: the cache, `logs/` and the default `job` name depend on it.
- Stagger the crons (`1-59/3 * * * *`, `2-59/3 * * * *`...) so the listings do not all hit the storages at the same second.
