const storageClient = require("tiny-storage-client");
const execQueue = require('./cqueue')
const crypto = require('crypto');
const helper = require("./helper");


const SWIFT = 'swift'
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
}

let integrityCheck = false;
let logQueueStatus = false;
const getStorageName = (auth) => {
  if (!auth?.name) {
    throw new Error('Config "name" not defined on "config.json", accepted values: '+ SUPPORTED_STORAGES.toString());
  }
  if (SUPPORTED_STORAGES.includes(auth?.name) === false) {
    throw new Error(`Storage ${auth.name} not supported, accepted values: `+ SUPPORTED_STORAGES.toString());
  }
  return auth.name;
}

function connection (config, type, callback) {
  storages[type] = {
    ...storages[type],
    ...storageClient(config[type]),
    name  : getStorageName(config[type]),
    bucket: config[type].bucket
  }
  storages[type].setTimeout(240000);

  if (config?.integrityCheck === true) {
    integrityCheck = true;
  }
  if (config?.test === true) {
    logQueueStatus = false;
  }

  if (storages[type].name === SWIFT) {
    return storages[type].connection((err) => {
      if (err) {
        return callback(`[SWIFT ${type}] Connexion error | ` + err.toString());
      }
      console.log(`🟢 ${type.charAt(0).toUpperCase() + type.slice(1)} SWIFT connected!`);
      return callback();
    })
  } else if (storages[type].name === S3) {
    return storages[type].listBuckets((err, resp) => {
      if (err) {
        return callback(`[S3 ${type}] Error: ` + err?.toString());
      }
      if (resp?.statusCode !== 200) {
        return callback( `[S3 ${type}] 🚩 Storage error | Status ` + resp?.statusCode + '| Response: ' + typeof resp?.body === 'object' ? JSON.stringify(resp?.body) : resp?.body);
      }
      console.log(`🟢 ${type.charAt(0).toUpperCase() + type.slice(1)} S3 connected! | Buckets: ` + resp.body?.bucket?.reduce((total, val) => total += '[ ' + val?.name + ' ]', ''));
      return callback();
    })
  } else {
    return callback(`Storage "${type}" missing a storage "name" on the "config.json"`);
  }
}


const listFiles = {
  [S3]: function(storage, container, options, callback) {
    if (callback === undefined) {
      callback = options;
      options = {};
    }
    /** List files options */
    options.metadata =  options?.metadata ?? false;
    options.queries = options?.queries ?? {};
    options.autoPaging = options?.autoPaging ?? false;
    /** List file private variables */
    options.results = options?.results ?? [];
    storage.listFiles(container, options, function (err, resp) {
      if (err) {
        return callback(err);
      }
      if (resp?.statusCode !== 200) {
        return callback(new Error(`Status: ${resp?.statusCode} | Body: ${ resp?.body?.error?.code ?? resp?.body?.toString()} | Bucket: ${container}` ))
      }
      const _listResult = resp?.body?.contents ?? [];
      options.results = [...options.results, ..._listResult]
      if (options.autoPaging === true && resp.body.istruncated === true) {
        options.queries['start-after'] = _listResult[_listResult.length - 1].key;
        return listFiles[S3](storage, container, options, callback);
      }
      return callback(null, options.results);
    });
  },
  [SWIFT]: function (storage, container, options, callback) {
    if (callback === undefined) {
      callback = options;
      options = {};
    }
    /** List files options */
    options.queries = options?.queries ?? {};
    options.queries.limit = options?.queries?.limit ?? 10000;
    options.autoPaging = options?.autoPaging ?? false;
    /** List file private variables */
    options.results = options?.results ?? [];

    storage.listFiles(container, options, function (err, resp) {
      if (err) {
        return callback(err);
      }
      let _listResult = resp.body;
      options.results = [...options.results, ..._listResult]
      if (options.autoPaging === true && _listResult.length === options.queries.limit) {
        options.queries.marker = _listResult[_listResult.length - 1].name;
        return listFiles[SWIFT](storage, container, options, callback);
      }
      return callback(null, options.results);
    });
  }
}

const deleteFiles = {
  [S3]: function(storage, bucket, objects, callback) {
    storage.deleteFiles(bucket, objects, function(err, res) {
      if (err) {
        return callback('S3 Delete files | Delete files error returned: ' + err.toString());
      }
      if (err) {
        return callback(err);
      }
      if (res?.statusCode !== 200) {
        return callback(new Error(`Code ${res?.statusCode} | ${ res?.body?.error?.code ?? res?.body?.toString()}`));
      }
      return callback(null, {
        list: objects,
        deleted: res?.body?.deleted?.length,
        errors: res?.body?.error
      });
    });
  },
  [SWIFT]: function(storage, bucket, objects, callback) {
    storage.deleteFiles(bucket, objects, (err, resp) => {
      if (err) {
        return callback('Swift Delete files | Delete files error returned: ' + err.toString());
      }
      return callback(null, resp.body);
    })
  }
}

const downloadFile = {
  [S3]: function(storage, bucket, key, callback) {
    storage.downloadFile(bucket, key, function(err, resp) {
      if (err) {
        return callback("S3 downloadFile Error | " + err.toString());
      }
      if (resp?.statusCode === 404) {
        return callback("S3 downloadFile Error 404 | file not found");
      }
      if (resp?.statusCode !== 200) {
        return callback(`S3 downloadFile Code ${resp?.statusCode} | ${ resp?.body?.error?.code ?? resp?.body?.toString()}`);
      }
      if (integrityCheck === true) {
        const _fileMD5 = getMD5(resp?.body, "hex")
        /** S3 Check file integrity if "etag" exists */
        if (resp?.headers?.["etag"] && "\""+_fileMD5+"\"" !== resp?.headers?.["etag"]) {
          return callback(`S3 downloadFile Integrity check error | file md5 is not valid`);
        }
        /** Remove double quotes */
        resp.headers["etag"] = _fileMD5;
      }
      return callback(null, resp);
    })
  },
  [SWIFT]: function(storage, bucket, key, callback) {
    storage.downloadFile(bucket, key, function(err, resp) {
      if (err) {
        return callback("Swift downloadFile Error | " + err.toString());
      }
      /** SWIFT integrity check */
      if (integrityCheck === true) {
        const _fileMD5 = getMD5(resp.body, 'hex');
        if (_fileMD5 !== resp.headers.etag) {
          return callback(`Swift downloadFile Error | Integrity check error: file md5 is not valid`);
        }
      }
      return callback(null, resp)
    })
  }
}

const uploadFile = {
  [S3]: function (storage, bucket, key, body, headers, callback) {
    if (integrityCheck === true) {
     headers['Content-MD5'] = getMD5(body, 'base64')
    }
    storage.uploadFile(bucket, key, body, { headers: headers }, function(err, resp) {
      if (err) {
        return callback("S3 uploadFile Error | " + err.toString());
      }
      if (resp?.statusCode !== 200) {
        return callback("S3 uploadFile Error | Status code " + resp.statusCode);
      }
      return callback(null);
    })
  },
  [SWIFT]: function(storage, bucket, key, body, headers, callback) {
    if (integrityCheck === true) {
      headers['ETag'] = getMD5(body)
     }
    storage.uploadFile(bucket, key, body, { headers: headers }, function (err) {
      if (err) {
        return callback(`Swift upload File | Error on upload: ` + err.toString());
      }
      return callback(null);
    })
  }
}

function syncFiles (filesToUploadTarget, filesToDeleteTarget, filesToUploadSource, filesToDeleteSource, config, callback) {
  const mode = config.mode;
  const transfers = config?.transfers ?? 15;
  const retry = config?.retry ?? 0;
  try {
    /** Create sub lists to delete files effectively */
    const chunkSize = 1000;
    const filesToDeleteChunks = [];
    for (let i = 0; i < filesToDeleteTarget.length; i += chunkSize) {
      filesToDeleteChunks.push(filesToDeleteTarget.slice(i, i + chunkSize));
    }
    execQueue(`delete-files-target`, filesToDeleteChunks, function(objects, next) {
      try {
        return deleteFiles[storages.target.name](storages.target, storages.target.bucket, objects, function(err, resp) {
          if (err) {
            return next("syncFiles | delete-files-target | " + err.toString());
          }
          return next(null, resp)
        });
      } catch(err) {
        return next('syncFiles | delete-files-target | Error catched: ' + err.toString());
      }
    }, { concurrency: transfers, delay: 0, retry: retry, logQueueStatus: logQueueStatus }, function(err) {
      if (err) {
        console.log("Error on deleting target files |" + err.toString());
      }
      return execQueue('upload-from-source-to-target', filesToUploadTarget, function(object, next) {
          try {
            downloadFile[storages.source.name](storages.source, storages.source.bucket, object?.source ?? object?.key, function (err, resp) {
              if (err) {
                return next("syncFiles | upload-from-source-to-target | Error during download:" + err.toString());
              }
              const _headers = convertHeaders(resp.headers, storages.source.name, storages.target.name);
              uploadFile[storages.target.name](storages.target, storages.target.bucket, object?.target ?? object?.key, resp.body, _headers, function (err) {
                if (err) {
                  return next("syncFiles | upload-from-source-to-target | Error during upload: " + err.toString());
                }
                return next(null);
              })
            });
          } catch(err) {
            return next('syncFiles | upload-from-source-to-target error catched: ' + err.toString());
          }
        },
        { concurrency: transfers, delay: 0, retry: retry, logQueueStatus: logQueueStatus },
        function(err) {
          if (err) {
            console.log("Error on uploading S3 files |" + err.toString());
          }

          if (mode === helper.MODES.UNI) {
            return callback();
          }

          return execQueue('upload-from-target-to-source', filesToUploadSource, function(object, next) {
            try {
              downloadFile[storages.target.name](storages.target, storages.target.bucket, object?.target ?? object?.key, function(err, resp) {
                if (err) {
                  return next(`syncFiles | upload-from-target-to-source | Error during download: ` + err.toString());
                }
                /** Convert metadata headers */
                const _headers = convertHeaders(resp.headers, storages.target.name, storages.source.name);
                uploadFile[storages.source.name](storages.source, storages.source.bucket, object?.source ?? object?.key, resp.body, _headers, function(err) {
                  if (err) {
                    return next(`syncFiles | upload-from-target-to-source | Error during upload: ` + err.toString());
                  }
                  return next(null);
                })
              });
            } catch(err) {
              return next('syncFiles | upload-from-target-to-source | error catched: ' + err.toString());
            }
          },
          { concurrency: transfers, delay: 0, retry: retry, logQueueStatus: logQueueStatus },
          function(err) {
            if (err) {
              console.log("Error on uploading to source files |" + err.toString());
            }
            /** Create sub lists to delete files effectively */
            const chunkSize = 1000;
            const filesToDeleteSourcesChunks = [];
            for (let i = 0; i < filesToDeleteSource.length; i += chunkSize) {
              filesToDeleteSourcesChunks.push(filesToDeleteSource.slice(i, i + chunkSize));
            }
            return execQueue('delete-files-source', filesToDeleteSourcesChunks, function(objects, next) {
              try {
                deleteFiles[storages.source.name](storages.source, storages.source.bucket, objects, function(err) {
                  if (err) {
                    return next(`syncFiles | delete-files-source | Error returned: ` + err.toString());
                  }
                  return next();
                });
              } catch(err) {
                return next('syncFiles | delete-files-source | error catched: ' + err.toString());
              }
            },
            { concurrency: transfers, delay: 0, retry: retry, logQueueStatus: logQueueStatus },
            function(err) {
              if (err) {
                console.log("Error on deleting source files |" + err.toString());
              }
              return callback();
            })
          })
        }
      )
    });
  } catch(err) {
    return callback('syncFiles | Error Catched : '+ err.toString());
  }
}

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
  const destHeaders = {}
  for (const [key, value] of Object.entries(originHeaders)) {
    if (key.includes(sourcePrefix) === true) {
      const metaName = targetPrefix + key.replace(sourcePrefix, '');
      /** Check if the value is already encoded */
      let decodedValue = '';
      try {
       decodedValue = decodeURIComponent(value);
      } catch(err) {
        decodedValue = '';
      }
      if (decodedValue !== value) {
        destHeaders[metaName] = value;
      } else {
        destHeaders[metaName] = encodeURIComponent(value);
      }
    } else if (key === 'content-type') {
      destHeaders[key] = value;
    }
  }
  return destHeaders;
}

// /** Generate an MD5 hash from a data */
function getMD5(data, digest, quotes) {
  try {
    const _md5 = crypto.createHash('md5').update(data).digest(digest ?? "hex");
    return quotes === true ? "\"" + _md5 + "\"" : _md5;
  } catch(err) {
    console.log(`Storage Get MD5 Error: ${err.toString()}`, "error");
    return '';
  }
}

function fetchListFiles(files, options, callback) {

  if(!callback) {
    callback = options;
    options = {};
  }

  let _listFileError = null;
  const _listFileStorages = [ "target", "source" ];
  execQueue('list-files-source-target', _listFileStorages,
    function(type, next) {
      return listFiles[storages[type].name](storages[type], storages[type].bucket, { autoPaging: true, ...options?.[storages[type].name] }, (err, results) => {
        if (err) {
          _listFileError = err.toString();
          return next(err);
        }
        
        for (let i = 0; i < results.length; i++) {
          const _object = results[i];
          if (!_object?.key && _object?.name) {
            _object.key = _object.name;
          }
          /** Get md5 and remove unused informations */
          if (storages[type].name === S3) {
            _object.md5 = _object.etag.replace("\"", "");
            _object.lastmodified = new Date(new Date(_object.lastmodified).toUTCString()).getTime();
            _object.bytes = _object.size;
            delete _object.etag;
            delete _object.storageclass;
            delete _object.size;
          }
          if (storages[type].name === SWIFT) {
            if (_object.last_modified.includes('Z') === false) {
              _object.last_modified += 'Z';
            }
            _object.md5 = _object.hash;
            _object.lastmodified = new Date(new Date(_object.last_modified).toUTCString()).getTime();
            delete _object.hash;
            delete _object.content_type;
            delete _object.last_modified;
            delete _object.name;
          }
          files[type].set(_object.key, _object);
        }
        return next();
      })
    },
    { concurrency: 2, logQueueStatus: logQueueStatus },
    function (err) {
      if (err) {
        return callback("Execqueue - List files error | " + err.toString());
      }
      if (_listFileError) {
        /**
         * Stop immediately, the listing is missing files and it is skewing sync
         * Possible evolution: Try to run the listing a second time if the first failed?
         */
        return callback("List files error | " + _listFileError.toString());
      }
      return callback();
    }
  )
}

module.exports = {
  connection,
  fetchListFiles,
  syncFiles,
  convertHeaders
}