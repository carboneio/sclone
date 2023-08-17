const storage = require('./storage');
const logic = require('./logic');
const helper = require('./helper');
const cron = require('node-cron')

let alreadyRunning = null;

helper.loadConfig('config.json', (err, config) => {
  if (err) {
    return helper.stop(err);
  }
  if (!config?.cron) {
    return helper.stop(new Error('config "cron" not defined on "config.json"'));
  }
  if (!config?.mode) {
    return helper.stop(new Error('config "mode" not defined on "config.json", accepted values: ' + helper.SUPPORTED_MODES.join(', ')));
  }
  if (helper.SUPPORTED_MODES.includes(config?.mode) === false) {
    return helper.stop(new Error('config "mode" not correct, accepted values: '+ helper.SUPPORTED_MODES.join(', ')));
  }
  if (!config?.delete) {
    config.delete = false;
  }
  if (!config?.cacheFilename) {
    config.cacheFilename = 'listFiles.cache.json';
  }
  console.log(`🟢 Synchronisation: ${config.mode} ( Source:${config.source.name} ${config.mode === helper.MODES.BI ? "<=>" : "=>"} Destination:${config.target.name} )`);
  console.log(config.delete === true ? "🟢 Deletion: Enabled 🚧 Danger" : "⚪️ Deletion: Disabled");
  console.log("🟢 Cron Scheduled: " + config.cron);

  /** Connect storages */
  storage.connection(config, 'source', (err) => {
    if (err) {
      return helper.stop(err);
    }
    storage.connection(config, 'target', (err) => {
      if (err) {
        return helper.stop(err);
      }
      cron.schedule(config.cron, () => {
        if (alreadyRunning !== null) {
          return console.log("Cron sync already running! Started: " + alreadyRunning);
        }
        console.log("New synchro starting...")
        alreadyRunning = new Date();

        /** init maps */
        const files = {
          target        : new Map(),
          source        : new Map(),
          cache         : new Map(),
        }
        helper.fetchCache(config?.cacheFilename, config?.mode, files, (err) => {
          if (err) {
            /** Non blocking */
            console.log(err.toString());
          }
          /** Fetch list of files and convert into Maps types */
          storage.fetchListFiles(files, (err) => {
            if (err) {
              alreadyRunning = null;
              return helper.stop(err);
            }
            /** Compute the logic of synchronisation */
            const { objectsToDeleteTarget, objectsToUploadTarget, objectsToUploadSource, objectsToDeleteSource } = logic.computeSync(files, config.mode, config?.delete, config?.logSync);

            if (objectsToDeleteTarget.length > 100 || objectsToDeleteSource.length > 100) {
              alreadyRunning = null;
              return helper.stop(new Error(`Too many element deleted | target: ${objectsToDeleteTarget.length} / source ${objectsToDeleteSource.length}`));
            }

            // /** Synchronise storages based on lists returned by "computeSync" */
            storage.syncFiles(objectsToUploadTarget, objectsToDeleteTarget, objectsToUploadSource, objectsToDeleteSource, config.mode, function(err) {
              if (err) {
                alreadyRunning = null;
                return helper.stop(err.toString());
              }
              helper.saveCache(config?.cacheFilename, JSON.stringify([...(files.cache.size > 0 ? files.target : files.source)]), config.mode, function (err) {
                if (err) {
                  alreadyRunning = null;
                  return helper.stop(err.toString());
                }
                console.log("✅ Process done! Start: " + alreadyRunning + " / End:" + new Date());
                alreadyRunning = null;
                return;
              });
            });
          })
        })
      })
    })
  })
});