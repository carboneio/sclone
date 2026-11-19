<p align="center">
  <img width="150" src="./assets/logo-sclone.png" alt="Sclone logo">
</p>

# Sclone

[![Tests](https://github.com/carboneio/sclone/actions/workflows/test.yml/badge.svg)](https://github.com/carboneio/sclone/actions/workflows/test.yml)
[![npm version](https://img.shields.io/npm/v/@carboneio/sclone)](https://www.npmjs.com/package/@carboneio/sclone)

Sclone, for "Storage Clone", is a program to sync files to and from different cloud storage providers supporting S3 and OpenStack SWIFT.

It offers fast speed thanks to parallelized workloads and file list caching.
If you would like to know more about performance, refer to the [benchmarks](#benchmarks) section.

## Features

- **Unidirectional mode**: mode to just copy new/changed/deleted files from a source to a destination.
- **Bidirectional mode**: mode to make the source and target buckets identical.
- **Job scheduler**: Use the Cron syntax to start the process every minute, every 30 minutes, or anytime you want.
- **Optional deletion**: by default deletion is disabled: missing files are added on the source/target bucket. When enabled, files are deleted on the source/target bucket.
- **High speed**: File transfers are split into parallel queues. At the end of each process, the list of files is cached for better performance on the next execution.
- **Optional integrity check**: MD5 hashes checked for file integrity. Disabled by default.
- **Metadata preserved**: from S3 to SWIFT or SWIFT to S3, metadata is preserved/converted automatically.
- **Production ready**: Battle tested with terabytes of buckets.
- **Dry run**: Output what operations will be performed without actually carrying out those operations.
- **Support any S3 and SWIFT provider**:  AWS S3, OVHCloud, Scaleway, Ceph.io,  DigitalOcean Spaces, Cloudflare R2, Seagate Lyve Cloud, Tencent Cloud, Alibaba Cloud OSS, IBM COS S3, Dreamhost S3, GCS, IDrive e2, Synology C2, IONOS Cloud, Minio, Petabox, and more...

## Benchmarks

The transfer benchmarks below were measured with sclone 1.0.0 and have not been run again with 2.0. With 2.0, a synchronisation without any change of 100 000 files takes about 3.9 s on a local MinIO, and the plan of 350 000 files is computed in about 50 ms.

> * Environment: VPS OVH - 2 vCores - 4GB Ram - Bandwidth 500Mbit/s - Debian 12 - Node 20.5.1 - Strasbourg (France)
> * Default options were used for sclone (1.0.0) / rclone (v1.63.1) / s3sync (2.61)
> * OVH S3 bucket type: normal (and not performance)

Unidirectional sync from a source storage to a target storage located in different regions. Every synchronization used the same 10 GB dataset of 1624 files.

| | **10GB** from S3 OVH Gra to S3 OVH Sbg | **10GB** from S3 OVH Gra to S3 Scaleway Paris | **10GB** from S3 OVH Gra to SWIFT OVH Gra |
|-----------------------------|-------------------------------|-------------------------------|--------------------------------|
| **sclone**  | 3.30 Min  |  4.10 Min   | 3.27 Min  |
| **rclone**  | 5.45 Min |  10.51 Min  | 6.32 Min |
| **s3sync**  | 3.10 Min |   4.09 Min   | ❌ |

Bidirectional sync between two storages located in different regions. Every synchronization used the same two 8 GB datasets (1354 files) with 1/3 common files, 1/3 new files and 1/3 edited files.

| | **8GB** S3 OVH Gra <> **8GB** S3 OVH Sbg | **8GB** S3 OVH Gra <> **8GB** S3 Scaleway Paris | **8GB** from S3 OVH Gra <> **8GB** SWIFT OVH Gra |
|-----------------------------|-------------------------------|-------------------------------|--------------------------------|
| **sclone**  | 3.59 Min | 4.11 Min | 3.42 Min |
| **rclone**  | 8.4 Min | 13.57 Min | 10.40 Min |

## Quickstart

### Option 1: Standalone binary

1. Download the latest binary for Linux (`sclone-<version>-linux`) or macOS (`sclone-<version>-macos`) from the [Release page](https://github.com/carboneio/sclone/releases) and make it executable:
```sh
chmod +x ./sclone-2.0.0-linux
```
2. Create a file `config.json` in the directory you will run the binary from to define the source/target storage credentials, and options. You can copy the `config.default.json` file as an example. Read the [configuration](#configuration) section for details.
3. Finally start the synchronisation:
```sh
./sclone-2.0.0-linux
```

### Option 2: npm (requires Node.js 26 or higher)

1. Install the [npm package](https://www.npmjs.com/package/@carboneio/sclone) globally:
```sh
npm install -g @carboneio/sclone
```
2. Create a `config.json` file in the directory you will run sclone from (see the [configuration](#configuration) section).
3. Start the synchronisation:
```sh
sclone
```

> 🟢 Tip: Set the option `"dryRun": true` in the `config.json`: it writes the operations that would be performed into a JSON file of the `logs` folder, without carrying them out.

## Configuration

Copy the `config.default.json` (from the repository or the npm package) to a `config.json` file in the working directory, or set its path with `SCLONE_CONFIG` (see [Environment variables](#environment-variables)). The file must be plain JSON: remove the comments of the examples below.

### List of options

| Options | Default value  | Description |
|---|---|---|
| **source** | | **Option required**<br> Storage credentials ([S3 Example](#example-of-s3-credentials) / [SWIFT example](#example-of-openstack-swift-credentials)) |
| **target** | | **Option required**<br>Storage credentials ([S3 Example](#example-of-s3-credentials) / [SWIFT example](#example-of-openstack-swift-credentials)) |
| **mode** |  | **Option required**<br>Synchronisation mode:<br> ⏺ `unidirectional`: One way synchronization from source to destination without modifying any of the source files and deleting any of the destination files (unless `delete` option is enabled).<br> ⏺ `bidirectional`: Two way synchronisation between a source and target storage, without deleting any files (unless `delete` option is enabled). |
| **cron** |  | Define the period of the program execution, and must follow the CRON syntax, for instance every minute: `"*/1 * * * *"`. A new process is not started until the current synchronisation is finished. If the option is not defined, the synchronisation is executed immediately, one time. |
| **delete** | `false` | If `true`, files are deleted according to the synchronization mode logic. |
| **integrityCheck** | `false` | If `true`, MD5 hashes are checked for file integrity. |
| **logSync** | `false` | If `true`, at the end of each synchronisation, a JSON file including all file operations is created in the `logs` folder of the working directory (`sync-<date>.json`). |
| **cacheFilename** | `"sclone-<mode>-<hash>.cache.json"` | File name of the cache: the state of each file after the last synchronisation, written in both modes, unidirectional included (see [Cache](#cache)). By default the name is derived from the mode and the two storages (and their accounts), so several instances can share a working directory. The file is created in the current working directory (the directory the program is started from). An absolute path can also be provided. The lock file is created in the same directory: when the same pair of storages may run from several working directories, use an absolute path, otherwise each directory has its own cache and lock and the runs are not excluded. |
| **transfers** | `15` | Number of file operations to run in parallel: upload/deletion. If a storage responds with many errors (status 500, socket or authentication error), consider reducing the number of transfers. |
| **retry** | `1` | Max number of retries to sync a file. `0` is read as `1`. |
| **listRetry** | `5` | Max number of retries of a listing page on a temporary error (network, status 5xx, 408, 429, page cut or invalid). Only the failed page is requested again, not the whole listing. A permanent error (access denied, bucket not found) is not retried. If a page still fails, the synchronisation is stopped before any operation. |
| **listRetryDelay** | `1000` | Delay in milliseconds before the first retry of a listing page, doubled on each retry: 1s, 2s, 4s, 8s, 16s by default. |
| **dryRun** | `false` | Do a trial run with no permanent changes: a JSON file including all file operations is created, as with `logSync`. The cache is not saved. |
| **maxDeletion** |  | Max number of deletions allowed on each storage during a synchronisation: up to `maxDeletion` files are deleted. Above it, no file is deleted on either storage, the uploads still run, and the synchronisation ends as failed (`deletion_refused reason=max_deletion`). It is a security measure to avoid propagation of unexpected bulk deletions. Not set or `0`: no limit. |
| **allowEmptySide** | `false` | By default, no file is deleted when a storage is empty while files would be deleted on the other one: listed empty, or none of its listed files was synchronised before (emptied, then refilled with new files). Nothing is uploaded to the empty side and the cache is not saved (it stays empty, so the next runs keep refusing). Checked in both modes, together with `maxDeletion`. The other uploads still run, and the synchronisation ends as failed (`deletion_refused reason=empty_side`). An emptied, wrong or unreadable bucket must not wipe the other side. Set `true` to allow it. |
| **name** | name of the working directory | Name of the instance, written in the `job` field of every log line. Give a distinct name to each instance, without spaces. Overridden by the `SCLONE_NAME` environment variable. |
| **logLevel** | `"info"` | Minimum level of the logs: `debug`, `info`, `warn` or `error` (case-insensitive). Overridden by the `SCLONE_LOG_LEVEL` environment variable. An invalid value logs a warning and uses `info`. |
| **logMaxFailures** | `100` | Max number of `transfer_failed` lines per queue and per synchronisation (one line per failed attempt). The other failures are counted in one `transfer_failed_summary` line. |
| **retryDelay** | `1000` | Delay in milliseconds before retrying the failed transfers (`retry`), doubled on each retry, capped to 60 seconds. `0` retries immediately. |
| **errorFile** | `false` | Write the failed transfers into a JSON file of the `logs` folder of the working directory: `true` after each failed attempt, `"final"` only for the failures remaining after the last retry. The causes are already in the logs (`transfer_failed`). |
| **logRetentionDays** | `7` | When `errorFile` is enabled, the error files older than this number of days are deleted. `0` keeps them all. |



### Example of `config.json`
```jsonc
{
  "mode"          : "bidirectional",
  "delete"        : false,
  "logSync"       : false,
  "cacheFilename" : "sync.cache.json",
  "cron"          : "*/5 * * * *",
  "integrityCheck": false,
  "source"        : {
    "name"    : "swift",
    "authUrl" : "https://auth.cloud.ovh.net/v3",
    "username": "",
    "password": "",
    "region"  : "",
    "bucket"  : ""
  },
  "target"      : {
    "name"           : "s3",
    "accessKeyId"    : "access-key-id",
    "secretAccessKey": "secret-access-key",
    "url"            : "s3.gra.first.cloud.test",
    "region"         : "gra",
    "bucket"         : ""
  }
}
```

### Example of OpenStack SWIFT credentials

```jsonc
{
    "name"    : "swift", /** Required by Sclone **/
    "authUrl" : "https://auth.cloud.ovh.net/v3", /** Insert your own auth URL **/
    "username": "", /** Your username **/
    "password": "", /** Your password **/
    "region"  : "", /** Bucket region **/
    "bucket"  : "", /** Bucket name that will be synchronised **/
    "tenantName": "", /** Optional: project (tenant) name to scope the authentication **/
    "interface" : ""  /** Optional: endpoint interface of the catalog ("public", "internal"...), the first endpoint of the region otherwise **/
}
```

### Example of S3 credentials

```jsonc
{
    "name"           : "s3",  /** Required by Sclone **/
    "url"            : "s3.gra.first.cloud.test", /** S3 URL, without the bucket name ("https://" is optional) **/
    "accessKeyId"    : "",    /** Your access key ID **/
    "secretAccessKey": "",    /** Your secret key **/
    "region"         : "",    /** Bucket region **/
    "bucket"         : ""     /** Bucket name that will be synchronised **/
}
```

### Environment variables

| Variable | Description |
|---|---|
| **SCLONE_CONFIG** | Path to the configuration file, relative to the working directory or absolute. Defaults to `config.json`. |
| **SCLONE_CRON** | Cron expression, overrides the `cron` option of the configuration file. |
| **SCLONE_NAME** | Name of the instance in the logs (`job` field), overrides the `name` option. |
| **SCLONE_LOG_LEVEL** | Minimum level of the logs (`debug`, `info`, `warn`, `error`), overrides the `logLevel` option. |

## Logs

Sclone writes one line per event on the standard output, in the [logfmt](https://brandur.org/logfmt) format, ready to be parsed by Loki (`| logfmt`), Vector, Datadog...

```
ts=2026-11-19T09:57:25.071Z level=info job=backup-invoices run=089a9f5b event=sync_start msg="Synchronisation started" mode=unidirectional source=s3:invoices target=s3:invoices-copy delete=true dry_run=false cron=true
ts=2026-11-19T09:57:25.087Z level=info job=backup-invoices run=089a9f5b event=listing_done msg="target listed" side=target storage=s3 bucket=invoices-copy objects=5 bytes=15000 duration_ms=4
ts=2026-11-19T09:57:25.088Z level=info job=backup-invoices run=089a9f5b event=listing_done msg="source listed" side=source storage=s3 bucket=invoices objects=5 bytes=15000 duration_ms=4
ts=2026-11-19T09:57:25.089Z level=info job=backup-invoices run=089a9f5b event=sync_end msg="Synchronisation success" status=success duration_ms=16 uploaded=0 uploaded_bytes=0 deleted=0 failed=0 source_objects=5 target_objects=5 source_bytes=15000 target_bytes=15000
```

- Each line starts with `ts` (UTC), `level`, `job` (the `name` option), `run` (a random id shared by all the lines of one synchronisation) and `event` (a stable name, such as `sync_start`, `listing_done`, `sync_plan`, `transfer_failed`, `sync_end`).
- The `sync_end` line ends every synchronisation with its `status` (`success`, `failed`, `dry_run`, `interrupted`), its duration, the number of files and bytes transferred, the number of failures and the size of both buckets. The `transfer_failed` lines give the cause of each failed operation: key, HTTP status and error.
- Levels: `info` by default. A synchronisation without any change writes 4 lines with a `cron`. Use `"logLevel": "debug"` to see the cache and queue details, `"warn"` to only keep the problems.
- Credentials are never logged. Object keys are.
- The process exits with code `0` on success, and `1` on a configuration error, a storage connection failure at startup or a failed synchronisation (without `cron`).
- On `SIGTERM` (`systemctl stop` or `restart`) or `SIGINT` (Ctrl+C) during a run, sclone writes `sync_end status=interrupted` with the transfers done so far, releases its lock and exits with code `143` (`SIGTERM`) or `130` (`SIGINT`); the cache of the interrupted run is not saved, the previous one is kept. Between two `cron` runs it writes a single `shutdown` line. A second signal exits at once.

The list of events and fields, LogQL queries and alerts are available in [docs/grafana.md](docs/grafana.md), with a ready-to-import Grafana dashboard: [docs/grafana-dashboard.json](docs/grafana-dashboard.json).

### Running several instances

Several sclone processes can share the same server and the same log stream (journald):
- give each instance its own `name` (or `SCLONE_NAME`): the dashboards and alerts are grouped by `job`,
- each pair of storages gets its own cache and lock file by default, so instances can share a working directory (a `cacheFilename` set by hand must be distinct for each instance). Two configurations of the same pair (unidirectional and bidirectional, or another cache name) whose caches are in the same directory never run at the same time,
- stagger the crons (`1-59/3 * * * *`, `2-59/3 * * * *`...) to spread the listings over time.

## Synchronisation Strategy

### Unidirectional

Sclone adds, updates, and deletes (if enabled) files from a `source` to a `target` storage. The source always wins: a file edited or deleted on the target only is copied again from the source.

If the `delete` option is `false`, files on the target storage are not deleted even if they do not exist on the source storage. In other words, the target will accumulate all files.

If the `delete` option is `true`, files on the target storage that do not exist on the source are deleted. The target will be an exact copy of the source storage.

### Bidirectional

Sclone propagates the changes made on each side since the last synchronisation, recorded in the [cache](#cache). It never decides from the modification dates alone: a copy made by sclone is always more recent than its original.

| Source | Target | Operation |
|---|---|---|
| unchanged | unchanged | nothing |
| new or modified | unchanged | copied to the target |
| unchanged | new or modified | copied to the source |
| deleted | unchanged | deleted from the target with `delete: true`, copied back to the source otherwise |
| unchanged | deleted | deleted from the source with `delete: true`, copied back to the target otherwise |
| deleted | deleted | nothing |
| deleted | modified | **conflict**: the modified file is copied back. A modified file is never deleted |
| modified | deleted | **conflict**: the modified file is copied back |
| modified | modified | nothing if both have the same content, otherwise **conflict**: the most recent version wins (the source on a tie) |

Without cache (first synchronisation, or a file never synchronised), nothing is deleted: a file present on one side is copied to the other one, and a file different on both sides is a conflict, the most recent version wins. Each conflict is logged as a `sync_conflict` warning with the key, the winner, and the etag, size and modification date of both versions.

Modification dates are compared to the millisecond.

### Cache

At the end of each synchronisation, in both modes, the cache file records for each file the token of each side as listed (etag and size), one line per file. A side changed if its etag or size differs from the recorded token. The etag is only used as a token: any rewrite of the file changes it.

- A copied file records the listed token of its origin and the etag returned by the upload. A deleted file is removed from the cache. A failed or refused operation keeps the previous state: it is done again by the next run.
- The cache is saved at the end of every run (except a dry run), also when some operations failed or deletions were refused, atomically (temporary file, flushed, then renamed, directory flushed): a crash never leaves a truncated cache. Temporary files left by a crash are removed after an hour.
- The cache file starts with the mode and the identity of both storages: `s3:<url>:<region>/<bucket>@<account>`, where `<account>` is a hash of the access key id (S3) or of the username and project (Swift), never of a secret. A cache written for another pair of storages or another account, of an unknown version or corrupted is ignored with a `cache_error` warning: the run is a first synchronisation, nothing is deleted because of it. Changing the access key id therefore starts a first synchronisation again.
- A cache written by sclone 1.x in bidirectional mode is migrated when found under the configured `cacheFilename` (`cache_migrated`): its entries are kept for the files listed on one side only (to propagate the deletions), the files listed on both sides are compared as on a first synchronisation. The previous default name `listFiles.cache.json` is not read: it may be shared by several instances.
- Without cache, both files are identical when their etags are the same MD5 (single upload) or the same multipart etag. An etag which is neither (OVH lists the encrypted objects copied server-side with an opaque 64 hex etag) is resolved once with a `HEAD` request, only when both sizes are equal (`etag_resolved` in `sync_plan`). On the first synchronisation only, an S3 multipart file and a copy of the same size are identical if the multipart version is not more recent (in unidirectional mode, only a multipart source and its plain copy on the target).

A synchronisation without any change sends the listing requests only, plus the connection requests: one `ListObjectsV2` of one key (`max-keys=1`) on the bucket of each S3 storage, and the authentication of each Swift storage (with `delete`, also one `HEAD` of the container). With a `cron`, the storages are connected once at startup, otherwise at the start of each run.

### Safety

- **Lock**: a lock file is created in the directory of the cache (`sclone-<hash>.lock`, derived from the pair of storages only, with the pid, hostname and start time). Another process synchronising the same storages, in any mode, is refused: a run without `cron` fails, a `cron` run is skipped (`sync_skipped reason=locked`). The lock is refreshed every 30 seconds while held. It is stale, and taken over with a `lock_stale` warning, if it was not refreshed for 90 seconds and its process is no longer running on this host (a recent lock is always alive: a process of another container with the same hostname cannot be checked), or if it was not refreshed for 10 minutes (a process of another host sharing the directory, or a container restarted with a new hostname: the next run may wait up to 10 minutes). The lock is checked again before the first change of a run: if another process took it over in between, the run changes nothing and fails (`Lock lost`). A `cron` run skipped because the lock cannot be created (`lock_error`), or held by a process running for more than 10 minutes, is logged at `error` level.
- **Deletion guards**: `maxDeletion` and `allowEmptySide`, checked before any operation. A refused deletion stops only the deletions: the uploads still run, the refused files keep their cache (the deletion is planned again by the next run), and the run ends as failed with a `deletion_refused` error, so that the alerts fire.
- **Deletions confirmed**: a file missing from the listing of one side is deleted from the other side only if a `HEAD` request on the side it is missing from returns `404`. A listing can miss files (eventually consistent Swift listings...): a file still present is not deleted and keeps its cache (`deletion_skipped reason=still_present`); a `HEAD` failing after the retries skips the deletion and fails the run (`reason=not_confirmed`). One `HEAD` per deletion, `transfers` in parallel.
- **Swift versioning**: a container with `X-Versions-Location` ("stack" mode) restores the previous version of a file on `DELETE`: a deleted file would come back. With `delete`, such a container is detected at connection (`swift_versions_stack` error) and the deletions on this side are refused (`deletion_refused reason=swift_versions_stack`), the uploads still run. `X-History-Location` ("history" mode) is supported.
- **Listings**: an incomplete or invalid listing page stops the synchronisation before any operation. A Swift listing ends only on an empty page (one more request per listing): a page shorter than requested is not the end on servers capping the pages.
- **Errors which do not change by retrying** (`400`, `403` such as an archived object or an access denied, `404` on download, `413`) are not retried: they are reported once by run as `transfer_failed reason=permanent` with the S3 error `code`. Network errors, `5xx` and `429` are retried.

### Limits

- A change of metadata only (headers, without content change) is not detected.
- Files larger than 5 GiB are not copied (`transfer_failed reason=too_large`): sclone uploads with a single request, limited to 5 GiB by S3 and by default by Swift.
- Memory: about 64 MB, plus 2.2 times the size of the files transferred in parallel (`transfers`), plus about 0.5 KB per file for both listings and the cache (measured: 143 MB of heap for 2 × 350 000 files). Each file is buffered in memory during its transfer (up to 5 GiB): size the memory for the largest files, about `transfers` × 2.2 × the largest file size in the worst case (15 files of 1 GB: about 33 GB). Lower `transfers` for buckets of large files.
- With `integrityCheck`, the downloaded content of an S3 multipart file or a Swift large object (SLO, DLO) cannot be checked against its etag: the check is skipped for these files. The upload is still verified by the storage with the `Content-MD5` header (S3) or the `ETag` header (SWIFT).

## Development

Requires Node.js 26 or higher.

```sh
npm install      # install dependencies
npm test         # run the test suite (mocha)
npm run lint     # lint and auto-fix (eslint)
npm run build    # build the Linux and macOS binaries (@yao-pkg/pkg, installed as a dev dependency)
```

Tests and lint run automatically on GitHub Actions for every push and pull request. Pushing a `v*` tag (matching the `package.json` version) builds the binaries, attaches them to a GitHub release, and publishes the package to npm.

## Supporters

This package is maintained by Carbone:

<p>
  <a href="https://carbone.io" alt="Carbone.io - Efficient PDF / DOCX / XLSX / CSV / HTML / XML generator with templates and JSON">
    <img src="https://raw.githubusercontent.com/carboneio/rock-req/master/doc/carbone-logo.svg" alt="Carbone.io logo" height="60"/>
  </a>
</p>

