<p align="center">
  <img width="150" src="./assets/logo-sclone.png" alt="Sclone logo">
</p>

# Sclone

[![Tests](https://github.com/carboneio/sclone/actions/workflows/test.yml/badge.svg)](https://github.com/carboneio/sclone/actions/workflows/test.yml)
[![npm version](https://img.shields.io/npm/v/@steevepay/sclone)](https://www.npmjs.com/package/@steevepay/sclone)

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

1. Download the latest binary from the [Release page](https://github.com/carboneio/sclone/releases) and make it executable:
```sh
chmod +x ./sclone-1.2.0-linux
```
2. Create a file `config.json` near the binary to define the source/target storage credentials, and options. You can copy the `config.default.json` file as an example. Read the [configuration](#configuration) section for details.
3. Finally start the synchronisation. 
```sh
./sclone-1.2.0-linux
```

### Option 2: npm (requires Node.js 20 or higher)

1. Install the [npm package](https://www.npmjs.com/package/@steevepay/sclone) globally:
```sh
npm install -g @steevepay/sclone
```
2. Create a `config.json` file in the directory you will run sclone from (see the [configuration](#configuration) section).
3. Start the synchronisation:
```sh
sclone
```

> 🟢 Tip: Set the option `"dryRun":true` on the `config.json`, it will output on a log file what operations will be performed without actually carrying out those operations.

## Configuration

At the root of the project, copy the `config.default.json` and name it `config.json`.

### List of options

| Options | Default value  | Description |
|---|---|---|
| **source** | | **Option required**<br> Storage credentials ([S3 Example](#example-of-s3-credentials) / [SWIFT example](#example-of-openstack-swift-credentials)) |
| **target** | | **Option required**<br>Storage credentials ([S3 Example](#example-of-s3-credentials) / [SWIFT example](#example-of-openstack-swift-credentials)) |
| **mode** |  | **Option required**<br>Synchronisation mode:<br> ⏺ `unidirectional`: One way synchronization from source to destination without modifying any of the source files and deleting any of the destination files (unless `delete` option is enabled).<br> ⏺ `bidirectional`: Two way synchronisation between a source and target storage, without deleting any files (unless `delete` option is enabled). |
| **cron** |  | Define the period of the program execution, and must follow the CRON syntax, for instance every minute: `"*/1 * * * *"`. A new process is not started until the current synchronisation is finished. If the option is not defined, the synchronisation is executed immediately, one time. |
| **delete** | `false` | If `true`, files are deleted according to the synchronization mode logic. |
| **integrityCheck** | `false` | If `true`, MD5 hashes are checked for file integrity. |
| **logSync** | `false` | If `true`, at the end of each synchronisation, a JSON file is created including all file operations. |
| **cacheFilename** | `"listFiles.cache.json"` | File name of the cache, it is keeping the list of files synchronised during `bidirectional` mode only. The JSON file is created automatically in the current working directory (the directory the program is started from). An absolute path can also be provided. |
| **transfers** | `15` | Number of file operations to run in parallel: upload/deletion. If a storage responds with many errors (status 500, socket or authentication error), consider reducing the number of transfers. |
| **retry** | `1` | Max number of retries to sync a file. |
| **dryRun** | `false` | Do a trial run with no permanent changes, a JSON file is created including all file operations. |
| **maxDeletion** |  | Max number of deletions allowed during a file synchronisation. If the threshold is reached, the process is terminated before deleting anything. It is a security measure to avoid propagation of unexpected bulk deletions. |



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
    "bucket"  : ""  /** Bucket name that will be synchronised **/
}
```

### Example of S3 credentials

```jsonc
{
    "name"           : "s3",  /** Required by Sclone **/
    "url"            : "s3.gra.first.cloud.test", /** S3 URL, without the bucket name, and without "https://" **/
    "accessKeyId"    : "",    /** Your access key ID **/
    "secretAccessKey": "",    /** Your secret key **/
    "region"         : "",    /** Bucket region **/
    "bucket"         : ""     /** Bucket name that will be synchronised **/
}
```

### Environment variables

| Variable | Description |
|---|---|
| **SCLONE_CONFIG** | Path to the configuration file (filename or absolute path). Defaults to `config.json`. |
| **SCLONE_CRON** | Cron expression, overrides the `cron` option of the configuration file. |

## Synchronisation Strategy

### Unidirectional

Sclone adds, updates, and deletes (if enabled) files from a `source` to a `destination` storage, based on the files' md5 hash.

If the `delete` option is `false`, files on the destination storage are not deleted even if they do not exist on the source storage. In other words, the destination will accumulate all files.

If the `delete` option is `true`, files on the destination storage that do not exist on the source are deleted. The destination will be an exact copy of the source storage.

During unidirectional sync, no cache file is created.

### Bidirectional 

The file resolution is not based on the `source` but both storages. Sclone compares files' both md5 and modification times. If the md5 is different, only the newest file is kept. If the md5 is different but the modification times are identical, the source version wins the conflict.

For the first synchronisation, even if the `deletion` option is enabled, it won't delete anything. It will make sure the source and target are synchronised. If a file does not exist on one storage, it will be pushed into the other storage, and vice-versa. Finally, a cache of the list of synchronised files is created (named `listFiles.cache.json` by default).

For all subsequent synchronisations, Sclone will use the cache as the source of truth of the previous synchronisation to determine new, edited, or deleted files. If the cache is deleted, it will be considered a first synchronisation; it won't delete anything and will create a new cache. If a synchronisation ends with transfer errors, the cache is not updated: the failed files are retried on the next run.

## Development

Requires Node.js 20 or higher.

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

