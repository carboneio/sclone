const fs = require('fs');
const path = require('path');
const helper = require('./helper');
const logger = require('./logger');

/** S3 multipart upload etag: "<md5 of the parts md5>-<number of parts>", it is NOT the MD5 of the content */
const MULTIPART_ETAG_REGEX = /^[0-9a-f]{32}-\d+$/i;
const MD5_REGEX = /^[0-9a-f]{32}$/i;
/** Destination of an upload */
const TO_SOURCE = 'source';
const TO_TARGET = 'target';
/** Max number of `sync_conflict` lines per run, the total is in `sync_plan` */
const MAX_CONFLICT_LOGS = 100;

/** The length and the "-" are checked first: the regular expression runs only on candidates */
function isMultipartEtag(md5) {
  return typeof md5 === 'string' && md5.length > 33 && md5.charCodeAt(32) === 45 && MULTIPART_ETAG_REGEX.test(md5);
}

function isMd5(etag) {
  return typeof etag === 'string' && etag.length === 32 && MD5_REGEX.test(etag);
}

/**
 * An etag which is neither an MD5 nor a multipart etag: it does not tell the content. OVH lists the encrypted objects
 * copied server-side with a 64 hex etag that changes on each copy, while a HEAD returns the MD5.
 */
function isOpaqueEtag(etag) {
  return isMd5(etag) === false && isMultipartEtag(etag) === false;
}

/** Comparable etag of a listed object: undefined if an opaque etag is not resolved yet, null if it cannot be resolved */
function contentEtag(object) {
  return isOpaqueEtag(object.md5) === true ? object.resolvedMd5 : object.md5;
}

/** Same hexadecimal etag, whatever the case: lowercased only if the strings differ (rare) */
function isSameEtag(etagA, etagB) {
  return etagA === etagB || (etagA.length === etagB.length && etagA.toLowerCase() === etagB.toLowerCase());
}

/**
 * Returns true if the listed object changed since its last synchronisation, or was never synchronised.
 * The cache is kept on the listed objects: `cachedEtag` and `cachedBytes`, the token of its side after the last
 * synchronisation (undefined: no cache, null: unknown). The etag is an opaque token: any rewrite of the object changes it.
 */
function hasChanged(object) {
  return object.cachedEtag === undefined || object.md5 !== object.cachedEtag || object.bytes !== object.cachedBytes;
}

/** The key was synchronised by a previous run: one of its listed sides has a cached token */
function hasCache(source, target) {
  return source?.cachedEtag !== undefined || target?.cachedEtag !== undefined;
}

/** Record the token of a side in the cache, undefined removes it */
function setCache(object, etag, bytes) {
  object.cachedEtag = etag;
  object.cachedBytes = bytes;
}

/**
 * Compare the content of two listed objects without downloading them.
 * - different sizes: different content,
 * - plain MD5 etags (single PUT): equal if identical. An opaque etag is resolved first with a HEAD,
 * - multipart etags: equal only to the identical multipart etag.
 * The cache removes the need to compare after the first synchronisation. On the first one only (`isBootstrap`), a
 * multipart object and a plain copy of the same size are equal if the multipart version is not newer: sclone copies with a
 * single PUT, so its copies of the multipart objects would all be uploaded again once (unidirectional: only for a multipart
 * source, see `_decideUni`).
 *
 * @returns {Boolean|undefined} true: same content, false: different or not provable, undefined: an etag must be resolved first
 */
function isSameContent(fileA, fileB, isBootstrap) {
  if (fileA.bytes !== fileB.bytes) {
    return false;
  }
  /** Fast path of the first synchronisation: the same MD5 or multipart etag */
  if (fileA.md5 === fileB.md5 && isOpaqueEtag(fileA.md5) === false) {
    return true;
  }
  const _etagA = contentEtag(fileA);
  const _etagB = contentEtag(fileB);
  if (_etagA === undefined || _etagB === undefined) {
    return undefined;
  }
  if (_etagA !== null && _etagB !== null && isSameEtag(_etagA, _etagB) === true) {
    return true;
  }
  if (isBootstrap !== true || typeof fileA.bytes !== 'number') {
    return false;
  }
  if (isMultipartEtag(_etagA) === true && isMd5(_etagB) === true) {
    return fileA.lastmodified <= fileB.lastmodified;
  }
  if (isMultipartEtag(_etagB) === true && isMd5(_etagA) === true) {
    return fileB.lastmodified <= fileA.lastmodified;
  }
  return false;
}

/**
 * Compute the operations of a synchronisation from the listings and the cache (last synchronised token of each side, kept
 * on the listed objects). The cache is updated with the facts known without any transfer: identical objects are recorded.
 * The transferred and deleted objects are updated by `updateCache`, after success only.
 *
 * Unidirectional: the source wins. Bidirectional: the side that changed since the last synchronisation wins; when both
 * changed (or without cache), a deletion never wins against a modification, and the most recent modification wins (`sync_conflict`).
 *
 * If some opaque etags must be resolved to decide, nothing is planned: `objectsToResolve` lists them ({ side, object }).
 * Set `resolvedMd5` on each object (MD5 or null) and call computeSync again.
 *
 * @param {Object} files { source: Map, target: Map } listed objects by key
 * @param {Object} options { etagResolved, emptySides } number of etags resolved (for the logs), empty sides of the first pass
 * @returns {Object} the operations, and `emptySides` ({ source, target }: Boolean) for the deletion guards
 */
function computeSync(files, mode, deletion, logSync, options) {

  if (!mode) {
    throw new Error("Function computeSync: missing argument `mode`, options: " + helper.SUPPORTED_MODES.join(', '));
  }

  deletion = deletion ?? false;
  logSync = logSync ?? false;

  const _isBi = mode === helper.MODES.BI;
  const objectsToUploadSource = [];
  const objectsToDeleteSource = [];
  const objectsToUploadTarget = [];
  const objectsToDeleteTarget = [];
  const objectsToResolve = [];
  const _conflicts = [];
  let objectsToUpdateSource = 0;
  let objectsToUpdateTarget = 0;

  const _upload = (toSide, object) => {
    if (toSide === TO_TARGET) {
      objectsToUpdateTarget += files.target.has(object.key) ? 1 : 0;
      return objectsToUploadTarget.push(object);
    }
    objectsToUpdateSource += files.source.has(object.key) ? 1 : 0;
    return objectsToUploadSource.push(object);
  };
  const _record = (source, target) => {
    setCache(source, source.md5, source.bytes);
    setCache(target, target.md5, target.bytes);
  };
  const _resolve = (source, target) => {
    for (const [_side, _object] of [['source', source], ['target', target]]) {
      if (isOpaqueEtag(_object.md5) === true && _object.resolvedMd5 === undefined) {
        objectsToResolve.push({ side: _side, object: _object });
      }
    }
  };
  /** Identical: recorded. Different: `onDifferent()`. Unknown: resolved first */
  const _compare = (source, target, isBootstrap, onDifferent) => {
    const _isSame = isSameContent(source, target, isBootstrap);
    if (_isSame === undefined) {
      return _resolve(source, target);
    }
    return _isSame === true ? _record(source, target) : onDifferent();
  };
  /** Both sides changed: the most recent version wins, the source on a tie. A deleted version never wins */
  const _conflict = (key, source, target, reason) => {
    const _winner = source === undefined || (target !== undefined && target.lastmodified > source.lastmodified) ? 'target' : 'source';
    _conflicts.push({ key, reason, winner: _winner, source, target });
    return _winner === 'target' ? _upload(TO_SOURCE, target) : _upload(TO_TARGET, source);
  };

  const _decideUni = (key, source, target) => {
    if (target === undefined) {
      return _upload(TO_TARGET, source);
    }
    if (source === undefined) {
      /** Without "delete", the cache of a target-only object is useless */
      return deletion === true ? objectsToDeleteTarget.push(target) : setCache(target, undefined, undefined);
    }
    const _hasCache = hasCache(source, target);
    if (_hasCache === true && hasChanged(source) === false && hasChanged(target) === false) {
      return;
    }
    /**
     * The source wins: a version edited on the target only is replaced too. The multipart rule of the first synchronisation
     * applies only to a multipart source and its plain copy: a multipart target was not written by sclone
     */
    return _compare(source, target, _hasCache === false && isMultipartEtag(source.md5) === true, () => _upload(TO_TARGET, source));
  };

  const _decideBi = (key, source, target) => {
    if (hasCache(source, target) === false) {
      if (target === undefined) {
        return _upload(TO_TARGET, source);
      }
      if (source === undefined) {
        return _upload(TO_SOURCE, target);
      }
      return _compare(source, target, true, () => _conflict(key, source, target, 'both_new'));
    }
    const _sourceChanged = source === undefined || hasChanged(source);
    const _targetChanged = target === undefined || hasChanged(target);
    if (_sourceChanged === false && _targetChanged === false) {
      return;
    }
    if (_sourceChanged === true && _targetChanged === true) {
      if (source === undefined || target === undefined) {
        return _conflict(key, source, target, 'deleted_modified');
      }
      return _compare(source, target, false, () => _conflict(key, source, target, 'both_modified'));
    }
    /** One side changed, the other one is unchanged since the last synchronisation */
    if (source === undefined) {
      return deletion === true ? objectsToDeleteTarget.push(target) : _upload(TO_SOURCE, target);
    }
    if (target === undefined) {
      return deletion === true ? objectsToDeleteSource.push(source) : _upload(TO_TARGET, source);
    }
    return _compare(source, target, false, () => (_sourceChanged === true ? _upload(TO_TARGET, source) : _upload(TO_SOURCE, target)));
  };

  /** Single pass over each listing. The listed objects with a cached token are counted before any decision changes it */
  const _decide = _isBi === true ? _decideBi : _decideUni;
  let _cachedSource = 0;
  let _cachedTarget = 0;
  for (const [key, source] of files.source) {
    const _target = files.target.get(key);
    _cachedSource += typeof source.cachedEtag === 'string' ? 1 : 0;
    _cachedTarget += typeof _target?.cachedEtag === 'string' ? 1 : 0;
    _decide(key, source, _target);
  }
  for (const [key, target] of files.target) {
    if (files.source.has(key) === false) {
      _cachedTarget += typeof target.cachedEtag === 'string' ? 1 : 0;
      _decide(key, undefined, target);
    }
  }
  /**
   * A side is empty if it is listed empty, or if none of its listed objects was synchronised while the other side has
   * synchronised objects: emptied then refilled with new files. Kept from the first pass when the etags are resolved
   */
  const emptySides = options?.emptySides ?? {
    source: files.source.size === 0 || (_cachedSource === 0 && _cachedTarget > 0),
    target: files.target.size === 0 || (_cachedTarget === 0 && _cachedSource > 0)
  };
  if (objectsToResolve.length > 0) {
    return { objectsToResolve, emptySides, objectsToUploadSource: [], objectsToDeleteSource: [], objectsToUploadTarget: [], objectsToDeleteTarget: [] };
  }
  for (let i = 0; i < Math.min(_conflicts.length, MAX_CONFLICT_LOGS); i++) {
    logConflict(_conflicts[i]);
  }
  const _plan = {
    upload_target      : objectsToUploadTarget.length - objectsToUpdateTarget,
    update_target      : objectsToUpdateTarget,
    delete_target      : objectsToDeleteTarget.length,
    upload_source      : objectsToUploadSource.length - objectsToUpdateSource,
    update_source      : objectsToUpdateSource,
    delete_source      : objectsToDeleteSource.length,
    upload_target_bytes: sumBytes(objectsToUploadTarget),
    upload_source_bytes: sumBytes(objectsToUploadSource),
    conflicts          : _conflicts.length || undefined,
    etag_resolved      : options?.etagResolved || undefined
  };
  const _isEmpty = objectsToUploadTarget.length + objectsToDeleteTarget.length + objectsToUploadSource.length + objectsToDeleteSource.length === 0;
  /** An empty plan is debug: the "sync_end" line already says that nothing was transferred */
  logger.log(_isEmpty ? 'debug' : 'info', 'sync_plan', 'Synchronisation plan computed', _plan);

  if (logSync === true) {
    syncLogGenerate({ toUploadSource: objectsToUploadSource, toDeleteSource: objectsToDeleteSource, toUploadTarget: objectsToUploadTarget, toDeleteTarget: objectsToDeleteTarget });
  }

  return {
    objectsToResolve,
    emptySides,
    objectsToUploadSource,
    objectsToDeleteSource,
    objectsToUploadTarget,
    objectsToDeleteTarget
  };
}

function logConflict({ key, reason, winner, source, target }) {
  const _date = (object) => (object ? new Date(object.lastmodified).toISOString() : undefined);
  logger.log('warn', 'sync_conflict', `Both sides changed, the ${winner} version is kept`, {
    key,
    reason,
    winner,
    source_etag        : source?.md5 ?? 'deleted',
    source_bytes       : source?.bytes,
    source_lastmodified: _date(source),
    target_etag        : target?.md5 ?? 'deleted',
    target_bytes       : target?.bytes,
    target_lastmodified: _date(target)
  });
}

/**
 * Update the cache after the transfers: a copied object gets the token of both sides, a deleted object is removed from its
 * listing (no cache). A failed operation keeps its previous cache: it is planned again by the next run.
 * The workers set `copied` ({ etag, bytes, sourceChanged }) and `deleted` on the objects.
 *
 * @param {Object} files { source: Map, target: Map }
 */
function updateCache(files, plan) {
  const _copy = (object, to) => {
    setCache(object, object.copied.sourceChanged === true ? null : object.md5, object.bytes);
    let _destination = to.get(object.key);
    if (_destination === undefined) {
      _destination = { key: object.key, md5: object.copied.etag, lastmodified: Date.now(), bytes: object.copied.bytes, cachedEtag: undefined, cachedBytes: undefined };
      to.set(object.key, _destination);
    }
    setCache(_destination, object.copied.etag, object.copied.bytes);
  };
  for (const object of plan.objectsToUploadTarget) {
    if (object.copied !== undefined) {
      _copy(object, files.target);
    }
  }
  for (const object of plan.objectsToUploadSource) {
    if (object.copied !== undefined) {
      _copy(object, files.source);
    }
  }
  for (const [list, listing] of [[plan.objectsToDeleteTarget, files.target], [plan.objectsToDeleteSource, files.source]]) {
    for (const object of list) {
      if (object.deleted === true) {
        listing.delete(object.key);
      }
    }
  }
}

/** Sum of the sizes of the files (uploads include the updates) */
function sumBytes (list) {
  let _bytes = 0;
  for (let i = 0; i < list.length; i++) {
    _bytes += Number(list[i]?.bytes) || 0;
  }
  return _bytes;
}

function syncLogGenerate(data) {
  try {
    if (fs.existsSync(path.join("logs")) === false) {
      fs.mkdirSync(path.join("logs"));
    }
    const date = new Date().toISOString().split('.')[0].replace('T', '-').replace(/:/g, '-') + "Z";
    const _path = path.join("logs", 'sync-' + date + '.json');
    fs.writeFileSync(_path, JSON.stringify(data));
    logger.log('info', 'sync_log_file', 'Synchronisation plan written', { path: path.resolve(_path) });
  } catch(err) {
    logger.log('warn', 'sync_log_error', 'Synchronisation plan not written', { error: err.toString() });
  }
}

function syncLogClean(interval) {
  try {
    interval = interval ?? 24 * 60 * 60 * 1000; // Every day
    const uploadsDir = path.join(__dirname, "logs");
    fs.readdir(uploadsDir, function(err, files) {
      if (err || !files) {
        return logger.log('warn', 'log_cleanup_error', 'Clean log error', { error: err?.toString() ?? "no files" });
      }
      files.forEach(function(file) {
        fs.stat(path.join(uploadsDir, file), function(err, stat) {
          if (err) {
            return logger.log('warn', 'log_cleanup_error', 'Clean log error', { error: err.toString() });
          }
          const now = new Date().getTime();
          const endTime = new Date(stat.ctime).getTime() + interval;
          if (now > endTime) {
            return fs.rm(path.join(uploadsDir, file), function(err) {
              if (err) {
                return logger.log('warn', 'log_cleanup_error', 'Clean log error', { error: err.toString() });
              }
            });
          }
        });
      });
    });
  } catch(err) {
    logger.log('warn', 'log_cleanup_error', 'Clean log error', { error: err.toString() });
  }
}

module.exports = {
  computeSync,
  updateCache,
  hasCache,
  isSameContent,
  isMultipartEtag,
  isMd5,
  isOpaqueEtag,
  syncLogClean,
  syncLogGenerate
};