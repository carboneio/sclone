# Changelog

All notable changes to this project will be documented in this file. This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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