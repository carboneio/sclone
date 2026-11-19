const storage = require('./storage');
const logic = require('./logic');
const helper = require('./helper');
const logger = require('./logger');
const cron = require('node-cron');

let alreadyRunning = null;
/** Run in progress, for interrupt(): one at most per process (a cron tick is skipped while a run is in progress) */
let currentRun = null;

function sclone (config, next) {
    if (!next) {
        next = config;
        config = {};
    }
    helper.loadConfig(process?.env?.SCLONE_CONFIG ?? 'config.json', (err, config) => {
        if (err) {
            return helper.stop(err);
        }
        logger.setup(config);
        if (!config?.mode) {
            return helper.stop(new Error('config "mode" not defined on "config.json", accepted values: ' + helper.SUPPORTED_MODES.join(', ')));
        }
        if (helper.SUPPORTED_MODES.includes(config?.mode) === false) {
            return helper.stop(new Error('config "mode" not correct, accepted values: '+ helper.SUPPORTED_MODES.join(', ')));
        }
        if (!config?.source || !config?.target) {
            return helper.stop(new Error('config "source" and "target" storages must be defined on "config.json"'));
        }
        if (!config?.delete) {
            config.delete = false;
        }
        if (!config?.cacheFilename) {
            config.cacheFilename = helper.defaultCacheFilename(config);
        }
        if (!config.transfers) {
            config.transfers = 15;
        }
        if (!config.retry) {
            config.retry = 1;
        }
        if (config?.dryRun !== true) {
            config.dryRun = false;
        }
        if (process?.env?.SCLONE_CRON) {
            config.cron = process?.env?.SCLONE_CRON;
        }
        if (config?.cron && cron.validate(config?.cron) === false) {
            const _err = new Error("Cron expression not valid: " + config?.cron);
            logger.log('error', 'config_error', _err.message, { cron: config.cron });
            return next(_err);
        }
        /** One time execution: the run starts before the connection, a connection failure is a failed run */
        const _run = config.cron ? null : beginRun(config);
        const _onConnectionError = (err) => (_run !== null ? endRun(config, _run, err, next) : next(err));
        if (_run !== null) {
            try {
                _run.release = helper.acquireLock(helper.lockPath(config));
            } catch (err) {
                return endRun(config, _run, err, next);
            }
        }

        /** Connect storages */
        connectStorages(config, (err) => {
            if (err) {
                return _onConnectionError(err);
            }
            if (config.cron) {
                logger.log('info', 'cron_scheduled', 'Synchronisation scheduled', { cron: config.cron });
                /** X Time execution */
                const _task = cron.schedule(config.cron, () => {
                    if (alreadyRunning !== null) {
                        return logger.log('warn', 'sync_skipped', 'Previous synchronisation still running', { reason: 'already_running', running_since_ms: Date.now() - alreadyRunning });
                    }
                    let _release = null;
                    try {
                        _release = helper.acquireLock(helper.lockPath(config));
                    } catch (err) {
                        /** An error, so that the alerts fire: the lock cannot be taken, or its holder runs for longer than the stale delay */
                        const _heldMs = typeof err.holder?.start === 'number' ? Date.now() - err.holder.start : undefined;
                        const _level = err.code !== 'locked' || _heldMs > helper.LOCK_STALE_MS ? 'error' : 'warn';
                        return logger.log(_level, 'sync_skipped', 'Another process synchronises the same storages', { reason: err.code === 'locked' ? 'locked' : 'lock_error', pid: err.holder?.pid, held_ms: _heldMs, error: err.toString() });
                    }
                    const _cronRun = beginRun(config);
                    _cronRun.release = _release;
                    alreadyRunning = _cronRun.start;
                    startSync(config, _cronRun, (err) => {
                        alreadyRunning = null;
                        endRun(config, _cronRun, err, () => {});
                    });
                });
                return next(null, _task);
            }
            /** 1 time execution */
            startSync(config, _run, (err) => endRun(config, _run, err, next));
        });
    });
}

/**
 * Connect the source and the target in parallel (a slow authentication on each side is not waited twice). Once both are
 * done, the failures are logged in a fixed order (source, then target) and the source error is returned first
 */
function connectStorages (config, callback) {
    const _errors = {};
    let _pending = 2;
    const _done = (type) => (err) => {
        if (type in _errors) {
            return;
        }
        _errors[type] = err;
        if (--_pending > 0) {
            return;
        }
        for (const _type of ['source', 'target']) {
            if (_errors[_type]) {
                logger.log('error', 'storage_connect_failed', `${_type} storage connection failed`, { side: _type, storage: config[_type]?.name, bucket: config[_type]?.bucket, error: _errors[_type].toString() });
            }
        }
        return callback(_errors.source || _errors.target);
    };
    connect(config, 'source', _done('source'));
    connect(config, 'target', _done('target'));
}

/** Connect a storage, a configuration error (unsupported storage...) is returned instead of being thrown */
function connect (config, type, callback) {
    let _called = false;
    const _done = (err) => {
        _called = true;
        return callback(err);
    };
    try {
        storage.connection(config, type, _done);
    } catch (err) {
        /** Only a throw of the connection itself is caught, never one of the synchronisation called back */
        if (_called === true) {
            throw err;
        }
        return _done(err);
    }
}

/** Start a run: new run id, `sync_start` line. The stats are completed during the run and logged by `sync_end` */
function beginRun (config) {
    logger.startRun();
    logger.log('info', 'sync_start', 'Synchronisation started', {
        mode   : config.mode,
        source : `${config.source.name}:${config.source.bucket}`,
        target : `${config.target.name}:${config.target.bucket}`,
        delete : config.delete,
        dry_run: config.dryRun,
        cron   : !!config.cron
    });
    currentRun = { start: Date.now(), stats: { uploaded: 0, uploaded_bytes: 0, deleted: 0, failed: 0 } };
    return currentRun;
}

/** End a run with a single `sync_end` line: status, duration and stats. Enough for the dashboards */
function endRun (config, run, err, callback) {
    if (run.interrupted === true) {
        return;
    }
    currentRun = null;
    run.release?.();
    const _status = err ? 'failed' : (config.dryRun === true ? 'dry_run' : 'success');
    logger.log(err ? 'error' : 'info', 'sync_end', `Synchronisation ${_status}`, {
        status     : _status,
        duration_ms: Date.now() - run.start,
        ...run.stats,
        error      : err?.toString()
    });
    logger.endRun();
    return err ? callback(err) : callback();
}

/**
 * Stop signal (SIGTERM of `systemctl stop`, SIGINT): the run in progress ends with `sync_end status=interrupted` and its
 * lock is released, without saving the cache (the previous one is kept: written to a temporary file, then renamed).
 * Without a run in progress, a single `shutdown` line. The caller exits the process just after
 */
function interrupt (signal) {
    const _run = currentRun;
    if (_run === null) {
        return logger.log('info', 'shutdown', 'Stopped, no synchronisation in progress', { signal });
    }
    currentRun = null;
    _run.interrupted = true;
    _run.release?.();
    logger.log('warn', 'sync_end', 'Synchronisation interrupted', {
        status     : 'interrupted',
        duration_ms: Date.now() - _run.start,
        ..._run.stats,
        signal
    });
    logger.endRun();
}

function startSync(config, run, callback) {
  /** Listed objects by key, with the cache of their side (`cachedEtag`, `cachedBytes`) */
  const files = {
    target: new Map(),
    source: new Map()
  };
  const _cachePath = helper.resolveCachePath(config.cacheFilename);
  const _cacheHeader = helper.cacheHeader(config);
  storage.fetchListFiles(files, (err, listing) => {
    if (err) {
      return callback(err);
    }
    run.stats.source_objects = listing?.source?.objects;
    run.stats.target_objects = listing?.target?.objects;
    run.stats.source_bytes = listing?.source?.bytes;
    run.stats.target_bytes = listing?.target?.bytes;
    /** Loaded after the listings: the cache reuses their strings, and keeps the listed keys only */
    const _cacheStart = Date.now();
    helper.loadCache(_cachePath, _cacheHeader, files, (warning, migrated, entries) => {
      if (warning) {
        /** Non blocking: the run is a first synchronisation, nothing is deleted because of a missing entry */
        logger.log('warn', 'cache_error', 'Cache not loaded', { path: _cachePath, error: warning });
      } else {
        logger.log(migrated === true ? 'info' : 'debug', migrated === true ? 'cache_migrated' : 'cache_loaded', migrated === true ? 'Cache of version 1 migrated' : 'Cache loaded', { path: _cachePath, objects: entries, duration_ms: Date.now() - _cacheStart });
      }
      /** A cache of version 1 has no token for the keys listed on both sides: only a side listed empty is an empty side */
      const _emptySides = migrated === true ? { source: files.source.size === 0, target: files.target.size === 0 } : undefined;
      computeSync(config, files, _emptySides, (plan) => {
        if (config.dryRun === true) {
          return callback();
        }
        /** Errors of the run, joined into one Error */
        const _errors = [];
        const _end = () => callback(_errors.length > 0 ? new Error(_errors.join(' | ')) : undefined);
        /** Refused deletions are removed from the plan: the uploads still run, the run fails */
        const _refused = checkDeletions(config, plan);
        if (_refused !== null) {
          _errors.push(_refused.message);
        }
        storage.confirmDeletions(plan, config, (failed) => {
          if (failed > 0) {
            _errors.push(`Deletion not confirmed | ${failed} file(s) not deleted`);
          }
          /** A lock taken over by another process in between (race of three processes on a stale lock): nothing is changed */
          if (run.release?.isHeld?.() === false) {
            return callback(helper.lockLostError(helper.lockPath(config)));
          }
          run.stats.failed += failed;
          /** Synchronise storages based on lists returned by "computeSync". The run stats are updated live: logged if the run is interrupted */
          storage.syncFiles(plan.objectsToUploadTarget, plan.objectsToDeleteTarget, plan.objectsToUploadSource, plan.objectsToDeleteSource, config, function(err) {
            if (err) {
              _errors.push(err.toString());
            }
            /**
             * Not saved when a side is empty: its new files must not get a cache entry, the next runs keep refusing until the
             * side is restored or "allowEmptySide" is set. The transferred files are compared again, without transfer
             */
            if (_refused?.reasons.includes('empty_side') === true) {
              return _end();
            }
            /** Interrupted by a stop signal: the process exits, the previous cache is kept */
            if (run.interrupted === true) {
              return;
            }
            /** Saved even if some operations failed: the done ones are recorded, the failed ones keep their previous entry */
            logic.updateCache(files, plan);
            const _saveStart = Date.now();
            helper.saveCache(_cachePath, _cacheHeader, files, (saveErr, entries) => {
              if (saveErr) {
                _errors.push(saveErr.toString());
              } else {
                logger.log('debug', 'cache_saved', 'Cache saved', { path: _cachePath, objects: entries, duration_ms: Date.now() - _saveStart });
              }
              return _end();
            });
          }, run.stats);
        });
      });
    });
  });
}

/** Compute the plan, after resolving with a HEAD the opaque etags it needs (OVH encrypted objects): once per changed object */
function computeSync (config, files, emptySides, callback) {
  const _logSync = config?.logSync || config?.dryRun;
  const _plan = logic.computeSync(files, config.mode, config.delete, _logSync, { emptySides });
  if (_plan.objectsToResolve.length === 0) {
    return callback(_plan);
  }
  storage.resolveEtags(_plan.objectsToResolve, config, (stats) => {
    logger.log('debug', 'etag_resolved', 'Opaque etags resolved', stats);
    return callback(logic.computeSync(files, config.mode, config.delete, _logSync, { etagResolved: _plan.objectsToResolve.length, emptySides: _plan.emptySides }));
  });
}

/**
 * Guards before any deletion. The refused deletions are removed from the plan (they keep their cache: planned again by the
 * next run), the uploads still run, and an Error is returned so that the run fails (`deletion_refused`). Each guard is
 * checked and logged on its own:
 * - every deletion, if more than `maxDeletion` objects would be deleted on one side (`0` or unset: no limit),
 * - every deletion, if a side is empty while objects would be deleted on the other one: listed empty, or none of its listed
 *   objects was synchronised (emptied, then refilled with new files). An emptied bucket, a wrong bucket or a listing problem
 *   must not wipe the other side (`allowEmptySide: true` to accept it). Nothing is uploaded to the empty side and the cache is
 *   not saved: the side stays empty, so the next runs keep refusing instead of deleting the synced objects,
 * - the deletions of a side whose storage refuses them (`swift_versions_stack`: a DELETE restores the previous version).
 *
 * @returns {Error|null} with `reasons`, the list of the refusal reasons
 */
function checkDeletions (config, plan) {
    const _deletes = { target: plan.objectsToDeleteTarget.length, source: plan.objectsToDeleteSource.length };
    const _refusals = [];
    if (typeof config?.maxDeletion === 'number' && config.maxDeletion > 0 && (_deletes.target > config.maxDeletion || _deletes.source > config.maxDeletion)) {
        _refusals.push({ reason: 'max_deletion', sides: ['target', 'source'], message: `Too many element deleted | target: ${_deletes.target} / source ${_deletes.source} | Deletions refused, maxDeletion: ${config.maxDeletion}` });
    }
    const _empty = ['source', 'target'].find((side) => plan.emptySides?.[side] === true && _deletes[side === 'source' ? 'target' : 'source'] > 0);
    if (config?.allowEmptySide !== true && _empty !== undefined) {
        plan[_empty === 'target' ? 'objectsToUploadTarget' : 'objectsToUploadSource'] = [];
        _refusals.push({ reason: 'empty_side', sides: ['target', 'source'], empty: _empty, message: `Deletion refused: the ${_empty} storage is empty | target: ${_deletes.target} / source ${_deletes.source} | Set "allowEmptySide": true to allow it` });
    }
    if (_refusals.length === 0) {
        for (const _side of ['target', 'source']) {
            const _reason = storage.getDeletionRefusal(_side);
            if (_reason !== undefined && _deletes[_side] > 0) {
                _refusals.push({ reason: _reason, sides: [_side], message: `Deletion refused: the ${_side} storage restores the previous version of a deleted file (${_reason}) | ${_side}: ${_deletes[_side]}` });
            }
        }
    }
    if (_refusals.length === 0) {
        return null;
    }
    for (const { reason, sides, empty, message } of _refusals) {
        logger.log('error', 'deletion_refused', message, { reason, delete_target: _deletes.target, delete_source: _deletes.source, max_deletion: config?.maxDeletion, side: sides.length === 1 ? sides[0] : empty });
        for (const _side of sides) {
            plan[_side === 'target' ? 'objectsToDeleteTarget' : 'objectsToDeleteSource'] = [];
        }
    }
    return Object.assign(new Error(_refusals.map((refusal) => refusal.message).join(' | ')), { reasons: _refusals.map((refusal) => refusal.reason) });
}

module.exports = sclone;
module.exports.interrupt = interrupt;
