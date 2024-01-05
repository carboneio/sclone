const fs = require('fs');
const path = require('path');
const helper = require('./helper');

/**
 * TODO:
 * - [ ] Improve log deletion: `syncLogClean` function
 */

/**
 * @param {*} callback
 */
function computeSync(files, mode, deletion, logSync) {

  if (!mode) {
    throw new Error("Function computeSync: missing argument `mode`, options: " + helper.SUPPORTED_MODES.join(', '));
  }

  deletion = deletion ?? false;
  logSync = logSync ?? false;

  const objectsToUploadSource = [];
  const objectsToDeleteSource = [];
  let objectsToUpdateSource = 0;

  const objectsToUploadTarget = [];
  const objectsToDeleteTarget = [];
  let objectsToUpdateTarget = 0;

  console.log(`Total Files BEFORE SYNC S/T: ${files.source.size}/${files.target.size}`)

  /** Compare listFilesSwift <> listFilesS3 and set action: toDeleteTarget / toUploadSource  */
  for (const [key, value] of files.target) {
    const _objectSource = files.source.get(key);
    const _objectCache = files.cache.get(key);

    /** Si un object n'existe pas dans la source, et qu'il existe dans le cache: on supprime du cache et de la target */
    if (mode === helper.MODES.BI && deletion === true && _objectSource === undefined && _objectCache !== undefined) {
      files.target.delete(key);
      files.cache.delete(key);
      objectsToDeleteTarget.push(value);
    } else if (mode === helper.MODES.BI && deletion === false && _objectSource === undefined && _objectCache !== undefined) {
      files.source.set(key, value);
      files.cache.set(key, value);
      objectsToUploadSource.push(value);
    }

    /** Si un object n'existe pas dans la source, et qu'il n'existe pas dans le cache: nouveau fichier à ajouter dans la source */
    if (mode === helper.MODES.BI && _objectSource === undefined && _objectCache === undefined) {
      files.cache.set(key, value);
      files.source.set(key, value);
      objectsToUploadSource.push(value);
    }

    /** If a file exists on both side, but the content changed */
    if (mode === helper.MODES.BI && _objectSource !== undefined && _objectSource.md5 !== value.md5 && value.lastmodified > _objectSource.lastmodified) {
      files.cache.set(key, value);
      files.source.set(key, value);
      value.updated = true;
      objectsToUploadSource.push(value);
      objectsToUpdateSource++;
    }

    /** UNI: If a file does not exist on the source, it is deleted on the target */
    if (mode === helper.MODES.UNI && deletion === true && _objectSource === undefined) {
      objectsToDeleteTarget.push(value);
      files.target.delete(key);
    }
  }

  /** Compare listFilesSwift <> listFilesS3 and set action: toUploadS3 */
  for (const [key, value] of files.source) {
    const _objectTarget = files.target.get(key);
    const _objectCache = files.cache.get(key);

    if (mode === helper.MODES.BI && deletion === true && _objectTarget === undefined && _objectCache !== undefined) {
      files.source.delete(key);
      files.cache.delete(key);
      objectsToDeleteSource.push(value);
    } else if (mode === helper.MODES.BI && deletion === false && _objectTarget === undefined && _objectCache !== undefined) {
      files.cache.set(key, value);
      files.target.set(key, value);
      objectsToUploadTarget.push(value);
    }

    /** Si un object source n'existe pas dans la target, et qu'il n'existe pas dans le cache, on ajoute dans la target et le cache */
    if ((mode === helper.MODES.BI && _objectTarget === undefined && _objectCache === undefined) ||
        (mode === helper.MODES.UNI && _objectTarget === undefined)) {
      files.target.set(key, value);
      files.cache.set(key, value);
      objectsToUploadTarget.push(value);
    }

    /** If a file exists on both side, but the content changed */
    if ((mode === helper.MODES.BI && _objectTarget !== undefined && _objectTarget.md5 !== value.md5 && value.lastmodified > _objectTarget.lastmodified) ||
        (mode === helper.MODES.UNI && _objectTarget !== undefined && _objectTarget.md5 !== value.md5)) {
      files.target.set(key, value);
      files.cache.set(key, value);
      value.updated = true;
      objectsToUploadTarget.push(value);
      objectsToUpdateTarget++;
    }
  }
  console.log(`Total Files AFTER SYNC S/T: ${files.source.size}/${files.target.size}\nSummary Source | Uploads: ${objectsToUploadSource.length} (Updates ${objectsToUpdateSource}) / Deletions: ${objectsToDeleteSource.length} |\nSummary Target | Uploads: ${objectsToUploadTarget.length} (Updates ${objectsToUpdateTarget}) / Deletions: ${objectsToDeleteTarget.length} |`)

  if (logSync === true) {
    syncLogGenerate({ toUploadSource: objectsToUploadSource, toDeleteSource: objectsToDeleteSource, toUploadTarget: objectsToUploadTarget, toDeleteTarget: objectsToDeleteTarget })
  }

  return {
    objectsToUploadSource,
    objectsToDeleteSource,
    objectsToUploadTarget,
    objectsToDeleteTarget
  }
}

function syncLogGenerate(data) {
  try {
    if (fs.existsSync(path.join("logs")) === false) {
      fs.mkdirSync(path.join("logs"));
    }
    const date = new Date().toISOString().split('.')[0].replace('T', '-').replace(/:/g, '-') + "Z";
    fs.writeFileSync(path.join("logs", 'sync-' + date + '.json'), JSON.stringify(data))
  } catch(err) {
    console.log("Log sync error catched:" + err.toString());
  }
}

function syncLogClean(interval) {
  try {
    interval = interval ?? 24 * 60 * 60 * 1000; // Every day
    const uploadsDir = path.join(__dirname, "logs");
    fs.readdir(uploadsDir, function(err, files) {
      files.forEach(function(file) {
        fs.stat(path.join(uploadsDir, file), function(err, stat) {
          if (err) {
            return console.log(err);
          }
          const now = new Date().getTime();
          const endTime = new Date(stat.ctime).getTime() + interval;
          if (now > endTime) {
            return fs.rm(path.join(uploadsDir, file), function(err) {
              if (err) {
                return console.log(err);
              }
            });
          }
        });
      });
    });
  } catch(err) {
    console.log("Clean log error catched: " + err.toString());
  }
}

module.exports = {
  computeSync,
  syncLogClean,
  syncLogGenerate
}