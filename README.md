# sclone

Sclone, for "Storage Clone", is a node program to sync files and directories to and from different cloud storage providers supporting S3 or/and Open Stack SWIFT.

## Features

- **Unidirectional mode**: mode to just copy new/changed/deleted files from a source to a destination.
- **Bidirectional mode**: mode to make the source and target buckets identicals.
- **Job scheduler**: Use the Cron Syntax to start the process every minutes, every 30 minutes or anytime you want.
- **Optional deletion**: by default deletion is disabled: missing files are added on the source/target bucket. When enabled, files are deleted on the source/target bucket.
- **High performances**: files transfert is splited into multiple parrallel queues.
- **Files cached**: at the end of each process, the list of file is cached for better performances on the next execution.
- **Optional integrity check**: MD5 hashes checked for file integrity. Disabled by default.

## Benchmark

> Environment: VPS OVH - 2 vCores - 4GB Ram - Bandwidth 500Mbit/s - Debian 12 - Node 20.5.1 - Strasbourg (France)


### Test 1: S3 to S3

Bidirectional sync between a source S3 to a target S3 (deletion: false).

| | **1GB** objects from OVH GRA to OVH SBG | **10GB**  objects from OVH GRA to OVH SBG | **5GB**  objects from OVHCloud to Scaleway | **50GB**  objects from OVHCloud to Scaleway |
|-----------------------------|-------------------------------|--------------------------------|------------------------------|--------------------------------|
| **sclone**                  |   23.2 Sec                            |                                |                              |                                |
| **rclone**                  |                               |                                |                              |                                |
| **s3sync**                  |                               |                                |                              |                                |

### Test 2: SWIFT to S3

Bidirectional sync between a source SWIFT storage to a target S3 (deletion: false).

| | **5GB**  OVHCloud to OVHCloud | **100GB** OVHCloud to OVHCloud | **5GB** OVHCloud to Scaleway | **100GB** OVHCloud to Scaleway |
|---|---|---|---|---|
| **sclone** |  |  |  |  |
| **rclone** |  |  |  |  |

## Configuration

At the root of the project, copy the `config.default.json` and name it `config.json`.

### List of options

| Options | Default value  | Description |
|---|---|---|
| **source** | | Storage credentials ([S3 Example](#example-of-s3-credentials) / [SWIFT example](#example-of-openstack-swift-credentials)) |
| **target** | | Storage credentials ([S3 Example](#example-of-s3-credentials) / [SWIFT example](#example-of-openstack-swift-credentials)) |
| **mode** |  | Synchronisation mode:<br> ⏺ `unidirectional`: One way synchronization from source to destination without modifying any of the source files and deleting any of the destination files (unless `delete` option is enabled).<br> ⏺ `bidirectional`: Two way synchronisation between a source and target storage, without deleting any of the files (unless `delete` option is enabled). |
| **cron** |  | Define the period of the program execution, and must follow the CRON syntax, for instance every minutes: `"*/1 * * * *"`. New process are not started until the current synchronisation is not finised. |
| **delete** | `false` | When file deletion is enabled with `true`, according to the synchronization mode |
| **integrityCheck** | `false` | If `true`, MD5 hashes are checked for file integrity. |
| **logSync** | `false` | If `true`, at the end of each synchronisation, a JSON file is created including all file operations |
| **cacheFilename** | `"listFiles.cache.json"` | File name of the cache, it is keeping the list of files synchronised during `bidirectional` mode only. The JSON file is created automatically at the root of the repository. |



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