const storage = require('./storage');
const logic = require('./logic');
const helper = require('./helper');
const cron = require('node-cron');

let alreadyRunning = null;

let nbr = 0;

/** TODO: 
 * - [ ] initialise config directly from the argument of the function sclone(config, callback) => easier for testing or integration
 * */
function sclone (config, next) {
    if (!next) {
        next = config;
        config = {};
    }
    helper.loadConfig(process?.env?.SCLONE_CONFIG ?? 'config.json', (err, config) => {
        if (err) {
            return helper.stop(err);
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
        if (!config.transfers) {
            config.transfers = 15;
        }
        if (!config.retry) {
            config.retry = 1;
        }
        if (config?.dryRun === true) {
            console.log(`🟢 DRY RUN`);
        } else {
            config.dryRun = false;
        }
    
        console.log(`🟢 Synchronisation: ${config.mode} ( Source:${config.source.name} ${config.mode === helper.MODES.BI ? "<=>" : "=>"} Destination:${config.target.name} )`);
        console.log(config.delete === true ? "🟢 Deletion: Enabled 🚧 Danger" : "⚪️ Deletion: Disabled");
        if (process?.env?.SCLONE_CRON) {
            config.cron = process?.env?.SCLONE_CRON;
        }
        if (config?.cron) {
            if (cron.validate(config?.cron) === false) {
                return next("🔴 Cron expression not valid: " + config?.cron);
            }
            console.log("🟢 Cron Scheduled: " + config.cron);
        } else {
            console.log("⚪️ Cron: Disabled")
        }
  
        /** Connect storages */
        storage.connection(config, 'source', (err) => {
        if (err) {
            return next(err);
        }
        storage.connection(config, 'target', (err) => {
            if (err) {
                return next(err);
            }
            if (config.cron) {
                /** X Time execution */
                const _task = cron.schedule(config.cron, () => {
                    if (alreadyRunning !== null) {
                        return console.log("Cron sync already running! Started: " + alreadyRunning);
                    }
                    console.log("New synchro starting...");
                    alreadyRunning = new Date();
                    startSync(config, (err) => {
                        if (err) {
                            console.log("🔴 Process failed! Start: " + alreadyRunning + " / End: " + new Date() + "/ Details: " + err.toString());
                        } else {
                            console.log("✅ Process done! Start: " + alreadyRunning + " / End: " + new Date());
                        }
                        alreadyRunning = null;
                    });
                });

                return next(null, _task);
            } else {
                /** 1 time execution */
                startSync(config, (err) => {
                    if (err) {
                        return next(err);
                    }
                    console.log("✅ Process done!");
                    return next();
                });
            }
        });
    });
  });
}

function startSync(config, callback) {
  /** init maps */
  const files = {
    target        : new Map(),
    source        : new Map(),
    cache         : new Map(),
  };
  helper.fetchCache(config?.cacheFilename, config?.mode, files, (err) => {
    if (err) {
      /** Non blocking */
      console.log(err.toString());
    }
    /** Fetch list of files and convert into Maps types */
    storage.fetchListFiles(files, (err) => {
      if (err) {
        return callback(err);
      }
      /** Compute the logic of synchronisation */

      const { objectsToDeleteTarget, objectsToUploadTarget, objectsToUploadSource, objectsToDeleteSource } = logic.computeSync(files, config.mode, config?.delete, config?.logSync || config?.dryRun);

      if (config.dryRun === true) {
        console.log("✅ Dry run done: JSON file created in the \"logs\" folder that details all file operations");
        return callback();
      }
      if (typeof config?.maxDeletion === 'number' && config?.maxDeletion > 0 && (objectsToDeleteTarget.length >= config.maxDeletion || objectsToDeleteSource.length >= config.maxDeletion)) {
        return callback(new Error(`Too many element deleted | target: ${objectsToDeleteTarget.length} / source ${objectsToDeleteSource.length} | Process stopped!`));
      }
      /** Synchronise storages based on lists returned by "computeSync" */
      storage.syncFiles(objectsToUploadTarget, objectsToDeleteTarget, objectsToUploadSource, objectsToDeleteSource, config, function(err) {
        if (err) {
          return callback(err);
        }
        helper.saveCache(config?.cacheFilename, JSON.stringify([...(files.cache.size > 0 ? files.target : files.source)]), config.mode, function (err) {
          if (err) {
            return callback(err);
          }
          return callback();
        });
      });
    });
  });
}

module.exports = sclone;