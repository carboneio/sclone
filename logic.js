const fs = require('fs');
const path = require('path');
const helper = require('./helper');

/**
 * TODO:
 * - [ ] Improve log deletion: `syncLogClean` function
 */

/** S3 multipart upload etag: "<md5 of the parts md5>-<number of parts>", it is NOT the MD5 of the content */
const MULTIPART_ETAG_REGEX = /^[0-9a-f]{32}-\d+$/i;

function isMultipartEtag(md5) {
  return typeof md5 === 'string' && MULTIPART_ETAG_REGEX.test(md5);
}

/**
 * Returns true if both files have the same content.
 *
 * A file copied by sclone is uploaded with a single PUT: if the original has a multipart etag, the copy gets
 * the real MD5 and the two values never match. In that case only, the files are considered identical if:
 * - they have the same size,
 * - and the multipart version is not newer than the other one: the copy is always created after the
 *   original, a multipart version newer than the copy means that the original was uploaded again since.
 */
function isSameContent(fileA, fileB) {
  if (fileA.md5 === fileB.md5) {
    return true;
  }
  const _isMultipartA = isMultipartEtag(fileA.md5);
  if (_isMultipartA === isMultipartEtag(fileB.md5)) {
    return false;
  }
  const _multipart = _isMultipartA ? fileA : fileB;
  const _other = _isMultipartA ? fileB : fileA;
  return typeof _multipart.bytes === 'number'
    && _multipart.bytes === _other.bytes
    && _multipart.lastmodified <= _other.lastmodified;
}

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

  console.log(`Total Files BEFORE SYNC S/T: ${files.source.size}/${files.target.size}`);

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
    if (mode === helper.MODES.BI && _objectSource !== undefined && isSameContent(_objectSource, value) === false && value.lastmodified > _objectSource.lastmodified) {
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

    /** If a file exists on both side, but the content changed.
     * ">=" and not ">": when the timestamps are identical, the source version wins the conflict
     * (the target loop above uses a strict ">", so only this direction fires on a tie) */
    if ((mode === helper.MODES.BI && _objectTarget !== undefined && isSameContent(_objectTarget, value) === false && value.lastmodified >= _objectTarget.lastmodified) ||
        (mode === helper.MODES.UNI && _objectTarget !== undefined && isSameContent(_objectTarget, value) === false)) {
      files.target.set(key, value);
      files.cache.set(key, value);
      value.updated = true;
      objectsToUploadTarget.push(value);
      objectsToUpdateTarget++;
    }
  }
  console.log(`Total Files AFTER SYNC S/T: ${files.source.size}/${files.target.size}\nSummary Source | Uploads: ${objectsToUploadSource.length} (Updates ${objectsToUpdateSource}) / Deletions: ${objectsToDeleteSource.length} |\nSummary Target | Uploads: ${objectsToUploadTarget.length} (Updates ${objectsToUpdateTarget}) / Deletions: ${objectsToDeleteTarget.length} |`);

  if (logSync === true) {
    syncLogGenerate({ toUploadSource: objectsToUploadSource, toDeleteSource: objectsToDeleteSource, toUploadTarget: objectsToUploadTarget, toDeleteTarget: objectsToDeleteTarget });
  }

  return {
    objectsToUploadSource,
    objectsToDeleteSource,
    objectsToUploadTarget,
    objectsToDeleteTarget
  };
}

function syncLogGenerate(data) {
  try {
    if (fs.existsSync(path.join("logs")) === false) {
      fs.mkdirSync(path.join("logs"));
    }
    const date = new Date().toISOString().split('.')[0].replace('T', '-').replace(/:/g, '-') + "Z";
    fs.writeFileSync(path.join("logs", 'sync-' + date + '.json'), JSON.stringify(data));
  } catch(err) {
    console.log("Log sync error catched:" + err.toString());
  }
}

function syncLogClean(interval) {
  try {
    interval = interval ?? 24 * 60 * 60 * 1000; // Every day
    const uploadsDir = path.join(__dirname, "logs");
    fs.readdir(uploadsDir, function(err, files) {
      if (err || !files) {
        return console.log("Clean log error: " + (err?.toString() ?? "no files"));
      }
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
  isSameContent,
  isMultipartEtag,
  syncLogClean,
  syncLogGenerate
};