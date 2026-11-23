# Changelog

All notable changes to this project will be documented in this file. This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 2.1.0

- **Faster listings**: from the second run, large buckets are listed in parallel by key ranges (new option `listingConcurrency`, default `4`). Listing 20 000 files on OVHcloud S3: 20 s → 4.7 s with `8`. The listing stays exact: if anything looks wrong, sclone lists sequentially as before (`listing_fallback` warning).
- **A file deleted during the listing no longer fails the run**: it is skipped (`transfer_skipped` warning, new `skipped` field in `sync_end`) and handled by the next run.
- The S3 connection check is retried on temporary errors (5xx, 429, network) instead of failing the run.
- A provider listing pages in a loop now fails the run instead of listing forever.
- **Windows binary**: each release ships `sclone-<version>-win.exe`. Stop a run with Ctrl+C.
- The 2.1 cache stays readable by 2.0.
- Updated dependencies: `tiny-storage-client` 4.0.0 → 4.1.0 (with `rock-req` 5.4.0), dev `@yao-pkg/pkg` 6.25.0 → 6.26.0. A `503` throttle still failing after the retries now reads `All S3 storages are not available | Throttled by the storage (slow down)`.

## 2.0.0

> ⚠️ **Requires Node.js 26 or later** (the release binaries embed Node 26). Uses the built-in `Error.isError()` and `buffer.isUtf8()`, with no change to the logs or the synchronisation.

> ⚠️ **Upgrade from 1.x**: run a last 1.x synchronisation right before upgrading. The 1.x cache is migrated only from an explicit `cacheFilename` (never from the old default `listFiles.cache.json`); without it, the first 2.0 run is a first synchronisation: the files deleted since the last 1.x run reappear once (copied back from the other side). Nothing is lost.

- ⚠️ **New bidirectional logic, never "the most recent wins" alone**: the cache now records the state of each side after the last synchronisation, and only the side that changed is propagated. Fixed data losses of 1.x:
  - a file modified on the source during its copy, or an old version restored on one side, was overwritten by the copy made by sclone (always more recent),
  - a file deleted on one side and modified on the other was deleted: the modified file is now copied back,
  - after a run with a failed transfer, the cache was not saved even though deletions were done: a file created again under the same name was deleted by the next run. The cache is now saved after every run; a failed operation is simply done again.
  When both sides changed, the most recent version wins and a `sync_conflict` warning gives both versions. Dates are compared to the millisecond (they were truncated to the second).
- ⚠️ **New cache (version 2), also in unidirectional mode**: a target file edited by hand is now repaired, a restored old version (multipart too) is synchronised, and a run without change only lists the buckets. The default file name is derived from the storages and their account (`sclone-<mode>-<hash>.cache.json`): two instances in the same directory no longer share a cache. The cache records a hash of the account of each storage (S3 access key id, Swift username and project, never a secret): a cache of the same bucket name in another account is ignored. The cache is written atomically, and a cache written for other storages or corrupted is ignored (nothing is deleted because of it). It is read and written by chunks after the listings, and kept on the listed files: with 2 × 350 000 files, the bidirectional mode uses 32% less memory and plans 40% faster than 1.4. A 1.x cache is migrated only from an explicit `cacheFilename`, and only for the files listed on one side (deletions); the files listed on both sides are compared as on a first synchronisation (its token was the one of the original, a multipart copy was sent back). With the old default name, the first 2.0 run is a first synchronisation (see the upgrade note above).
- Fixed endless re-uploads of OVH encrypted objects: after a server-side copy, OVH lists them with an opaque etag. It is resolved once with a `HEAD` request, only if both sizes are equal.
- ⚠️ **Lock**: two processes synchronising the same storages no longer run at the same time, whatever their mode or cache name (`sync_skipped reason=locked` with a `cron`, failed run otherwise). The lock file (`sclone-<hash>.lock`, next to the cache) holds the pid, hostname and start time, is refreshed every 30 s, and is taken over when it was not refreshed for 90 s and its process is gone, or when it was not refreshed for 10 minutes. It is checked again before the first change of a run (`Lock lost`). It lives next to the cache: use an absolute `cacheFilename` when the same pair runs from several directories.
- ⚠️ **Nothing is deleted when a side is empty** while files would be deleted on the other one (`deletion_refused reason=empty_side`), in both modes: listed empty, or none of its listed files was synchronised before (emptied, then refilled with new files). Nothing is copied into the empty side and the cache is not saved: otherwise the next run would see a non-empty side and delete the synced files. Checked and logged together with `maxDeletion`. Use `"allowEmptySide": true` to allow it.
- ⚠️ **Deletions confirmed by a `HEAD`**: a file missing from one listing is deleted from the other side only if it is really gone (`404`). A file still present (eventually consistent Swift listing...) is not deleted (`deletion_skipped reason=still_present`); a `HEAD` failing after the retries skips the deletion and fails the run (`reason=not_confirmed`).
- ⚠️ **A refused deletion no longer stops the whole synchronisation** (`maxDeletion`, empty side): only the deletions are refused, the uploads still run, and the run ends as failed with `deletion_refused` so that the alerts fire. `maxDeletion` now allows up to `maxDeletion` deletions (the limit itself was refused); unset or `0` means no limit.
- **Swift containers with `X-Versions-Location`** ("stack" versioning): a `DELETE` restores the previous version, so a deleted file came back. With `delete`, the container is checked at connection (`swift_versions_stack`) and the deletions on this side are refused (`deletion_refused reason=swift_versions_stack`); the uploads still run. `X-History-Location` is supported.
- Fixed incomplete Swift listings: a page shorter than the requested limit (servers capping the pages at 1000) was read as the last one, and the following files were missing (deleted from the other side with `delete`). The listing now ends only on an empty page (one more request per listing).
- Fixed Swift metadata with non-ASCII characters (`é`): sent raw in UTF-8 by Swift, it was copied double-encoded (`Ã©`). A non-ASCII metadata holding a `%` or already percent-encoded gets its non-ASCII characters percent-encoded: a header value must be ASCII. A request refused before being sent is a failed transfer, never a crash.
- Fixed `integrityCheck` with Swift: an etag returned with quotes, or the etag of a large object (SLO, DLO, not the MD5 of the content), failed every transfer.
- A file rewritten on a Swift source during its copy is now detected as on S3: it is synchronised again by the next run.
- S3 connection check no longer needs ListAllMyBuckets permission: it lists one key of the configured bucket (`ListObjectsV2` with `max-keys=1`), so credentials scoped to a single bucket are accepted.
- Errors which cannot be fixed by retrying (archived object, access denied, file deleted after the listing, too large) are no longer retried and are reported once with their S3 error code (`transfer_failed reason=permanent`). Files larger than 5 GiB are not sent (S3, and Swift by default: `reason=too_large`).
- ⚠️ **New log format**: one [logfmt](https://brandur.org/logfmt) line per event, ready for Grafana Loki, with a `job` (instance name) and a `run` id on every line. A run with no change now writes 4 lines instead of ~12, and failures show their cause directly in the logs: `transfer_failed` gives the key, the error, and the HTTP `status` / network error `code` when known. Scripts or alerts matching the old messages (`Process done!`, `Summary Target`…) must be updated: see `docs/grafana.md` for the events and fields.
- **Stop signals**: `SIGTERM` (`systemctl stop`/`restart`) or `SIGINT` during a run writes `sync_end status=interrupted` (level `warn`, with the transfers done so far and the `signal`), releases the lock and exits with code 143 / 130, so that the dashboards see the run. The cache of the interrupted run is not saved: the previous one is kept. Without a run in progress, a `shutdown` line. A second signal exits at once.
- **Credentials are never logged**: an invalid `config.json` reports only its path and the line/column of the error, a refused S3 connection only its error code and message, and secrets found in URLs, headers (`Authorization`, `X-Auth-Token`) or JSON quoted by an error message are redacted. An Error nested in a logged object gives only its message and code, a function is logged as `[function]`. Control, line separator and bidirectional characters are escaped, a value is cut at 2048 characters once escaped, and a line at 16 000 characters (`truncated=true`), under the journald line limit.
- **Grafana**: ready-to-import dashboard (`docs/grafana-dashboard.json`) and LogQL queries for success rate, run duration, failures, transfers and bucket sizes.
- ⚠️ **Fixed compressed files** (`Content-Encoding: gzip`, `br`, `deflate`): they were copied decompressed and without their encoding, and uploaded again on every run. They are now copied byte for byte with their `Content-Encoding`. `Content-Disposition`, `Content-Language`, `Cache-Control` and `Expires` are copied too; encryption headers are never copied, so the target bucket's default encryption applies.
- **Failed transfers are retried after a delay** (`retryDelay`, default 1 s, doubling each retry, max 60 s) instead of immediately.
- ⚠️ **No more error files by default**: the causes are in the logs. Use `"errorFile": true` or `"final"` to keep them; they are deleted after `logRetentionDays` (default 7).
- New options: `allowEmptySide`, `name`, `logLevel`, `logMaxFailures`, `errorFile`, `logRetentionDays`, `retryDelay`; environment variables `SCLONE_NAME` and `SCLONE_LOG_LEVEL`.
- Fixed S3 ↔ Swift metadata conversion: only headers *starting* with the metadata prefix are converted.
- Fixed the `sclone` command installed by `npm install -g`: `index.js` had no `#!/usr/bin/env node` line, so Linux and macOS could not run it.
- Faster start: the source and the target connect in parallel (about one Swift authentication saved per run). If both fail, the source error is still reported first.
- Updated dependencies: `tiny-storage-client` 4.0.0, `@carboneio/cqueue` 1.1.0.

## 1.3.0
- Released the 2026/11/06
- Fixed lost error files and wrong exit code on failure: the process was killed with `process.exit()` before cqueue finished writing the error file of the last retry into `logs`, and it exited with code `0`. It now exits with code `1` once all files are written.
- Reduced the memory used by the file listing by ~70% (measured on 2 × 336 000 S3 objects: 623 MB → 176 MB of heap, peak RSS 1.4 GB → 0.65 GB). Each listed file is now copied into a compact object holding only `key`, `md5`, `lastmodified` and `bytes`: the strings returned by the XML parser were slices of the XML page, so every page listed stayed in memory for the whole synchronisation. Listing pages are also appended in place instead of copying the whole result array on every page. On large buckets, several sclone processes on the same server were killed by the Linux OOM killer, or stopped with "JavaScript heap out of memory".

- Fixed S3 multipart files re-uploaded on every run: the etag of a multipart upload (`<hash>-<number of parts>`) is not the MD5 of the content, and the copy made by sclone gets the real MD5, so the two never matched. In `unidirectional` mode the file was downloaded and uploaded again on every run, forever; in `bidirectional` mode the copy was pushed back to the original storage. When only one version has a multipart etag, the files are now considered identical if they have the same size and the multipart version is not newer than the other one. See "S3 multipart files" in the README for the consequences.
- Fixed `integrityCheck` with S3 multipart files: the MD5 of the downloaded content was compared to the multipart etag, so these files always failed with "Integrity check error" and were never synchronised. The check is now skipped for multipart etags (the upload is still verified by the storage).
- Fixed the `integrityCheck` option being kept enabled once a storage was connected with it, even when a later connection disabled it.

- ⚠️ Fixed incomplete listings read as complete ones. With `"delete": true`, every file missing from the listing of a storage was deleted from the other storage. The listing now fails, and nothing is synchronised, when:
  - an S3 page has no `IsTruncated`: the end of the listing was assumed, the next pages were ignored,
  - the number of files of an S3 page differs from its `KeyCount` (body cut, or not parsed correctly),
  - an S3 page is truncated but does not list any new file: the listing stopped with a crash, or looped forever on the same page,
  - a SWIFT listing is not a JSON list (HTML error page returned with a status 200, unexpected status): it crashed the process,
  - a listed file has no key, no etag/hash, or an invalid modification date: it crashed the process.
  A SWIFT listing with the status `204` is read as an empty container.

- Fixed S3 keys looking like numbers or booleans, by updating `tiny-storage-client` to 3.6.0. The XML parser converted them: `0001` became `1`, `1e3` became `1000`, `true` a boolean, `12345678901234567890` became `12345678901234567000`. Consequences:
  - the file could not be downloaded or deleted with the converted key, the synchronisation failed on every run, or uploaded it again on every run,
  - different keys such as `1`, `01` and `1.0` were read as the same file, only one of them was synchronised,
  - when such a key was the last one of a page, the next page started after the converted key: files were skipped or listed twice.
  A listed key that is not a string now makes the listing fail.

- Fixed S3 keys and ETags containing XML entities, by updating `tiny-storage-client` to 3.6.0. They were not decoded: `R&D.pdf` was listed as `R&amp;D.pdf`, `l'offre.pdf` as `l&#39;offre.pdf` by OVH, and the AWS ETags as `&quot;…&quot;`. Consequences:
  - an S3 source file with such a key could not be downloaded (404): the synchronisation failed on every run,
  - with a SWIFT source and an S3 target, the file was never found on the target: it was uploaded again on every run. With `"delete": true`, the encoded key was also deleted from the target, and S3 read it as the real file: on every run the file was deleted from the target, then uploaded again,
  - a key containing a `&` or a `<` made the whole bulk deletion of 1000 files fail with `MalformedXML`,
  - an AWS ETag never matched the MD5 of the other storage, and a multipart ETag was not detected: the files were uploaded again on every run.

- ⚠️ Fixed SWIFT downloads and uploads whose HTTP status was not checked. `tiny-storage-client` returns the 4xx responses of SWIFT without any error:
  - a download error (`404` file deleted after the listing, `403`, `429`, `498` rate limited) was uploaded to the other storage as the content of the file: the error page replaced the file, with the `content-type` of the error. A download must now return `200`,
  - a refused upload (`422` content different from the `ETag` sent by `integrityCheck`, `413` too large, `403`, `404` container) was counted as synchronised. In `bidirectional` mode, the file was saved in the cache: on the next run, it was read as deleted from the storage where the upload had failed, and with `"delete": true` it was deleted from the other storage, which had the only copy. An upload must now return `201`.

- Fixed the whole listing lost on a single error. A network error or a status 5xx on one page failed the listing of the bucket, and the synchronisation with it: on large buckets (hundreds of pages), a temporary error of a few seconds stopped the synchronisation. Now only the failed page is requested again, up to `listRetry` times (default `5`), after `listRetryDelay` milliseconds (default `1000`) doubled on each retry. Temporary errors only: network, status 5xx, 408, 429, 498, page cut or invalid. A permanent error (access denied, bucket not found) is not retried. If a page still fails, the synchronisation is stopped before any operation, as before.
- Fixed files not deleted counted as deleted. S3 (`DeleteObjects`) and the SWIFT bulk delete return a status `200` even if some files are not deleted (access denied...), the errors are listed in the body: they were ignored, and a SWIFT bulk delete was never checked, whatever its status. In `bidirectional` mode, the file was already removed from the cache: on the next run, the file still present was read as a new file, and copied back to the other storage. A deletion with a file not deleted now fails: the first 10 files and their error are written into the errors file of the queue (`logs/`), the cache is not saved and the process exits with code `1`. A file not found (already deleted) is not an error.
- Fixed the retry of the listing: the whole listing was listed again once, but its result was ignored and the synchronisation failed anyway. It is replaced by the retry of each page.
- Fixed the pagination marker (`start-after`, `marker`) written into the `queries` given as options to `fetchListFiles`: reused for a second listing, the options made it start after the last file of the previous one.
- Updated dependencies: `tiny-storage-client` 3.5.0 → 3.6.0, dev `mocha` 11.8.0 → 12.0.3.

## 1.2.0
- Released the 2026/08/12
- ⚠️ Node.js 20 or higher is now required (`node-cron` 4 and `tiny-storage-client` 3.5 dropped older Node versions).
- Updated dependencies: `node-cron` 3.0.3 → 4.6.0, `tiny-storage-client` 3.3.0 → 3.5.0.
- Updated dev dependencies: `eslint` 10, `mocha` 11, `nock` 14, `sinon` 22, `lorem-ipsum` 3.
- Replaced the bundled `cqueue.js` with the dedicated [@carboneio/cqueue](https://www.npmjs.com/package/@carboneio/cqueue) npm package. Error and log files are now written to a `logs` folder in the current working directory, with second precision and a retry suffix in the file names.
- Fixed S3 connection error reporting: a JavaScript operator precedence bug dropped the status code and message prefix from the error returned when `listBuckets` fails.
- Fixed startup crash when `source` or `target` is missing from the configuration: a clear error message is now printed instead of a TypeError.
- ⚠️ Fixed silent transfer failures: `syncFiles` now returns an error when uploads or deletions fail after all retries, instead of logging "Process done!". Critically, the cache is no longer saved when a transfer fails: previously, a failed upload in `bidirectional` mode with `"delete": true` recorded the file as synced, and the next run interpreted the missing copy as a deletion and deleted the original file from the storage that had it (permanent data loss). In cron mode the process logs "Process failed!" and retries on the next tick.
- Fixed a bidirectional conflict case: when the md5 differ but the modification times are strictly identical, no direction won and the storages stayed silently divergent forever. The source version now wins the tie.
- Fixed the cache file location for packaged binaries: `cacheFilename` is now resolved from the current working directory (absolute paths are used as-is) instead of the installation directory. Inside a binary built with pkg, the installation directory is the read-only snapshot filesystem, so the bidirectional cache could never be written. Fully backward compatible: if an existing cache is found at the legacy location (next to the source code) and none exists in the working directory, the legacy location keeps being used.
- Added unit tests: bidirectional end-to-end sync (cache creation and non-creation on failure), `maxDeletion` threshold, source-side bulk deletion, transfer-error propagation, the identical-timestamp tie-break, and one documented limitation (S3 multipart etags).
- Replaced the deprecated `vercel/pkg` build tool with the maintained fork [@yao-pkg/pkg](https://github.com/yao-pkg/pkg), installed as a dev dependency (binaries are now based on a recent Node.js runtime).
- Fixed flaky cron tests: they now wait for the sync to complete instead of sleeping a fixed time.
- Added GitHub Actions CI: tests and lint run on Node 20/22/24 for every push and pull request (actions pinned by commit SHA).
- Fixed the `package.json` name: `sclone` → `@steevepay/sclone`, matching the published npm package. Added the missing `repository`, `homepage`, `bugs`, `keywords`, `files` (explicit publish whitelist) and `publishConfig` fields, and declared the `sclone` bin command explicitly.

## 1.1.0
- Released the 2024/01/05
- Fixed Synchro with S3 Scaleway: The etag from ListObjectV2 was returning encoded double quotes "&#34;" instead of "\"".
- Fixed "logSync" option: if enabled, the `logs` folder is created automatically if it does not exist.
- Updated dev npm packages

## 1.0.0 
- Released the 2023/09/07
- Added executable for MacOS and Linux
- Added documentation
- Added changelog
- Cleaned and open-sourced the code