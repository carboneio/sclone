const sclone = require('./sclone');

/** The cause is already logged by sclone (config_error, storage_connect_failed, sync_end...) */
sclone((err) => {
  if (err) {
    process.exitCode = 1;
  }
});

/** systemctl stop/restart (SIGTERM), Ctrl+C (SIGINT): `sync_end status=interrupted`, then exit 143/130. A second signal exits at once */
let stopping = false;
for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]]) {
  process.on(signal, () => {
    if (stopping === true) {
      process.exit(code);
    }
    stopping = true;
    sclone.interrupt(signal);
    /** Exit once the last line is written: stdout can be asynchronous (pipe) */
    process.stdout.write('', () => process.exit(code));
  });
}
