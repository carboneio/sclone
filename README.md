# Sclone ⚡️

Sclone, for "Storage Clone", is a program to sync files to and from different cloud storage providers supporting S3 and Open Stack SWIFT.

It offers fast speed thanks to parallelizes workloads and list file caching.
If you would like to know more about performance, refer to [benchmarks](#benchmarks) section.

## Features

- **Unidirectional mode**: mode to just copy new/changed/deleted files from a source to a destination.
- **Bidirectional mode**: mode to make the source and target buckets identicals.
- **Job scheduler**: Use the Cron Syntax to start the process every minutes, every 30 minutes or anytime you want.
- **Optional deletion**: by default deletion is disabled: missing files are added on the source/target bucket. When enabled, files are deleted on the source/target bucket.
- **High speed**: Files transfert is splited into parrallel queues. Et the end of each process, the list of file is cached for better performances on the next execution.
- **Optional integrity check**: MD5 hashes checked for file integrity. Disabled by default.
- **Metadata preserved**: from s3 to swift or swift to s3, metadatas are preserved/converted automatically.
- **Production ready**: Battle tested with Terabytes of buckets
- **Dry run**: Output what operations will be performed without actually carrying out those operations.
- **Support any S3 and SWIFT provider**:  AWS S3, OVHCloud, Scaleway, Ceph.io,  DigitalOcean Spaces, Cloudflare R2, Seagate Lyve Cloud, Tencent Cloud, Alibaba Cloud OSS, IBM COS S3, Dreamhost S3, GCS, IDrive e2, Synology C2, IONOS Cloud, Minio, Petabox, and more...

## Benchmarks

> * Environment: VPS OVH - 2 vCores - 4GB Ram - Bandwidth 500Mbit/s - Debian 12 - Node 20.5.1 - Strasbourg (France)
> * Default options were used for sclone / rclone / s3sync
> * OVH S3 bucket type: normal (and not performance)

Unidirectional sync between a source storage to a target storage located at different region. Every synchronization used the identical 10 GB dataset of 1624 files.

| | **10GB** from S3 OVH Gra to S3 OVH Sbg | **10GB** from S3 OVH Gra to S3 Scaleway Paris | **10GB** from S3 OVH Gra to SWIFT OVH Gra |
|-----------------------------|-------------------------------|-------------------------------|--------------------------------|
| **sclone**  | 3.30 Min  |  4.10 Min   | 3.27 Min  |
| **rclone**  | 5.45 Min |  10.51 Min  | 6.32 Min |
| **s3sync**  | 3.10 Min |   4.09 Min   | ❌ |

Bidirectional sync between two storages located at different region. Every synchronization used the same two data-set of 8GB (1354 files) with 1/3 common files, 1/3 new files and 1/3 edited files.

| | **8GB** S3 OVH Gra <> **8GB** S3 OVH Sbg | **8GB** S3 OVH Gra <> **8GB** S3 Scaleway Paris | **8GB** from S3 OVH Gra <> **8GB** SWIFT OVH Gra |
|-----------------------------|-------------------------------|-------------------------------|--------------------------------|
| **sclone**  | 3.59 Min | 4.11 Min | 3.42 Min |
| **rclone**  | 8.4 Min | 13.57 Min | 10.40 Min |

## Quickstart

1. Download the latest binary from [Release page](https://github.com/carboneio/sclone/releases).
2. Create a file `config.json` near the binary to define the source/target storage credentials, and options. You can copy the `config.default.json` file as an example. Read the [configuration](#configuration) section for details.
3. Finally start the synchronisation. 
```sh
./sclone-1.0.0-linux
```
> 🟢 Tip: Set the option `"dryRun":true` on the `config.json`, it will output on a log file what operations will be performed without actually carrying out those operations.

## Configuration

At the root of the project, copy the `config.default.json` and name it `config.json`.

### List of options

| Options | Default value  | Description |
|---|---|---|
| **source** | | **Option required**<br> Storage credentials ([S3 Example](#example-of-s3-credentials) / [SWIFT example](#example-of-openstack-swift-credentials)) |
| **target** | | **Option required**<br>Storage credentials ([S3 Example](#example-of-s3-credentials) / [SWIFT example](#example-of-openstack-swift-credentials)) |
| **mode** |  | **Option required**<br>Synchronisation mode:<br> ⏺ `unidirectional`: One way synchronization from source to destination without modifying any of the source files and deleting any of the destination files (unless `delete` option is enabled).<br> ⏺ `bidirectional`: Two way synchronisation between a source and target storage, without deleting any of the files (unless `delete` option is enabled). |
| **cron** |  | Define the period of the program execution, and must follow the CRON syntax, for instance every minutes: `"*/1 * * * *"`. New process are not started until the current synchronisation is not finised. If the option is not defined, the synchronisation is executed immediately. |
| **delete** | `false` | If `true`, files are deleted according to the synchronization mode logic. |
| **integrityCheck** | `false` | If `true`, MD5 hashes are checked for file integrity. |
| **logSync** | `false` | If `true`, at the end of each synchronisation, a JSON file is created including all file operations. |
| **cacheFilename** | `"listFiles.cache.json"` | File name of the cache, it is keeping the list of files synchronised during `bidirectional` mode only. The JSON file is created automatically at the root of the repository. |
| **transfers** | `15` | Number of file operation to run in parallel: upload/deletion. If a storage responds many errors (status 500, socket or authentication error), consider reducing the number of transfers. |
| **retry** | `1` | Max numbers of retries to sync file. |
| **dryRun** | `false` | Do a trial run with no permanent changes, a JSON file is created including all file operations. |
| **maxDeletion** |  | Max number of deletion allowed during a file synchronisation. If the threshold is crossed, the process is terminated. It is a security measure to avoid propagation of unexpected bulk deletions. |



### Exemple of `config.json`
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

### Example of Openstack SWIFT credentials

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

## Synchronisation Strategy

### Unidirectional

Sclone adds, updates, and deletes (if enabled) files from a `source` to a `destination` storage, based on files md5 hash.

If the `delete` option is `false`, files on the destination storage are not deleted even if it does not exist on the source storage. In other words, the destination will accumulate all files.

If the `delete` option is `true`, files on the destination storage that do not exist on the source are deleted. The destination will be an exact copy of the source storage.

During unidirectional sync, no cache file is created.

### Bidirectional 

The file resolution is not based on the `source` but both storages. Sclone compares files' both md5 and modification times. If the md5 is different, only the newest file is kept. 

For the first synchronisation, even if the `deletion` option is enabled, it won't delete anything. It will make sure the source and target are synchronised. If a file does not exist on one storage, it will be pushed into the other storage, and vice-versa. Finally, a cache of the list of synchronised files is created (named `listFiles.cache.json` by default).

For all other synchronisation, Sclone will use the cache as the source of truth of the previous synchronisation to determine new, edited, or deleted files. If the cache is deleted, it will be considered a first synchronisation; it won't delete anything and will create a new cache.

## Roadmap

> 👉 Create an issue to suggest ideas 👈

- ✅ Create a ready to use binary
- ⬜️ Enable local <> S3/Swift sync
- ⬜️ Set options through environment variables or CLI

## Supporters

This packaged in maintained by Carbone:

<p>
  <a href="https://carbone.io" alt="Carbone.io - Efficient PDF / DOCX / XLSX / CSV / HTML / XML generator with templates and JSON">
    <img src="https://raw.githubusercontent.com/carboneio/rock-req/master/doc/carbone-logo.svg" alt="Carbone.io logo" height="60"/>
  </a>
</p>

