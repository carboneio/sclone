# Changelog

All notable changes to this project will be documented in this file. This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased
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

- Fixed S3 keys looking like numbers or booleans, by updating `tiny-storage-client` (commit `27dd905` until 3.6.0 is published). The XML parser converted them: `0001` became `1`, `1e3` became `1000`, `true` a boolean, `12345678901234567890` became `12345678901234567000`. Consequences:
  - the file could not be downloaded or deleted with the converted key, the synchronisation failed on every run, or uploaded it again on every run,
  - different keys such as `1`, `01` and `1.0` were read as the same file, only one of them was synchronised,
  - when such a key was the last one of a page, the next page started after the converted key: files were skipped or listed twice.
  A listed key that is not a string now makes the listing fail.

- Fixed S3 keys and ETags containing XML entities, by updating `tiny-storage-client` (commit `dca5d47` until 3.6.0 is published). They were not decoded: `R&D.pdf` was listed as `R&amp;D.pdf`, `l'offre.pdf` as `l&#39;offre.pdf` by OVH, and the AWS ETags as `&quot;…&quot;`. Consequences:
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