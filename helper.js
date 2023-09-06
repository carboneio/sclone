const fs = require('fs');
const path = require('path');

const MODES = {
  UNI: "unidirectional",
  BI: "bidirectional"
}
const SUPPORTED_MODES = [MODES.UNI, MODES.BI];

function loadConfig(filenameOrAbsolutePath, callback) {
  let config = {};
  let configPath = '';
  if (fs.existsSync(filenameOrAbsolutePath)) {
    configPath = filenameOrAbsolutePath;
  } else {
    configPath = path.join(__dirname, filenameOrAbsolutePath);
  }
  try {
    config = JSON.parse(fs.readFileSync(configPath).toString())
  } catch(err) {
    return callback(new Error("config.json is required | " + err.toString()));
  }
  return callback(null, config);
}

function stop(msg) {
  console.log("🔴 " + msg.toString());
  return process.exit();
}

function arrayToMap(originArray, destinationMap) {
  for (let i = 0; i < originArray.length; i++) {
    const _object = originArray[i];
    const _key = _object[0];
    const _value = _object[1];
    destinationMap.set(_key, _value);
  }
}

function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return "0 Bytes";

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
}

function fetchCache(cacheFilename, mode, files, callback) {
  if (!cacheFilename) {
    return callback("'cacheFilename' missing from the configuration file")
  }
  if (mode === MODES.UNI) {
    console.log(`✅ Cache loading skipped on "${MODES.UNI}" mode`);
    return callback();
  }
  fs.readFile(path.join(__dirname, cacheFilename), function(err, data) {
    if (err) {
      return callback("⭕️ Read cache error | " + err.toString())
    }
    let _listFilesCache = []
    try {
      _listFilesCache = JSON.parse(data.toString());
    } catch (err) {
      _listFilesCache = [];
      return callback("JSON parse error catched | " + err.toString())
    }
     /** Transform object into a Map **/
    arrayToMap(_listFilesCache, files.cache);
    console.log(`🟢 Loaded ${files.cache.size} files on cache`);
    return callback();
  });
}

function saveCache(cacheFilename, data, mode, callback) {
  if (mode === MODES.UNI) {
    console.log(`🟢 Cache saving skipped on "${MODES.UNI}" mode`);
    return callback();
  }
  if (!cacheFilename) {
    return callback("'cacheFilename' missing from the configuration file")
  }
  fs.writeFile(path.join(__dirname, cacheFilename), data, function(err) {
    if (err) {
      return callback("Save cache error:" + err.toString());
    }
    console.log("SYNC DONE > Save new cache...");
    console.log("✅ Cache SAVED!");
    return callback();
  })
}

module.exports = {
  loadConfig,
  stop,
  arrayToMap,
  formatBytes,
  saveCache,
  fetchCache,
  MODES,
  SUPPORTED_MODES
}