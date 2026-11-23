const storageClient = require("tiny-storage-client");
const cqueue = require('@carboneio/cqueue');
const { execQueue } = cqueue;
const crypto = require('crypto');
const { isUtf8 } = require('buffer');
const helper = require("./helper");
const logger = require("./logger");
const { isMultipartEtag, isMd5 } = require("./logic");


const SWIFT = 'swift';
const S3 = 's3';
const SUPPORTED_STORAGES = [S3, SWIFT];
const storages = {
  target: {
    name  : '',
    bucket: ''
  },
  source: {
    name  : '',
    bucket: ''
  }
};

let integrityCheck = false;
let logQueueStatus = false;
/** Number of retries of a listing page, and delay before the first retry, doubled on each retry: 1s, 2s, 4s, 8s, 16s */
let listRetry = 5;
let listRetryDelay = 1000;
/** Key ranges of a side listed in parallel (`listingConcurrency`), and its maximum */
const LISTING_CONCURRENCY = 4;
const MAX_LISTING_CONCURRENCY = 64;
let listingConcurrency = LISTING_CONCURRENCY;
/** Parts of a listing whose bounds are recorded in the cache: the bounds of N ranges are picked among them */
const LISTING_PARTS = 64;
/** A range must hold at least this number of pages, otherwise the listing uses fewer ranges, or one */
const MIN_PAGES_PER_RANGE = 2;
/** Options of every queue (cqueue >= 1.1.0, ignored by older versions): no error file by default, the logs already carry the causes */
let queueOptions = {};
/** Internal queue: its start/end are covered by the `listing_done` events */
const LIST_QUEUE = 'list-files-source-target';
/** Largest object accepted by a single upload: 5 GiB (S3 PUT, and default limit of a Swift object) */
const MAX_PUT_BYTES = 5 * 1024 ** 3;
/** HTTP statuses which do not change by retrying a transfer: bad request (SSE-C object...), access denied or archived object, too large. 404 on download only: the object was deleted after the listing */
const PERMANENT_STATUSES = new Set([400, 403, 413]);

/**
 * cqueue logs are routed to the structured logger: its fields (event, queue, try, errors, duration_ms...)
 * are kept as-is. The start and end of an empty or internal queue are debug: a run without changes
 * must stay a few lines long.
 */
cqueue.setLogFunction(function (message, level, fields) {
  const { event, ..._fields } = fields ?? {};
  if ((event === 'queue_start' || event === 'queue_end') && (_fields.total === 0 || _fields.queue === LIST_QUEUE)) {
    level = 'debug';
  }
  logger.log(level, event ?? 'queue_log', message, _fields);
});
const getStorageName = (auth) => {
  if (!auth?.name) {
    throw new Error('Config "name" not defined on "config.json", accepted values: '+ SUPPORTED_STORAGES.toString());
  }
  if (SUPPORTED_STORAGES.includes(auth?.name) === false) {
    throw new Error(`Storage ${auth.name} not supported, accepted values: `+ SUPPORTED_STORAGES.toString());
  }
  return auth.name;
};

function connection (config, type, callback) {
  storages[type] = {
    ...storages[type],
    ...storageClient(config[type]),
    name  : getStorageName(config[type]),
    bucket: config[type].bucket,
    side  : type,
    /** Reason why the deletions are refused on this storage, set on connection */
    deletionRefusal: undefined
  };
  storages[type].setTimeout(240000);
  /**
   * Levels of tiny-storage-client: info, warning, error. Its third argument (`fields`, with an `event`) is not used yet:
   * its event names, such as `storage_connected`, would collide with the sclone events of the dashboards
   */
  storages[type].setLogFunction((message, level) => {
    logger.log(level === 'warning' ? 'warn' : level === 'error' ? 'error' : 'info', 'storage_client', message, { side: type, storage: storages[type].name });
  });

  integrityCheck = config?.integrityCheck === true;
  listRetry = config?.listRetry ?? 5;
  listRetryDelay = config?.listRetryDelay ?? 1000;
  listingConcurrency = Number.isInteger(config?.listingConcurrency) ? Math.min(Math.max(config.listingConcurrency, 1), MAX_LISTING_CONCURRENCY) : LISTING_CONCURRENCY;
  if (config?.test === true) {
    logQueueStatus = false;
  }
  queueOptions = {
    errorFile       : config?.errorFile ?? false,
    logRetentionDays: config?.logRetentionDays ?? 7,
    retryDelay      : config?.retryDelay ?? 1000
  };

  if (storages[type].name === SWIFT) {
    return storages[type].connection((err) => {
      if (err) {
        return callback(`[SWIFT ${type}] Connexion error | ` + err.toString());
      }
      if (config?.delete !== true) {
        logStorageConnected(type);
        return callback();
      }
      return checkSwiftVersioning(type, callback);
    });
  } else if (storages[type].name === S3) {
    /**
     * One key of the configured bucket: checks the credentials and the bucket, without the ListAllMyBuckets permission (credentials scoped to a bucket).
     * Retried like a listing page: a temporary error (network, 5xx, 429, proxy page) does not fail the run, a 403 or a 404 fails at once
     */
    return requestListPage(storages[type], storages[type].bucket, (done) => storages[type].listFiles(storages[type].bucket, { queries: { 'max-keys': 1 } }, (err, resp) => {
      if (err) {
        return done(`[S3 ${type}] Error: ` + err?.toString());
      }
      if (resp?.statusCode !== 200) {
        /** Only the status and the error code/message: a SignatureDoesNotMatch body carries the access key id and the string to sign */
        return done(`[S3 ${type}] Storage error | Status ${resp?.statusCode} | Code: ${resp?.body?.error?.code ?? 'unknown'} | Message: ${resp?.body?.error?.message ?? 'unknown'}`, isPermanentListingStatus(resp?.statusCode));
      }
      return done(null);
    }), (err) => {
      if (err) {
        return callback(err);
      }
      logStorageConnected(type);
      return callback();
    }, 'connect');
  } else {
    return callback(`Storage "${type}" missing a storage "name" on the "config.json"`);
  }
}

/**
 * A Swift container with "X-Versions-Location" (versioning in "stack" mode) restores the previous version of an object on
 * DELETE: a deletion would bring back an old file. The deletions are refused on this side (`deletion_refused`), the uploads
 * still run. "X-History-Location" (history mode) keeps the deletions: accepted.
 */
function checkSwiftVersioning (type, callback) {
  storages[type].headBucket(storages[type].bucket, (err, resp) => {
    if (err) {
      return callback(`[SWIFT ${type}] Container check error | ` + err.toString());
    }
    if ((resp?.statusCode >= 200 && resp?.statusCode < 300) === false) {
      return callback(`[SWIFT ${type}] Container check error | Status ${resp?.statusCode} | Container: ${storages[type].bucket}`);
    }
    const _versionsLocation = resp?.headers?.['x-versions-location'];
    if (typeof _versionsLocation === 'string' && _versionsLocation !== '') {
      storages[type].deletionRefusal = 'swift_versions_stack';
      logger.log('error', 'swift_versions_stack', `Deletions disabled on the ${type} container: "X-Versions-Location" is set, a deletion would restore the previous version of the file. Use "X-History-Location" instead, or disable "delete"`, {
        side: type, storage: SWIFT, bucket: storages[type].bucket, versions_location: _versionsLocation
      });
    }
    logStorageConnected(type);
    return callback();
  });
}

/** Reason why the deletions are refused on a side (`swift_versions_stack`), undefined if allowed */
function getDeletionRefusal (side) {
  return storages[side]?.deletionRefusal;
}

function logStorageConnected (type) {
  logger.log('info', 'storage_connected', `${type} storage connected`, { side: type, storage: storages[type].name, bucket: storages[type].bucket });
}

/**
 * Error of a storage operation: the HTTP status is kept for the logs, and toString() returns the
 * message unchanged (it is written into the queue errors)
 */
function storageError (message, status, code) {
  const _err = new Error(message);
  _err.status = status;
  _err.code = code;
  _err.toString = () => message;
  return _err;
}

/** Wrap an error returned by tiny-storage-client: same message as before, its HTTP status (`storageStatusCode`, tiny-storage-client >= 3.7.0) and network code are kept */
function clientError (prefix, err) {
  return storageError(prefix + err.toString(), err?.storageStatusCode, err?.code);
}

/** Errors which do not change by retrying: redirect (wrong region or endpoint), access denied, bucket not found... 408, 429 and 498 (SWIFT rate limit) are temporary */
function isPermanentListingStatus (statusCode) {
  return statusCode >= 300 && statusCode < 500 && [408, 429, 498].includes(statusCode) === false;
}

/**
 * Request a listing page, and request it again on a temporary error (network, 5xx, page cut...).
 * A failed page no longer fails the whole listing: on large buckets, the listing of hundreds of pages
 * was lost on a single error, and the whole synchronisation with it.
 *
 * @param {Function} requestPage (done) => {}, with done(err, isPermanent)
 * @param {String} [op] `connect` for the connection check, logged by `listing_retry`
 */
function requestListPage (storage, container, requestPage, callback, op, retry = 0) {
  requestPage(function (err, isPermanent) {
    if (err && isPermanent !== true && retry < listRetry) {
      const _delay = listRetryDelay * 2 ** retry;
      logger.log('warn', 'listing_retry', `${op === 'connect' ? 'Connection check' : 'Listing page'} failed, retry ${retry + 1}/${listRetry}`, {
        side: storage?.side, storage: storage?.name, bucket: container, ...(op && { op }), retry: retry + 1, max_retry: listRetry, delay_ms: _delay, error: err.toString()
      });
      return setTimeout(() => requestListPage(storage, container, requestPage, callback, op, retry + 1), _delay);
    }
    return callback(err);
  });
}

/**
 * List the files of a container, page by page. Each page is checked, then given to `options.onPage(list)` before the next
 * one is requested: the pages are not kept in memory until the end. A page is given once, after its successful request
 * (a retried page is requested again before). `onPage` returns an Error to stop the listing, not retried, or `true` to end
 * it after this page (key range read).
 */
const listFiles = {
  [S3]: function(storage, container, options, callback) {
    /** List files options */
    options.queries = options?.queries ?? {};
    options.autoPaging = options?.autoPaging ?? false;
    let _isTruncated = false;
    requestListPage(storage, container, function (done) {
      storage.listFiles(container, options, function (err, resp) {
        if (err) {
          return done(err);
        }
        if (resp?.statusCode !== 200) {
          return done(new Error(`Status: ${resp?.statusCode} | Body: ${ resp?.body?.error?.code ?? resp?.body?.toString()} | Bucket: ${container}` ), isPermanentListingStatus(resp?.statusCode));
        }
        /**
         * An incomplete page read as a complete one makes files disappear from the listing: with "delete",
         * they are deleted from the other storage. Every page is checked before being used.
         */
        const _listResult = resp?.body?.contents ?? [];
        if (typeof resp?.body?.istruncated !== 'boolean') {
          return done(new Error(`Invalid listing: "IsTruncated" not found | Bucket: ${container}`));
        }
        if (typeof resp.body.keycount === 'number' && resp.body.keycount !== _listResult.length) {
          return done(new Error(`Invalid listing: ${_listResult.length} file(s) read but "KeyCount" is ${resp.body.keycount} | Bucket: ${container}`));
        }
        _isTruncated = resp.body.istruncated;
        if (options.autoPaging === true && _isTruncated === true) {
          const _lastKey = _listResult[_listResult.length - 1]?.key;
          if (_lastKey === undefined || _lastKey === options.queries['start-after']) {
            return done(new Error(`Invalid listing: the page is truncated but does not list any new file | Bucket: ${container}`));
          }
          /** A copy: a parsed key is a slice of the XML page, it would keep the whole page in memory until the next one */
          options.queries['start-after'] = copyString(_lastKey);
        }
        /** A page refused by `onPage` is not retried */
        const _result = options.onPage(_listResult);
        _isTruncated = _isTruncated === true && _result !== true;
        return done(_result === true ? null : _result, true);
      });
    }, function (err) {
      if (err) {
        return callback(err);
      }
      if (options.autoPaging === true && _isTruncated === true) {
        return listFiles[S3](storage, container, options, callback);
      }
      return callback(null);
    });
  },
  [SWIFT]: function (storage, container, options, callback) {
    /** List files options */
    options.queries = options?.queries ?? {};
    options.queries.limit = options?.queries?.limit ?? 10000;
    options.autoPaging = options?.autoPaging ?? false;
    let _hasNextPage = false;
    requestListPage(storage, container, function (done) {
      storage.listFiles(container, options, function (err, resp) {
        if (err) {
          return done(err);
        }
        /** 204: empty container. Anything else than a JSON list (error page, HTML, ...) must not be read as files */
        const _listResult = resp?.statusCode === 204 ? [] : resp?.body;
        if ((resp?.statusCode !== 200 && resp?.statusCode !== 204) || Array.isArray(_listResult) === false) {
          return done(new Error(`Invalid listing: a JSON list is expected | Status: ${resp?.statusCode} | Container: ${container}`), isPermanentListingStatus(resp?.statusCode));
        }
        /**
         * Only an empty page ends the listing: some servers cap the page below the requested limit, and the object count of
         * the container can be stale. One more request per listing, never a missing file.
         */
        _hasNextPage = options.autoPaging === true && _listResult.length > 0;
        if (_hasNextPage === true) {
          const _lastName = _listResult[_listResult.length - 1]?.name;
          if (_lastName === undefined || _lastName === options.queries.marker) {
            return done(new Error(`Invalid listing: the page does not list any new file | Container: ${container}`));
          }
          options.queries.marker = _lastName;
        }
        /** A page refused by `onPage` is not retried */
        const _result = options.onPage(_listResult);
        _hasNextPage = _hasNextPage === true && _result !== true;
        return done(_result === true ? null : _result, true);
      });
    }, function (err) {
      if (err) {
        return callback(err);
      }
      if (_hasNextPage === true) {
        return listFiles[SWIFT](storage, container, options, callback);
      }
      return callback(null);
    });
  }
};

/** List the first files not deleted, as [[key, reason], ...]: a chunk can hold 1000 files */
function formatDeleteErrors (errors) {
  const _max = 10;
  const _list = errors.slice(0, _max).map((error) => Array.isArray(error) ? error.join(': ') : JSON.stringify(error)).join(', ');
  return errors.length > _max ? `${_list}, ... (${errors.length - _max} more)` : _list;
}

const deleteFiles = {
  [S3]: function(storage, bucket, objects, callback) {
    storage.deleteFiles(bucket, objects, function(err, res) {
      if (err) {
        return callback(clientError('S3 Delete files | Delete files error returned: ', err));
      }
      if (res?.statusCode !== 200) {
        return callback(Object.assign(new Error(`Code ${res?.statusCode} | ${ res?.body?.error?.code ?? res?.body?.toString()}`), { status: res?.statusCode }));
      }
      /** S3 returns 200 even if files are not deleted (AccessDenied...): the errors are listed per file */
      const _errors = res?.body?.error ?? [];
      if (_errors.length > 0) {
        return callback(new Error(`S3 Delete files | ${_errors.length}/${objects.length} file(s) not deleted | ${formatDeleteErrors(_errors.map((error) => [error?.key, error?.code]))}`));
      }
      return callback(null, {
        list: objects,
        deleted: res?.body?.deleted?.length,
        errors: _errors
      });
    });
  },
  [SWIFT]: function(storage, bucket, objects, callback) {
    storage.deleteFiles(bucket, objects, (err, resp) => {
      if (err) {
        return callback(clientError('Swift Delete files | Delete files error returned: ', err));
      }
      if (resp?.statusCode !== 200) {
        return callback(Object.assign(new Error(`Swift Delete files | Status code ${resp?.statusCode}`), { status: resp?.statusCode }));
      }
      /** The bulk delete returns 200 even if files are not deleted: the result is in the body. A file not found is not an error The body is a Buffer unless the content type was JSON */
      const _responseStatus = resp?.body?.['Response Status'];
      const _errors = resp?.body?.Errors;
      if (typeof _responseStatus !== 'string' || Array.isArray(_errors) === false) {
        return callback(new Error(`Swift Delete files | Unexpected response, the deleted files cannot be checked | ${(Buffer.isBuffer(resp?.body) ? resp.body.toString() : JSON.stringify(resp?.body))?.slice(0, 200)}`));
      }
      if (_errors.length > 0 || _responseStatus.startsWith('2') === false) {
        return callback(new Error(`Swift Delete files | ${_errors.length}/${objects.length} file(s) not deleted | Response Status: ${_responseStatus} | ${formatDeleteErrors(_errors)}`));
      }
      return callback(null, resp.body);
    });
  }
};

const downloadFile = {
  [S3]: function(storage, bucket, key, callback) {
    storage.downloadFile(bucket, key, function(err, resp) {
      if (err) {
        return callback(clientError('S3 downloadFile Error | ', err));
      }
      if (resp?.statusCode === 404) {
        return callback(storageError("S3 downloadFile Error 404 | file not found", 404));
      }
      if (resp?.statusCode !== 200) {
        return callback(storageError(`S3 downloadFile Code ${resp?.statusCode} | ${ resp?.body?.error?.code ?? resp?.body?.toString()}`, resp?.statusCode, resp?.body?.error?.code));
      }
      if (integrityCheck === true) {
        const _fileMD5 = getMD5(resp?.body, "hex");
        const _etag = resp?.headers?.["etag"];
        /** S3 Check file integrity if "etag" exists. A multipart etag is not the MD5 of the content: it cannot be checked */
        if (_etag && isMultipartEtag(_etag.replaceAll("\"", "")) === false && "\""+_fileMD5+"\"" !== _etag) {
          return callback(storageError('S3 downloadFile Integrity check error | file md5 is not valid', resp?.statusCode));
        }
        /** Remove double quotes */
        resp.headers["etag"] = _fileMD5;
        resp.bodyMd5 = _fileMD5;
      }
      return callback(null, resp);
    });
  },
  [SWIFT]: function(storage, bucket, key, callback) {
    storage.downloadFile(bucket, key, function(err, resp) {
      if (err) {
        return callback(clientError('Swift downloadFile Error | ', err));
      }
      /** The body of an error (404, 403, 429...) must not be uploaded as the content of the file */
      if (resp?.statusCode === 404) {
        return callback(storageError("Swift downloadFile Error 404 | file not found", 404));
      }
      if (resp?.statusCode !== 200) {
        return callback(storageError(`Swift downloadFile Error | Status code ${resp?.statusCode}`, resp?.statusCode));
      }
      /** SWIFT integrity check. The etag of a large object (SLO, DLO) is not the MD5 of the content: it cannot be checked */
      if (integrityCheck === true && isSwiftLargeObject(resp.headers) === false) {
        const _fileMD5 = getMD5(resp.body, 'hex');
        if (_fileMD5 !== responseEtag(resp)?.toLowerCase()) {
          return callback(storageError('Swift downloadFile Error | Integrity check error: file md5 is not valid', resp?.statusCode));
        }
        resp.bodyMd5 = _fileMD5;
      }
      return callback(null, resp);
    });
  }
};

/**
 * With `integrityCheck`, the upload is checked by the destination against the MD5 of the body. `bodyMd5` (hex) is the MD5
 * computed on this body by the download, reused instead of hashing it again. Never a listed etag: an SSE-KMS or opaque etag
 * is not an MD5.
 */
const uploadFile = {
  [S3]: function (storage, bucket, key, body, headers, bodyMd5, callback) {
    if (integrityCheck === true) {
      headers['Content-MD5'] = bodyMd5 ? Buffer.from(bodyMd5, 'hex').toString('base64') : getMD5(body, 'base64');
    }
    storage.uploadFile(bucket, key, body, { headers: headers }, function(err, resp) {
      if (err) {
        return callback(clientError('S3 uploadFile Error | ', err));
      }
      if (resp?.statusCode !== 200) {
        const _code = resp?.body?.error?.code;
        return callback(storageError("S3 uploadFile Error | Status code " + resp?.statusCode + (_code ? ' | Code: ' + _code : ''), resp?.statusCode, _code));
      }
      return callback(null, uploadedEtag(resp, body));
    });
  },
  [SWIFT]: function(storage, bucket, key, body, headers, bodyMd5, callback) {
    if (integrityCheck === true) {
      headers['ETag'] = bodyMd5 || getMD5(body);
    }
    storage.uploadFile(bucket, key, body, { headers: headers }, function (err, resp) {
      if (err) {
        return callback(clientError('Swift upload File | Error on upload: ', err));
      }
      /** A refused upload (422 integrity check, 413, 403, 404 container...) must not be counted as synchronised */
      if (resp?.statusCode !== 201) {
        return callback(storageError(`Swift upload File | Error on upload: Status code ${resp?.statusCode}`, resp?.statusCode));
      }
      return callback(null, uploadedEtag(resp, body));
    });
  }
};

/** Swift large object (SLO manifest, DLO manifest): its etag is not the MD5 of the content */
function isSwiftLargeObject (headers) {
  return headers?.['x-static-large-object'] !== undefined || headers?.['x-object-manifest'] !== undefined;
}

/** Etag of a response without quotes, undefined if missing */
function responseEtag (resp) {
  const _etag = resp?.headers?.etag;
  return typeof _etag === 'string' && _etag !== '' ? _etag.replaceAll('"', '') : undefined;
}

/**
 * Etag of the uploaded object, recorded in the cache as the token of the destination. Without etag in the response, the MD5
 * of the body is used: the etag of a single PUT is the MD5 of the content (S3 and SWIFT). A destination listed with another
 * etag is seen as changed and compared again (no transfer if provably identical), never as unchanged.
 */
function uploadedEtag (resp, body) {
  return responseEtag(resp) ?? getMD5(body, 'hex');
}

/** A transfer error which does not change by retrying */
function isPermanentError (err) {
  return PERMANENT_STATUSES.has(err?.status) === true || err?.code === 'EntityTooLarge';
}

/**
 * Log each failed operation of a queue as a `transfer_failed` line, with its structured cause (HTTP status, error, attempt).
 * Only the number of attempts of the failing elements is kept, and forgotten on success. Capped to `maxFailures`
 * lines per queue, the rest is counted in one `transfer_failed_summary` line.
 */
function createFailureReporter (queueName, op, direction, maxFailures) {
  const _tries = new Map();
  let _logged = 0;
  let _omitted = 0;
  return {
    success (element) {
      _tries.delete(element);
    },
    /** Permanent failure: not retried, logged once with its `reason` */
    permanent: 0,
    failure (element, phase, err, reason) {
      const _try = _tries.get(element) ?? 0;
      _tries.set(element, _try + 1);
      if (reason !== undefined) {
        this.permanent++;
      }
      _log('transfer_failed', `${op} failed`, element, phase, err, reason, _try);
    },
    /** Not a failure: the object cannot be copied by this run (deleted since the listing), the next run plans it again */
    skip (element, phase, err, reason) {
      _log('transfer_skipped', `${op} skipped`, element, phase, err, reason, undefined);
    },
    end () {
      if (_omitted > 0) {
        logger.log('warn', 'transfer_failed_summary', `${_omitted} more failed or skipped operation(s) not logged`, { queue: queueName, op: op, direction: direction, omitted: _omitted, max: maxFailures });
      }
    }
  };
  function _log (event, msg, element, phase, err, reason, attempt) {
    if (_logged >= maxFailures) {
      _omitted++;
      return;
    }
    _logged++;
    const _isChunk = Array.isArray(element);
    logger.log('warn', event, msg, {
      queue    : queueName,
      op       : op,
      direction: direction,
      phase    : phase,
      key      : _isChunk ? element[0]?.key : element?.key,
      count    : _isChunk ? element.length : undefined,
      status   : err?.status,
      code     : err?.code,
      reason   : reason,
      error    : err?.toString(),
      try      : attempt
    });
  }
}

/** Worker of the upload queues: download from the storage `from`, then upload to the storage `to` */
function uploadWorker (queueName, from, to, reporter, stats) {
  return function (object, next) {
    const _fail = (phase, err, reason) => {
      if (reason !== undefined || isPermanentError(err) === true) {
        /** Not retried: the queue sees a success, the failure is counted by the reporter */
        reporter.failure(object, phase, err, reason ?? 'permanent');
        return next();
      }
      reporter.failure(object, phase, err);
      return next(`syncFiles | ${queueName} | Error during ${phase}: ` + err.toString());
    };
    if (object?.bytes > MAX_PUT_BYTES) {
      return _fail('upload', new Error(`Object of ${object.bytes} bytes: larger than 5 GiB, the maximum of a single upload`), 'too_large');
    }
    try {
      downloadFile[storages[from].name](storages[from], storages[from].bucket, object?.[from] ?? object?.key, function (err, resp) {
        if (err) {
          /**
           * Deleted since the listing (or not yet visible to the GET): skipped, not a failure. No `copied`: its cache is kept and
           * the next run plans it again from a new listing. A 403 (no ListBucket permission hides a 404) stays a failure
           */
          if (err?.status === 404) {
            stats.skipped++;
            reporter.skip(object, 'download', err, 'source_gone');
            return next();
          }
          return _fail('download', err);
        }
        /** Convert metadata headers */
        const _headers = convertHeaders(resp.headers, storages[from].name, storages[to].name);
        /**
         * The "content-encoding" is copied only when the body is provably the stored bytes: a "content-length" equal to the
         * received length. A body decompressed by the HTTP client (tiny-storage-client <= 3.6.0), or a chunked/proxy-compressed
         * response without "content-length", must not keep it: readers would decompress it a second time.
         * "aws-chunked" is a transfer detail of the upload, never a property of the stored bytes.
         */
        if (_headers['content-encoding'] !== undefined) {
          const _contentLength = resp.headers?.['content-length'];
          const _encoding = String(_headers['content-encoding']).split(',').map((value) => value.trim()).filter((value) => value !== '' && value.toLowerCase() !== 'aws-chunked').join(', ');
          if (_contentLength === undefined || Number(_contentLength) !== resp.body?.length || _encoding === '') {
            delete _headers['content-encoding'];
          } else {
            _headers['content-encoding'] = _encoding;
          }
        }
        /**
         * The object was rewritten after the listing (GET etag ≠ listed MD5): its listed token is not recorded, the next run
         * synchronises it again. Not for a Swift large object: its GET etag is never its listed hash
         */
        const _downloadedEtag = responseEtag(resp);
        const _sourceChanged = isMd5(object?.md5) === true && isMd5(_downloadedEtag) === true && _downloadedEtag.toLowerCase() !== object.md5.toLowerCase() && (storages[from].name === S3 || isSwiftLargeObject(resp.headers) === false);
        /** A request refused synchronously (invalid header...) is a failed upload, never an uncaught exception */
        let _called = false;
        try {
          uploadFile[storages[to].name](storages[to], storages[to].bucket, object?.[to] ?? object?.key, resp.body, _headers, resp.bodyMd5, function (err, etag) {
            _called = true;
            if (err) {
              return _fail('upload', err);
            }
            object.copied = { etag: etag, bytes: resp.body?.length ?? 0, sourceChanged: _sourceChanged };
            reporter.success(object);
            stats.uploaded++;
            stats.uploaded_bytes += resp.body?.length ?? 0;
            return next(null);
          });
        } catch (err) {
          if (_called === true) {
            throw err;
          }
          return _fail('upload', err);
        }
      });
    } catch (err) {
      return _fail('transfer', err);
    }
  };
}

/** Worker of the delete queues: bulk delete a chunk of files from the storage `side` */
function deleteWorker (queueName, side, reporter, stats) {
  return function (objects, next) {
    const _fail = (err) => {
      reporter.failure(objects, 'delete', err);
      return next(`syncFiles | ${queueName} | Error during delete: ` + err.toString());
    };
    try {
      return deleteFiles[storages[side].name](storages[side], storages[side].bucket, objects, function (err) {
        if (err) {
          return _fail(err);
        }
        reporter.success(objects);
        stats.deleted += objects.length;
        for (let i = 0; i < objects.length; i++) {
          objects[i].deleted = true;
        }
        return next();
      });
    } catch (err) {
      return _fail(err);
    }
  };
}

/** Sub lists of 1000 files to delete files effectively */
function chunkList (list, chunkSize = 1000) {
  const _chunks = [];
  for (let i = 0; i < list.length; i += chunkSize) {
    _chunks.push(list.slice(i, i + chunkSize));
  }
  return _chunks;
}

/**
 * @param {Function} callback (err, stats) stats: { uploaded, uploaded_bytes, deleted, skipped, failed }, also given on error
 * @param {Object} stats optional, the counters to increment: updated live, logged if the run is interrupted
 */
function syncFiles (filesToUploadTarget, filesToDeleteTarget, filesToUploadSource, filesToDeleteSource, config, callback, stats) {
  const mode = config.mode;
  const _queueOptions = { ...queueOptions, concurrency: config?.transfers ?? 15, delay: 0, retry: config?.retry ?? 0, logQueueStatus: logQueueStatus };
  const _maxFailures = config?.logMaxFailures ?? 100;
  const _stats = stats ?? { uploaded: 0, uploaded_bytes: 0, deleted: 0, skipped: 0, failed: 0 };
  /** Failed operations of each queue: an Error is returned if any operation failed after retries, or permanently */
  const _syncErrors = [];
  const _endSync = () => callback(_syncErrors.length > 0 ? new Error('Synchronisation errors | ' + _syncErrors.join(' | ')) : undefined, _stats);
  const _trackErrors = (queueName, err, queueErrors, permanentFailures) => {
    if (err) {
      return _syncErrors.push(`${queueName} | ` + err.toString());
    }
    const _failed = (queueErrors?.length ?? 0) + permanentFailures;
    if (_failed > 0) {
      _syncErrors.push(`${queueName} | ${_failed} operation(s) failed`);
      _stats.failed += permanentFailures;
      for (let i = 0; i < (queueErrors?.length ?? 0); i++) {
        /** A delete chunk counts as its number of files */
        _stats.failed += Array.isArray(queueErrors[i]?.element) ? queueErrors[i].element.length : 1;
      }
    }
  };
  const _runQueue = (queueName, list, op, direction, createWorker, next) => {
    const _reporter = createFailureReporter(queueName, op, direction, _maxFailures);
    let _done = false;
    return cqueue.execQueue(queueName, list, createWorker(queueName, _reporter), _queueOptions, function (err, _results, queueErrors) {
      /** Guard: the next queue (or the end of the synchronisation) runs once, even if cqueue calls back twice */
      if (_done === true) {
        return;
      }
      _done = true;
      _reporter.end();
      _trackErrors(queueName, err, queueErrors, _reporter.permanent);
      return next();
    });
  };
  try {
    _runQueue('delete-files-target', chunkList(filesToDeleteTarget), 'delete', 'source_to_target', (name, reporter) => deleteWorker(name, 'target', reporter, _stats), () => {
      _runQueue('upload-from-source-to-target', filesToUploadTarget, 'upload', 'source_to_target', (name, reporter) => uploadWorker(name, 'source', 'target', reporter, _stats), () => {
        if (mode === helper.MODES.UNI) {
          return _endSync();
        }
        _runQueue('upload-from-target-to-source', filesToUploadSource, 'upload', 'target_to_source', (name, reporter) => uploadWorker(name, 'target', 'source', reporter, _stats), () => {
          _runQueue('delete-files-source', chunkList(filesToDeleteSource), 'delete', 'target_to_source', (name, reporter) => deleteWorker(name, 'source', reporter, _stats), _endSync);
        });
      });
    });
  } catch(err) {
    return callback('syncFiles | Error Catched : '+ err.toString(), _stats);
  }
}

/**
 * Standard headers of an object copied as-is. "content-encoding": an object stored compressed (gzip...) must keep it,
 * otherwise it is not decompressed when read. Never the encryption, version, etag or date headers: the target
 * computes its own, and its default encryption must apply.
 */
const COPIED_HEADERS = new Set(['content-type', 'content-encoding', 'content-disposition', 'content-language', 'cache-control', 'expires']);

/**
 * Transform headers from 'x-object-meta-' to 'x-amz-meta-'
 * OR Transform headers from 'x-amz-meta-' to 'x-object-meta-'
 *
 * @param {Object} originHeaders Headers
 * @param {String} originPrefix 'x-object-meta-' OR 'x-amz-meta-'
 * @param {String} destPrefix 'x-object-meta-' OR 'x-amz-meta-'
 * @returns
 */
function convertHeaders (originHeaders, source, target) {
  const sourcePrefix = (source === SWIFT ? 'x-object-meta-' : 'x-amz-meta-');
  const targetPrefix = (target === SWIFT ? 'x-object-meta-' : 'x-amz-meta-');
  const destHeaders = {};
  for (const [key, rawValue] of Object.entries(originHeaders)) {
    if (key.startsWith(sourcePrefix) === true) {
      const metaName = targetPrefix + key.slice(sourcePrefix.length);
      const value = decodeRawUtf8(rawValue);
      /** Check if the value is already encoded */
      let decodedValue = '';
      try {
       decodedValue = decodeURIComponent(value);
      } catch(_err) {
        decodedValue = '';
      }
      if (decodedValue !== value) {
        /** Already encoded, or not decodable ("50%"): only its non ASCII characters are encoded, a header value must be ASCII */
        destHeaders[metaName] = value.replace(NON_ASCII_RUNS, encodeURIComponent);
      } else {
        destHeaders[metaName] = encodeURIComponent(value);
      }
    } else if (COPIED_HEADERS.has(key) === true) {
      destHeaders[key] = rawValue;
    }
  }
  return destHeaders;
}

/**
 * Node reads the header values as latin1: a raw UTF-8 value (Swift metadata "é" sent unencoded) arrives as "Ã©". It is
 * decoded back only if it holds bytes >= 0x80 that form valid UTF-8: a correct value is never changed.
 */
// eslint-disable-next-line no-control-regex
const NON_ASCII = /[^\x00-\x7f]/;
// eslint-disable-next-line no-control-regex
const NON_LATIN1 = /[^\x00-\xff]/;
// eslint-disable-next-line no-control-regex
const NON_ASCII_RUNS = /[^\x00-\x7f]+/g;
function decodeRawUtf8 (value) {
  if (typeof value !== 'string' || NON_ASCII.test(value) === false || NON_LATIN1.test(value) === true) {
    return value;
  }
  const _bytes = Buffer.from(value, 'latin1');
  return isUtf8(_bytes) === true ? _bytes.toString('utf8') : value;
}

// /** Generate an MD5 hash from a data */
function getMD5(data, digest, quotes) {
  try {
    const _md5 = crypto.createHash('md5').update(data).digest(digest ?? "hex");
    return quotes === true ? "\"" + _md5 + "\"" : _md5;
  } catch(err) {
    logger.log('error', 'md5_error', 'Get MD5 error', { error: err.toString() });
    return '';
  }
}

/** Returns an independent copy of the string, which no longer references the string it was sliced from */
function copyString(str) {
  return typeof str === 'string' ? Buffer.from(str, 'utf8').toString('utf8') : str;
}

/** Returns the name of the first field required by the sync that is missing or invalid, or null */
function getInvalidListedField(storageName, object) {
  const _key = storageName === S3 ? object?.key : object?.name;
  /** A key converted to a number or a boolean ("0001" read as 1) no longer designates the file */
  if (typeof _key !== 'string' || _key === '') {
    return storageName === S3 ? 'Key' : 'name';
  }
  if (storageName === S3) {
    if (typeof object.etag !== 'string' || object.etag === '') {
      return 'ETag';
    }
    if (Number.isNaN(new Date(object.lastmodified).getTime())) {
      return 'LastModified';
    }
    /** The size is part of the token recorded in the cache */
    if (Number.isFinite(object.size) === false) {
      return 'Size';
    }
    return null;
  }
  if (typeof object.hash !== 'string' || object.hash === '') {
    return 'hash';
  }
  if (typeof object.last_modified !== 'string' || Number.isNaN(new Date(object.last_modified + (object.last_modified.includes('Z') ? '' : 'Z')).getTime())) {
    return 'last_modified';
  }
  if (Number.isFinite(object.bytes) === false) {
    return 'bytes';
  }
  return null;
}

/**
 * Compare two keys in UTF-8 byte order, the order of the S3 and Swift listings (JS `<` compares UTF-16 code units: wrong
 * for the characters above U+FFFF against U+E000-U+FFFF). The first different code unit decides, unless it is a surrogate:
 * then the UTF-8 bytes are compared (lone surrogates included).
 */
function compareKeys (a, b) {
  const _length = Math.min(a.length, b.length);
  let i = 0;
  while (i < _length && a.charCodeAt(i) === b.charCodeAt(i)) {
    i++;
  }
  const _x = i < a.length ? a.charCodeAt(i) : -1;
  const _y = i < b.length ? b.charCodeAt(i) : -1;
  if ((_x >= 0xD800 && _x <= 0xDFFF) || (_y >= 0xD800 && _y <= 0xDFFF) || (i > 0 && a.charCodeAt(i - 1) >= 0xD800 && a.charCodeAt(i - 1) <= 0xDBFF)) {
    return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  }
  return _x === _y ? 0 : (_x < _y ? -1 : 1);
}

/**
 * Bounds of the key ranges of a side, picked among the bounds of its previous listing (`previous`: { objects, bounds }, from
 * the cache): `listingConcurrency` ranges at most, each of MIN_PAGES_PER_RANGE pages at least. Kept strictly increasing:
 * any increasing bounds split the keys into ranges without gap nor overlap, they only balance the ranges.
 * @returns {Object} { bounds } or { reason } of a sequential listing
 */
function rangeBounds (previous, pageSize) {
  if (listingConcurrency < 2) {
    return { reason: 'concurrency_1' };
  }
  if (Array.isArray(previous?.bounds) === false || previous.bounds.length === 0) {
    return { reason: 'no_cache' };
  }
  const _ranges = Math.min(listingConcurrency, Math.floor(previous.objects / (MIN_PAGES_PER_RANGE * pageSize)));
  const _bounds = [];
  for (let i = 1; i < _ranges; i++) {
    const _bound = previous.bounds[Math.round(i * (previous.bounds.length + 1) / _ranges) - 1];
    if (typeof _bound === 'string' && (_bounds.length === 0 || compareKeys(_bounds[_bounds.length - 1], _bound) < 0)) {
      _bounds.push(_bound);
    }
  }
  return _bounds.length === 0 ? { reason: 'small' } : { bounds: _bounds };
}

/** Bounds of the listing recorded in the cache (LISTING_PARTS parts), undefined if too small to be listed by ranges */
function listingBounds (listing, pageSize) {
  if (listing.size < MIN_PAGES_PER_RANGE * pageSize * 2) {
    return undefined;
  }
  const _bounds = [];
  let i = 0;
  for (const _key of listing.keys()) {
    if (i++ === Math.floor((_bounds.length + 1) * listing.size / LISTING_PARTS)) {
      _bounds.push(_key);
      if (_bounds.length === LISTING_PARTS - 1) {
        break;
      }
    }
  }
  return _bounds;
}

/**
 * Copy a listed file into a new object holding only the fields used by the sync. With S3, strings parsed by xmlToJson are
 * slices of the XML page: kept as is, every page listed would stay in memory for the whole synchronisation.
 * @returns {Object|Error} the file, or an Error if a field required by the sync is missing or invalid
 */
function toListedFile (storageName, type, object) {
  const _invalidField = getInvalidListedField(storageName, object);
  if (_invalidField !== null) {
    return new Error(`Invalid listing: a file without a valid "${_invalidField}" was returned by the ${type} storage | ${JSON.stringify(object)}`);
  }
  if (storageName === S3) {
    return {
      key         : copyString(object.key),
      md5         : copyString(object.etag.replaceAll("\"", "")),
      lastmodified: new Date(object.lastmodified).getTime(),
      bytes       : object.size,
      /** Token of this side after the last synchronisation, set by the cache: declared here, every object has the same shape */
      cachedEtag  : undefined,
      cachedBytes : undefined
    };
  }
  const _lastModified = object.last_modified.includes('Z') === false ? object.last_modified + 'Z' : object.last_modified;
  return {
    key         : object.name,
    md5         : object.hash,
    lastmodified: new Date(_lastModified).getTime(),
    bytes       : object.bytes,
    cachedEtag  : undefined,
    cachedBytes : undefined
  };
}

/**
 * List both sides. A side whose previous listing is known (`options.listing[side]`: { objects, bounds }, from the cache) is
 * listed by key ranges in parallel: (-∞, b1], (b1, b2], ..., (bN-1, +∞). Each range starts after its lower bound
 * (`start-after`, Swift `marker`: exclusive) and ends at its first key above its upper bound, or at the end of the listing.
 * The ranges are inserted in their order: the Map is the same as a sequential listing (keys in UTF-8 byte order). A range
 * not strictly increasing (duplicate, unordered page) or not ending at the first key of the next range is never used: the side
 * is listed again sequentially (`listing_fallback`). A sequential listing returning a key twice (pagination loop) fails.
 *
 * @param {Function} callback (err, stats) stats: { source, target } { objects, bytes, ranges, bounds }, bounds of the cache
 */
function fetchListFiles(files, options, callback) {

  if(!callback) {
    callback = options;
    options = {};
  }

  let _listFileError = null;
  const _listFileStorages = [ "target", "source" ];
  const _stats = {};
  execQueue(LIST_QUEUE, _listFileStorages,
    function(type, next) {
      const _start = Date.now();
      const _storage = storages[type];
      const _storageOptions = options?.[_storage.name];
      const _pageSize = Number(_storage.name === S3 ? _storageOptions?.queries?.['max-keys'] : _storageOptions?.queries?.limit) || (_storage.name === S3 ? 1000 : 10000);
      let _objects = 0;
      let _bytes = 0;
      let _invalidListing = null;
      /** Convert the files of a page in order, each given to `add` as soon as its page is received. Returns an Error if one is invalid or refused by `add` */
      const _convert = (list, end, add) => {
        for (let i = 0; i < end; i++) {
          const _file = toListedFile(_storage.name, type, list[i]);
          const _invalid = Error.isError(_file) === true ? _file : add(_file);
          if (Error.isError(_invalid) === true) {
            _invalidListing = _invalid.message;
            return _invalid;
          }
          _bytes += Number(_file.bytes) || 0;
        }
        _objects += end;
      };
      const _add = (file) => files[type].set(file.key, file);
      /** The queries are copied: the pagination marker of a listing must not leak into the next one */
      const _list = (queries, onPage, done) => listFiles[_storage.name](_storage, _storage.bucket, { autoPaging: true, ..._storageOptions, queries: { ..._storageOptions?.queries, ...queries }, onPage }, done);
      /** A key listed twice: the server loops (pagination ignored), the listing would never end */
      const _addOnce = (file) => (files[type].has(file.key) === true ? new Error(`Invalid listing: the key ${JSON.stringify(file.key)} is listed twice, the pagination loops | Bucket: ${_storage.bucket}`) : _add(file));
      const _listSequential = (done) => _list({}, (list) => _convert(list, list.length, _addOnce), (err) => done(err, 1));
      const _listRanges = (bounds, done) => {
        const _ranges = [];
        let _pending = bounds.length + 1;
        let _error = null;
        let _invalid = null;
        /**
         * The ranges are inserted into the Map in their order, as soon as the previous ones are done: the first range not done
         * (`_head`) inserts its files directly, the next ones keep theirs until then. Each insertion of a range starts above
         * the last key inserted: the Map is strictly increasing, as a sequential listing.
         */
        let _head = 0;
        let _lastKey;
        /**
         * Ranges 2..N start once the first page of range 1 is checked: a server ignoring the page size returns the rest of the
         * bucket to each range, a single huge page is read before the sequential listing, not N. Costs one request of latency
         */
        let _started = false;
        const _startNext = () => {
          if (_started === true) {
            return;
          }
          _started = true;
          if (_error !== null || _invalid !== null) {
            /** Range 1 failed or is invalid: the next ones are never started, only range 1 is pending */
            _pending = 1;
            return;
          }
          _ranges.slice(1).forEach((range) => range.start());
        };
        const _insert = (range, file) => {
          if (_ranges[range].inserted === false && _lastKey !== undefined && compareKeys(_lastKey, file.key) >= 0) {
            _invalid ??= `range ${range + 1}/${bounds.length + 1} overlaps the previous one`;
          }
          _ranges[range].inserted = true;
          _add(file);
          _lastKey = file.key;
        };
        for (let r = 0; r <= bounds.length; r++) {
          /**
           * `last`: last key read by the range, starting at its lower bound (a copy: a parsed key holds its whole page). `first`: first
           * key returned, `cut`: key above the upper bound that stopped the range (undefined: empty, end of the listing)
           */
          const _range = { last: bounds[r - 1], upper: bounds[r], first: undefined, cut: undefined, files: [], done: false, inserted: false };
          const _push = (file) => (r === _head ? _insert(r, file) : _range.files.push(file));
          _ranges.push(_range);
          const _onPage = (list) => {
            /** Another range failed: stop */
            if (_error !== null || _invalid !== null) {
              return true;
            }
            /** Page size ignored by the server: the ranges in flight would hold as many huge pages, listed sequentially instead */
            if (list.length > 2 * _pageSize) {
              _invalid = 'oversized_page';
              return true;
            }
            let _end = list.length;
            let _previous = _range.last;
            for (let i = 0; i < list.length; i++) {
              const _key = _storage.name === S3 ? list[i]?.key : list[i]?.name;
              /** Not a key: reported by the conversion, as a sequential listing */
              if (typeof _key !== 'string') {
                break;
              }
              if (_previous !== undefined && compareKeys(_previous, _key) >= 0) {
                _invalid = `range ${r + 1}/${bounds.length + 1} not strictly increasing in UTF-8 byte order`;
                return true;
              }
              _previous = _key;
              _range.first ??= _storage.name === S3 ? copyString(_key) : _key;
              /** Above the upper bound: listed by the next range. The rest of the page is checked, never dropped unordered */
              if (_end === list.length && _range.upper !== undefined && compareKeys(_key, _range.upper) > 0) {
                _end = i;
                _range.cut = _storage.name === S3 ? copyString(_key) : _key;
              }
            }
            const _result = _convert(list, _end, _push) ?? (_end < list.length ? true : undefined);
            /** Copied key of the last file kept: the next page of the range starts above it */
            _range.last = _end > 0 && _result === undefined ? (_storage.name === S3 ? copyString(_previous) : _previous) : _range.last;
            return _result;
          };
          _range.start = () => _list(r === 0 ? {} : { [_storage.name === S3 ? 'start-after' : 'marker']: bounds[r - 1] }, r > 0 ? _onPage : (list) => {
            const _result = _onPage(list);
            _startNext();
            return _result;
          }, (err) => {
            _error ??= err ?? null;
            _startNext();
            _range.done = true;
            while (_error === null && _invalid === null && _ranges[_head]?.done === true) {
              _head++;
              /** The next range becomes the first not done: its files kept so far are inserted */
              if (_head < _ranges.length) {
                _ranges[_head].files.forEach((file) => _insert(_head, file));
                _ranges[_head].files = [];
              }
            }
            if (--_pending > 0) {
              return;
            }
            /**
             * Contiguity, whatever the order of the server: each range stopped at the first key returned by the next one (or both
             * at the end of the listing). Otherwise a key may lie between them (server order not UTF-8, bucket changed meanwhile)
             */
            for (let i = 1; _error === null && _invalid === null && i < _ranges.length; i++) {
              if (_ranges[i - 1].cut !== _ranges[i].first) {
                _invalid = `range ${i}/${_ranges.length} does not end at the first key of the next range`;
              }
            }
            return done(_error, _error === null && _invalid === null ? _ranges.length : undefined, _error === null ? _invalid : null);
          });
        }
        _ranges[0].start();
      };
      const _done = (err, ranges, invalid) => {
        if (invalid) {
          files[type].clear();
          logger.log('warn', 'listing_fallback', `${type} listing by ranges invalid, listed again sequentially`, { side: type, storage: _storage.name, bucket: _storage.bucket, reason: invalid });
          _objects = 0;
          _bytes = 0;
          return _listSequential(_done);
        }
        if (err) {
          _listFileError = _invalidListing ?? err.toString();
          /** A side partially listed must never be used */
          files[type].clear();
          return next(err);
        }
        _stats[type] = { objects: _objects, bytes: _bytes, ranges: ranges, bounds: listingBounds(files[type], _pageSize) };
        logger.log('info', 'listing_done', `${type} listed`, {
          side: type, storage: _storage.name, bucket: _storage.bucket, objects: _objects, bytes: _bytes, duration_ms: Date.now() - _start, ranges: ranges
        });
        return next();
      };
      const { bounds, reason } = rangeBounds(options?.listing?.[type], _pageSize);
      if (reason !== undefined) {
        logger.log('debug', 'listing_sequential', `${type} listed sequentially`, { side: type, storage: _storage.name, bucket: _storage.bucket, reason: reason });
        return _listSequential(_done);
      }
      return _listRanges(bounds, _done);
    },
    /** No retry of the whole listing: each page is already retried, and the result of a retry was ignored */
    { ...queueOptions, concurrency: 2, retry: 0, logQueueStatus: logQueueStatus },
    function (err) {
      if (err) {
        return callback("Execqueue - List files error | " + err.toString());
      }
      if (_listFileError) {
        /** Stop immediately, the listing is missing files and it is skewing sync */
        return callback("List files error | " + _listFileError.toString());
      }
      return callback(undefined, _stats);
    }
  );
}

/**
 * Resolve the opaque etags with a HEAD request: OVH lists the encrypted objects copied server-side with an opaque etag,
 * the HEAD returns their MD5. Sets `resolvedMd5` on each object: its MD5, or null if the HEAD fails after the retries or
 * returns another kind of etag (the objects are then not provably identical). Never fails.
 *
 * @param {Array} list [{ side, object }]
 * @param {Function} callback (stats) { resolved, unresolved, duration_ms }
 */
function resolveEtags (list, config, callback) {
  const _start = Date.now();
  const _options = { ...queueOptions, concurrency: config?.transfers ?? 15, delay: 0, retry: config?.retry ?? 0, logQueueStatus: logQueueStatus };
  execQueue('resolve-etags', list, function ({ side, object }, next) {
    storages[side].getFileMetadata(storages[side].bucket, object.key, function (err, resp) {
      if (err || resp?.statusCode >= 500 || resp?.statusCode === 429) {
        return next(`HEAD ${side} ${object.key} | ` + (err?.toString() ?? `Status code ${resp?.statusCode}`));
      }
      const _etag = resp?.statusCode === 200 ? responseEtag(resp) : undefined;
      object.resolvedMd5 = isMd5(_etag) === true ? _etag.toLowerCase() : null;
      return next();
    });
  }, _options, function () {
    let _unresolved = 0;
    for (let i = 0; i < list.length; i++) {
      list[i].object.resolvedMd5 ??= null;
      _unresolved += list[i].object.resolvedMd5 === null ? 1 : 0;
    }
    return callback({ resolved: list.length - _unresolved, unresolved: _unresolved, duration_ms: Date.now() - _start });
  });
}

/**
 * A key missing from the listing of a side is deleted from the other side only if a HEAD on the side it is missing from
 * returns 404: a listing can miss objects (eventually consistent Swift container listing, page cut...). Present (2xx): the
 * deletion is dropped, its cache is kept (`deletion_skipped reason=still_present`). Any other answer after the retries (a
 * 400, 403 or 413 is not retried): dropped and counted as failed (`deletion_skipped reason=not_confirmed`). Never fails.
 * The deletions of the plan are replaced by the confirmed ones.
 *
 * @param {Function} callback (failed) number of deletions not confirmed
 */
function confirmDeletions (plan, config, callback) {
  const _list = [];
  for (const [_from, _side] of [[plan.objectsToDeleteTarget, 'source'], [plan.objectsToDeleteSource, 'target']]) {
    for (let i = 0; i < _from.length; i++) {
      _list.push({ side: _side, object: _from[i] });
    }
  }
  if (_list.length === 0) {
    return callback(0);
  }
  const _start = Date.now();
  const _gone = new Set();
  const _present = new Set();
  const _options = { ...queueOptions, concurrency: config?.transfers ?? 15, delay: 0, retry: config?.retry ?? 0, logQueueStatus: logQueueStatus };
  execQueue('confirm-deletions', _list, function ({ side, object }, next) {
    try {
      storages[side].getFileMetadata(storages[side].bucket, object.key, function (err, resp) {
        const _status = err ? err?.storageStatusCode : resp?.statusCode;
        if (!err && _status === 404) {
          _gone.add(object);
          return next();
        }
        if (!err && _status >= 200 && _status < 300) {
          _present.add(object);
          return next();
        }
        /** Not retried: the deletion is dropped as not confirmed */
        if (PERMANENT_STATUSES.has(_status) === true) {
          return next();
        }
        return next(`HEAD ${side} ${object.key} | ` + (err?.toString() ?? `Status code ${_status}`));
      });
    } catch (err) {
      return next(`HEAD ${side} ${object.key} | ` + err.toString());
    }
  }, _options, function () {
    plan.objectsToDeleteTarget = plan.objectsToDeleteTarget.filter((object) => _gone.has(object));
    plan.objectsToDeleteSource = plan.objectsToDeleteSource.filter((object) => _gone.has(object));
    const _failed = _list.length - _gone.size - _present.size;
    for (const [_reason, _count] of [['still_present', _present.size], ['not_confirmed', _failed]]) {
      if (_count > 0) {
        logger.log('warn', 'deletion_skipped', `${_count} deletion(s) skipped: the file missing from a listing ${_reason === 'still_present' ? 'is still present' : 'could not be checked'}`, {
          reason: _reason, count: _count, checked: _list.length, duration_ms: Date.now() - _start
        });
      }
    }
    return callback(_failed);
  });
}

module.exports = {
  connection,
  fetchListFiles,
  syncFiles,
  resolveEtags,
  confirmDeletions,
  convertHeaders,
  getDeletionRefusal,
  compareKeys
};