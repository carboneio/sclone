# sclone

Sclone, for "Storage Clone", is a node program to sync files and directories to and from different cloud storage providers supporting S3 or/and Open Stack SWIFT.

## Features

- **Unidirectional mode**: mode to just copy new/changed/deleted files from a source to a destination.
- **Bidirectional mode**: mode to make the source and target buckets identicals.
- **Job scheduler**: Use the Cron Syntax to start the process every minutes, every 30 minutes or anytime you want.
- **Optional deletion**: by default deletion is disabled: missing files are added on the source/target bucket. When enabled, files are deleted on the source/target bucket.
- **High performances**: In a first stage, file listing is load into memory, then files transfert is splited into parrallel queues.
- **Files cached**: at the end of each process, the list of file is cached for better performances on the next execution.
- **Optional integrity check**: MD5 hashes checked for file integrity. Disabled by default.
- **Metadata kept**: from s3 to swift or swift to s3, metadata are kept.

## Benchmark

Unidirectional sync between a source storage to a target storage at different regions (deletion: false).

> * Environment: VPS OVH - 2 vCores - 4GB Ram - Bandwidth 500Mbit/s - Debian 12 - Node 20.5.1 - Strasbourg (France)
> * The same 10GB dataset was used for each synchronisation
> * OVH S3: normal (and not performance)
> * Default options for sclone and rclone

| | **10GB** from OVH GRA to OVH SBG | **10GB** from OVH GRA to Scaleway Paris | 
|-----------------------------|-------------------------------|--------------------------------|
| **sclone**  | 3.3 Min  |  4.10 Min   |
| **rclone**  | 5.45 Min |  10.51 Min  |



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