const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const path = require('path');
const logger = require('./logger');

const MODES = {
  UNI: "unidirectional",
  BI: "bidirectional"
};
const SUPPORTED_MODES = [MODES.UNI, MODES.BI];

function loadConfig(filenameOrAbsolutePath, callback) {
  let config = {};
  let configPath = '';
  if (fs.existsSync(filenameOrAbsolutePath)) {
    configPath = filenameOrAbsolutePath;
  } else {
    configPath = path.join(__dirname, filenameOrAbsolutePath);
  }
  let content = '';
  try {
    content = fs.readFileSync(configPath).toString();
  } catch(err) {
    return callback(new Error("config.json is required | " + err.toString()));
  }
  try {
    config = JSON.parse(content);
  } catch(err) {
    return callback(new Error(`config.json is not valid JSON | ${configPath} | ${err?.name ?? 'SyntaxError'}${jsonErrorLocation(err, content)}`));
  }
  return callback(null, config);
}

/**
 * Location of a JSON syntax error: never the message itself, it quotes part of the file (credentials)
 * @returns {String} " at line L column C", or "" when unknown
 */
function jsonErrorLocation(err, content) {
  const _message = String(err?.message);
  const _lineColumn = /\(line (\d+) column (\d+)\)/.exec(_message);
  if (_lineColumn !== null) {
    return ` at line ${_lineColumn[1]} column ${_lineColumn[2]}`;
  }
  const _position = /position (\d+)/.exec(_message);
  if (_position !== null) {
    const _before = content.slice(0, Number(_position[1])).split('\n');
    return ` at line ${_before.length} column ${_before[_before.length - 1].length + 1}`;
  }
  return '';
}

/**
 * The process is not killed with `process.exit()`: pending asynchronous writes, such as the
 * error files of the last retry created by cqueue, would be lost.
 */
function stop(msg) {
  logger.log('error', 'config_error', msg?.toString());
  process.exitCode = 1;
}

/**
 * Resolve the cache file location:
 * - absolute paths are used as-is
 * - relative paths are resolved against the current working directory
 * - backward compatibility: if no cache exists in the working directory but one exists next to
 *   the source code (where versions <= 1.1.0 stored it), the legacy location keeps being used
 * New caches are not resolved against `__dirname`: inside a packaged binary (pkg), it points
 * to the read-only snapshot filesystem and the cache could never be written.
 */
function resolveCachePath(cacheFilename) {
  if (path.isAbsolute(cacheFilename) === true) {
    return cacheFilename;
  }
  const _cachePath = path.join(process.cwd(), cacheFilename);
  const _legacyCachePath = path.join(__dirname, cacheFilename);
  if (fs.existsSync(_cachePath) === false && fs.existsSync(_legacyCachePath) === true) {
    return _legacyCachePath;
  }
  return _cachePath;
}

/** Version of the cache file. v1 (<= 1.4.0, bidirectional only): `[[key, { md5, lastmodified, bytes }], ...]` */
const CACHE_VERSION = 2;

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);

/**
 * Identity of a storage in the cache header: `<type>:<endpoint>[:<region>]/<bucket>@<account>`. The S3 client adds "https://"
 * and removes the final "/" of the url on connection: the endpoint is normalised the same way before and after.
 * `<account>` is a hash of a non-secret identity of the account, never of a secret: the access key id (S3), the username and
 * project (Swift). The same bucket name of two accounts (Swift projects, S3 tenants) is not the same bucket.
 */
function storageId (storage) {
  const _endpoint = String(storage?.url ?? storage?.authUrl ?? '').replace(/^https:\/\//, '').replace(/\/+$/, '');
  const _account = storage?.name === 'swift' ? `${storage?.username ?? ''}\n${storage?.tenantName ?? storage?.projectId ?? ''}` : String(storage?.accessKeyId ?? '');
  return `${storage?.name}:${_endpoint}${storage?.region ? ':' + storage.region : ''}/${storage?.bucket}@${sha256(_account)}`;
}

/** Header of the cache file: a cache written for another pair of storages or another mode is never used */
function cacheHeader (config) {
  return { version: CACHE_VERSION, mode: config.mode, source: storageId(config.source), target: storageId(config.target) };
}

/** Default cache file name, distinct for each pair of storages: several instances can share a working directory */
function defaultCacheFilename (config) {
  const _header = cacheHeader(config);
  return `sclone-${config.mode}-${sha256(_header.source + '\n' + _header.target)}.cache.json`;
}

/**
 * Lock file of a pair of storages, in the directory of the cache: derived from the pair only (not from the mode, the
 * direction or the cache name), so every configuration synchronising the same two storages excludes the others.
 */
function lockPath (config) {
  const _pair = [storageId(config.source), storageId(config.target)].sort().join('\n');
  return path.join(path.dirname(resolveCachePath(config.cacheFilename)), `sclone-${sha256(_pair)}.lock`);
}

/** Size of the chunks of the cache file read, and number of lines written at once: the event loop is never blocked for long */
const CACHE_CHUNK_BYTES = 1024 * 1024;
const CACHE_CHUNK_LINES = 5000;

function isToken (etag, bytes) {
  return (typeof etag === 'string' || etag === null) && (typeof bytes === 'number' || bytes === null);
}

/**
 * Set the cached token of each listed side of a key (`cachedEtag`, `cachedBytes` of the listed objects): the cache costs no
 * other structure, and the strings of the listing are reused when equal. A key absent from both sides is ignored: deleted
 * everywhere, its entry is useless. Returns 0 (ignored), 1 (loaded) or -1 (invalid entry).
 */
function setCacheEntry (files, key, sourceEtag, sourceBytes, targetEtag, targetBytes) {
  if (typeof key !== 'string' || isToken(sourceEtag, sourceBytes) === false || isToken(targetEtag, targetBytes) === false) {
    return -1;
  }
  const _source = files.source.get(key);
  const _target = files.target.get(key);
  if (_source !== undefined) {
    _source.cachedEtag = sourceEtag === _source.md5 ? _source.md5 : sourceEtag;
    _source.cachedBytes = sourceBytes;
  }
  if (_target !== undefined) {
    _target.cachedEtag = targetEtag === _target.md5 ? _target.md5 : targetEtag;
    _target.cachedBytes = targetBytes;
  }
  return _source === undefined && _target === undefined ? 0 : 1;
}

/** A string which can be an object key: well-formed UTF-16 (sent in a URL), 1024 bytes in UTF-8 at most (S3 limit) */
const isKey = (key) => typeof key === 'string' && key.isWellFormed() === true && Buffer.byteLength(key) <= 1024;

/** Largest header line read for the bounds of the listings: 2 × 63 keys of 1024 bytes, escaped */
const CACHE_HEADER_MAX_CHARS = 4 * 1024 * 1024;

/**
 * Bounds of the previous listings, recorded in the header of the cache (`listing`: { source, target } { objects, bounds }),
 * read before the listings: only the header line is read. Never fails: undefined if missing, invalid or written for another
 * synchronisation. Bounds only balance the key ranges listed in parallel: any keys are safe. A side with a bound that cannot be
 * a key (lone surrogate, over 1024 bytes in UTF-8: the S3 limit) is listed sequentially.
 */
function readCacheListing (cachePath, header, callback) {
  const _stream = fs.createReadStream(cachePath, { encoding: 'utf8', highWaterMark: 64 * 1024 });
  let _text = '';
  let _done = false;
  const _end = (listing) => {
    if (_done === false) {
      _done = true;
      _stream.destroy();
      return callback(listing);
    }
  };
  _stream.on('error', () => _end());
  _stream.on('end', () => _end());
  _stream.on('data', (chunk) => {
    _text += chunk;
    const _newLine = _text.indexOf('\n');
    if (_newLine === -1) {
      return _text.length > CACHE_HEADER_MAX_CHARS ? _end() : undefined;
    }
    let _header = null;
    try {
      _header = JSON.parse(_text.slice(0, _newLine));
    } catch (_err) {
      return _end();
    }
    if (_header?.version !== CACHE_VERSION || _header.mode !== header.mode || _header.source !== header.source || _header.target !== header.target) {
      return _end();
    }
    const _listing = {};
    for (const _side of ['source', 'target']) {
      const { objects, bounds } = _header.listing?.[_side] ?? {};
      if (Number.isSafeInteger(objects) === true && Array.isArray(bounds) === true && bounds.length < 64 && bounds.every(isKey) === true) {
        _listing[_side] = { objects, bounds };
      }
    }
    return _end(_listing);
  });
}

/** Remove the cache of every listed object: a cache found invalid while loading is ignored as a whole */
function clearCache (files) {
  for (const _listing of [files.source, files.target]) {
    for (const _object of _listing.values()) {
      _object.cachedEtag = undefined;
      _object.cachedBytes = undefined;
    }
  }
}

/**
 * Load the cache of the pair onto the listed objects (`cachedEtag`, `cachedBytes`: the token of their side after the last
 * synchronisation), after the listings. Never fails: a missing, corrupted or foreign cache is ignored as a whole and the run
 * is a first synchronisation (nothing is deleted because of a missing entry).
 *
 * File format (v2): a JSON header line, then one JSON line per object `[key, sourceEtag, sourceBytes, targetEtag, targetBytes]`.
 * The file is streamed by chunks of CACHE_CHUNK_BYTES: never read as a whole, the event loop is never blocked for long.
 *
 * @param {Object} files { source: Map, target: Map } listed objects by key
 * @param {Function} callback (warning, migrated, entries) warning: why an existing cache is ignored (undefined if loaded or missing)
 */
function loadCache (cachePath, header, files, callback) {
  removeStaleTmpFiles(cachePath);
  const _stream = fs.createReadStream(cachePath, { encoding: 'utf8', highWaterMark: CACHE_CHUNK_BYTES });
  let _entries = 0;
  let _header = null;
  let _rest = '';
  let _v1 = null;
  let _done = false;
  const _end = (warning, migrated) => {
    if (_done === true) {
      return;
    }
    _done = true;
    _stream.destroy();
    if (warning !== undefined) {
      clearCache(files);
    }
    return callback(warning, migrated, warning === undefined ? _entries : 0);
  };
  const _add = (key, sourceEtag, sourceBytes, targetEtag, targetBytes) => {
    const _result = setCacheEntry(files, key, sourceEtag, sourceBytes, targetEtag, targetBytes);
    _entries += _result === 1 ? 1 : 0;
    return _result !== -1;
  };
  /** Complete lines only. A JSON string never contains a raw new line: the lines are the items of one JSON array */
  const _parseLines = (text) => {
    if (_header === null) {
      const _newLine = text.indexOf('\n');
      try {
        _header = JSON.parse(_newLine === -1 ? text : text.slice(0, _newLine));
      } catch (err) {
        return _end('Cache corrupted | ' + err.toString());
      }
      if (_header?.version !== CACHE_VERSION || _header.mode !== header.mode || _header.source !== header.source || _header.target !== header.target) {
        return _end(`Cache ignored: written for another synchronisation | mode: ${_header?.mode} | source: ${_header?.source} | target: ${_header?.target}`);
      }
      text = _newLine === -1 ? '' : text.slice(_newLine + 1);
    }
    if (text === '') {
      return;
    }
    let _lines = null;
    try {
      _lines = JSON.parse('[' + text.replaceAll('\n', ',') + ']');
    } catch (err) {
      return _end('Cache corrupted | ' + err.toString());
    }
    for (let i = 0; i < _lines.length; i++) {
      const _line = _lines[i];
      if (Array.isArray(_line) === false || _line.length !== 5 || _add(_line[0], _line[1], _line[2], _line[3], _line[4]) === false) {
        return _end('Cache corrupted: invalid entry ' + JSON.stringify(_line)?.slice(0, 200));
      }
    }
  };
  _stream.on('error', (err) => _end(err.code === 'ENOENT' ? undefined : 'Read cache error | ' + err.toString()));
  _stream.on('data', (chunk) => {
    /** v1 (bidirectional): one JSON array `[[key, { md5, bytes, ... }], ...]`, read as a whole */
    if (_v1 !== null || (_header === null && _rest === '' && chunk[0] === '[')) {
      return (_v1 ??= []).push(chunk);
    }
    const _text = _rest + chunk;
    const _lastNewLine = _text.lastIndexOf('\n');
    _rest = _text.slice(_lastNewLine + 1);
    if (_lastNewLine !== -1) {
      _parseLines(_text.slice(0, _lastNewLine));
    }
  });
  _stream.on('end', () => {
    if (_v1 !== null) {
      return _end(...migrateV1(files, header, _v1.join(''), _add));
    }
    /** A complete file ends with a new line: a truncated cache is never used */
    if (_header === null || _rest !== '') {
      return _end('Cache corrupted: the file is truncated');
    }
    return _end(undefined, false);
  });
}

/**
 * Cache of sclone 1.x (bidirectional): `[[key, { md5, bytes, ... }], ...]`. Its token is the one of the last copy, not of
 * each side (the etag of a multipart original, not of its plain copy...): it is kept only for the keys listed on one side,
 * where it tells a deletion from a new file. A key listed on both sides is compared as on a first synchronisation (the
 * multipart rule included): at worst a redundant transfer or a conflict won by the most recent version, never a deletion.
 * @returns {Array} [warning, migrated]
 */
function migrateV1 (files, header, text, add) {
  if (header.mode !== MODES.BI) {
    return ['Cache of version 1 ignored: it was written by the bidirectional mode'];
  }
  let _v1 = null;
  try {
    _v1 = JSON.parse(text);
  } catch (err) {
    return ['Cache corrupted | ' + err.toString()];
  }
  for (let i = 0; i < _v1.length; i++) {
    const _md5 = _v1[i]?.[1]?.md5;
    const _bytes = _v1[i]?.[1]?.bytes ?? null;
    const _key = _v1[i]?.[0];
    if (typeof _md5 !== 'string' || typeof _key !== 'string') {
      return ['Cache of version 1 corrupted: entry ' + i];
    }
    if ((files.source.has(_key) === true && files.target.has(_key) === true) === false && add(_key, _md5, _bytes, _md5, _bytes) === false) {
      return ['Cache of version 1 corrupted: entry ' + i];
    }
  }
  return [undefined, true];
}

/** Temporary cache files left by a crash (`<cache>.<pid>.tmp`) older than an hour are removed. Best effort, never fails */
const CACHE_TMP_MAX_AGE_MS = 3600000;
function removeStaleTmpFiles (cachePath) {
  const _dir = path.dirname(cachePath);
  const _prefix = path.basename(cachePath) + '.';
  fs.readdir(_dir, (err, names) => {
    for (const _name of (err ? [] : names)) {
      if (_name.startsWith(_prefix) === true && _name.endsWith('.tmp') === true) {
        const _path = path.join(_dir, _name);
        fs.stat(_path, (err, stat) => (err || Date.now() - stat.mtimeMs <= CACHE_TMP_MAX_AGE_MS ? null : fs.rm(_path, { force: true }, () => {})));
      }
    }
  });
}

/** Flush a rename to the disk: fsync of the directory. Best effort: not supported on every platform (Windows) */
function fsyncDir (dir, callback) {
  fs.open(dir, 'r', (err, fd) => (err ? callback() : fs.fsync(fd, () => fs.close(fd, () => callback()))));
}

const cacheToken = (value) => (value === null || value === undefined ? 'null' : JSON.stringify(value));

/** Line of the cache file of a key, '' if the key has no cache */
function cacheLine (key, source, target) {
  if (source?.cachedEtag === undefined && target?.cachedEtag === undefined) {
    return '';
  }
  return '[' + JSON.stringify(key) + ',' + cacheToken(source?.cachedEtag) + ',' + cacheToken(source?.cachedBytes) + ',' + cacheToken(target?.cachedEtag) + ',' + cacheToken(target?.cachedBytes) + ']\n';
}

/**
 * Save the cache of the listed objects atomically, by chunks of CACHE_CHUNK_LINES objects: written to a temporary file of
 * the same directory, flushed to the disk, then renamed. A crash or a full disk never leaves a truncated cache.
 *
 * @param {Object} files { source: Map, target: Map }
 * @param {Function} callback (err, entries)
 */
function saveCache (cachePath, header, files, callback) {
  const _tmpPath = `${cachePath}.${process.pid}.tmp`;
  const _sources = files.source.entries();
  const _targets = files.target.entries();
  let _entries = 0;
  /** Next line: the source keys, then the target-only keys. null at the end */
  const _nextLine = () => {
    for (let _next = _sources.next(); _next.done === false; _next = _sources.next()) {
      const _line = cacheLine(_next.value[0], _next.value[1], files.target.get(_next.value[0]));
      if (_line !== '') {
        return _line;
      }
    }
    for (let _next = _targets.next(); _next.done === false; _next = _targets.next()) {
      const _line = files.source.has(_next.value[0]) === true ? '' : cacheLine(_next.value[0], undefined, _next.value[1]);
      if (_line !== '') {
        return _line;
      }
    }
    return null;
  };
  fs.open(_tmpPath, 'w', function (err, fd) {
    if (err) {
      return callback('Save cache error | ' + err.toString());
    }
    const _end = (err) => fs.fsync(fd, function (errSync) {
      fs.close(fd, function (errClose) {
        const _err = err || errSync || errClose;
        if (_err) {
          return fs.rm(_tmpPath, { force: true }, () => callback('Save cache error | ' + _err.toString()));
        }
        fs.rename(_tmpPath, cachePath, function (err) {
          if (err) {
            return fs.rm(_tmpPath, { force: true }, () => callback('Save cache error | ' + err.toString()));
          }
          return fsyncDir(path.dirname(cachePath), () => callback(undefined, _entries));
        });
      });
    });
    let _chunk = JSON.stringify(header) + '\n';
    const _writeChunk = function (err) {
      if (err) {
        return _end(err);
      }
      for (let i = 0; i < CACHE_CHUNK_LINES; i++) {
        const _line = _nextLine();
        if (_line === null) {
          return _chunk === '' ? _end() : fs.writeFile(fd, _chunk, (err) => _end(err));
        }
        _chunk += _line;
        _entries++;
      }
      const _data = _chunk;
      _chunk = '';
      return fs.writeFile(fd, _data, _writeChunk);
    };
    return _writeChunk();
  });
}

/** Lock refreshed by its holder every 30 s (mtime): a lock not refreshed for 10 minutes is stale, whatever its host */
const LOCK_REFRESH_MS = 30000;
const LOCK_STALE_MS = 10 * 60000;
/** An unreadable lock is being written, unless it is older than a minute */
const LOCK_WRITE_MS = 60000;
/** Start of this process: a lock with our pid written before it was left by a previous process (PID 1 in a container) */
const PROCESS_START = Date.now() - process.uptime() * 1000;

/** Lock file: `{ raw, holder, mtimeMs }`, holder null if unreadable, raw undefined if there is no lock */
function readLock (file) {
  try {
    const _mtimeMs = fs.statSync(file).mtimeMs;
    const _raw = fs.readFileSync(file, 'utf8');
    let _holder = null;
    try {
      _holder = JSON.parse(_raw);
    } catch (_err) {
      /** Being written */
    }
    return { raw: _raw, holder: _holder, mtimeMs: _mtimeMs };
  } catch (_err) {
    return { raw: undefined, holder: null, mtimeMs: 0 };
  }
}

/**
 * A lock is held by a living process if it was refreshed recently and:
 * - it is being written (unreadable and younger than a minute),
 * - or its holder runs on another host (only the refresh tells),
 * - or its holder has our pid: alive only if the lock was written by this process (PID 1 of a restarted container),
 * - or it was refreshed less than 3 refreshes ago: a pid of another PID namespace with the same hostname (container with
 *   the host network or a fixed hostname) cannot be checked,
 * - or its holder pid is alive on this host.
 * A lock without hostname is a lock of this host.
 */
function isLockAlive ({ holder, mtimeMs }) {
  const _age = Date.now() - mtimeMs;
  if (_age > LOCK_STALE_MS) {
    return false;
  }
  if (holder === null || typeof holder !== 'object') {
    return _age < LOCK_WRITE_MS;
  }
  if (holder.hostname !== undefined && holder.hostname !== os.hostname()) {
    return true;
  }
  if (Number.isInteger(holder.pid) === false || holder.pid <= 0) {
    return false;
  }
  if (holder.pid === process.pid) {
    return typeof holder.start === 'number' && holder.start >= PROCESS_START;
  }
  if (_age < 3 * LOCK_REFRESH_MS) {
    return true;
  }
  try {
    process.kill(holder.pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * Remove a stale lock atomically: renamed to a unique name, then removed only if it is still the stale lock read (same
 * content and mtime). If another process took it over in between, its fresh lock is put back (link: never over a lock).
 * @returns {Boolean} true if the stale lock was removed (or already gone)
 */
function removeStaleLock (file, stale) {
  const _moved = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.stale`;
  try {
    fs.renameSync(file, _moved);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return true;
    }
    throw err;
  }
  const _taken = readLock(_moved);
  const _isStale = _taken.raw === stale.raw && _taken.mtimeMs === stale.mtimeMs;
  if (_isStale === false) {
    try {
      fs.linkSync(_moved, file);
    } catch (_err) {
      /** A third process created a lock in between: it holds the lock */
    }
  }
  fs.rmSync(_moved, { force: true });
  return _isStale;
}

/**
 * Prevent two processes from synchronising the same pair at the same time: lock file created exclusively (O_EXCL), with
 * the pid, hostname and start time of the holder, and refreshed every 30 s while held. A stale lock is taken over.
 *
 * @returns {Function} release function
 * @throws {Error} `locked` (with `holder`) if another process holds the lock
 */
function acquireLock (file) {
  const _content = JSON.stringify({ pid: process.pid, hostname: os.hostname(), start: Date.now() });
  for (let i = 0; i < 3; i++) {
    try {
      fs.writeFileSync(file, _content, { flag: 'wx' });
      return holdLock(file, _content);
    } catch (err) {
      if (err.code !== 'EEXIST') {
        throw err;
      }
    }
    const _lock = readLock(file);
    if (_lock.raw !== undefined) {
      if (isLockAlive(_lock) === true) {
        throw lockedError(file, _lock.holder);
      }
      if (removeStaleLock(file, _lock) === true) {
        logger.log('warn', 'lock_stale', 'Stale lock taken over', { path: file, pid: _lock.holder?.pid, hostname: _lock.holder?.hostname, since: _lock.holder?.start ? new Date(_lock.holder.start).toISOString() : undefined });
      }
    }
  }
  throw lockedError(file, readLock(file).holder);
}

/** Refresh the lock while it is held (unref'd timer: never keeps the process alive), and return its release function */
function holdLock (file, content) {
  const _isOwn = () => {
    try {
      return fs.readFileSync(file, 'utf8') === content;
    } catch (_err) {
      return false;
    }
  };
  const _timer = setInterval(() => {
    try {
      if (_isOwn() === true) {
        const _now = new Date();
        fs.utimesSync(file, _now, _now);
      }
    } catch (_err) {
      /** Retried by the next refresh */
    }
  }, LOCK_REFRESH_MS);
  _timer.unref();
  const release = function () {
    clearInterval(_timer);
    try {
      if (_isOwn() === true) {
        fs.unlinkSync(file);
      }
    } catch (_err) {
      /** Already removed */
    }
  };
  /** Checked before the first change of a run: false if another process replaced the lock */
  release.isHeld = _isOwn;
  return release;
}

function lockLostError (file) {
  const _err = new Error(`Lock lost: another sclone process took over the lock, nothing was changed | lock: ${file}`);
  _err.code = 'locked';
  return _err;
}

function lockedError (file, holder) {
  const _err = new Error(`Another sclone process synchronises the same storages | pid: ${holder?.pid}${holder?.hostname ? ' | host: ' + holder.hostname : ''} | lock: ${file}`);
  _err.code = 'locked';
  _err.holder = holder;
  return _err;
}

module.exports = {
  loadConfig,
  stop,
  resolveCachePath,
  cacheHeader,
  defaultCacheFilename,
  lockPath,
  loadCache,
  readCacheListing,
  saveCache,
  acquireLock,
  lockLostError,
  LOCK_STALE_MS,
  setCacheEntry,
  MODES,
  SUPPORTED_MODES
};