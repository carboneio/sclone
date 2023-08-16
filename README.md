# sclone

Sclone, for "Storage Clone", is a node scheduler to sync files and directories to and from different cloud storage providers supporting S3 or/and Open Stack SWIFT.

## Features

- **Unidirectional mode**: mode to just copy new/changed/deleted files from a source to a destination.
- **Bidirectional mode**: mode to make the source and target buckets identicals.
- **Job scheduler**: Use the Cron Syntax to start the process every minutes, every 30 minutes or anytime you want.
- **Optional deletion**: by default deletion is disabled: missing files are added on the source/target bucket. When enabled, files are deleted on the source/target bucket.
- **High performances**: files transfert is splited into multiple parrallel queues.
- **Files cached**: at the end of the first process, the list of file is cached for better performances on the next execution.
- **Optional integrity check**: MD5 hashes checked for file integrity. Disabled by default.