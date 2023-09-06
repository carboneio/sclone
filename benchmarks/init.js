const clientStorage = require("tiny-storage-client");
const fs = require("fs");
const path = require("path");
const execQueue = require("../cqueue");
const loremIpsum = require("lorem-ipsum");
const { randomBytes } = require("crypto");
const buf = randomBytes(32);

const getBytes = (string) => Buffer.byteLength(string, "utf8");
const convertBytesToGB = (n) => n / 1024 / 1024 / 1024;

const _config = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, process?.env?.npm_config_config ?? "config.json")
  )
);
const storageSource = clientStorage(_config.source);
storageSource.setTimeout(60000);

const storageTarget = clientStorage(_config.target);
storageTarget.setTimeout(60000);

function generateDataSet(quantity, callback) {
  let total = 0;

  try {
    fs.mkdirSync(path.join(__dirname, `${quantity}GO`));
  } catch (err) {
    if (err.toString().includes("already exists") === true) {
      return callback();
    } else {
      return callback(err);
    }
  }

  for (let i = 0; i < 100000000; i++) {
    const output = loremIpsum({ count: 1000000, units: "words" });
    total += getBytes(output);
    fs.writeFileSync(
      path.join(__dirname, `${quantity}GO`, `file-${i}.txt`),
      Buffer.from(output)
    );
    console.log(convertBytesToGB(total));
    if (convertBytesToGB(total) >= quantity) {
      console.log(`${quantity}GO Generated!`);
      callback();
      break;
    }
  }
}

function cleanBucket(storage, bucketName, callback) {
  storage.listFiles(bucketName, (err, resp) => {
    if (err) {
      return callback(err.toString());
    }
    if (resp.statusCode !== 200) {
      return callback("Listing failed, status returned " + resp.statusCode);
    }
    if (!resp?.body?.contents) {
      return callback();
    }
    storage.deleteFiles(bucketName, resp.body?.contents, (err, resp) => {
      if (err) {
        return callback(err.toString());
      }
      if (resp.statusCode !== 200) {
        return callback("Deletion failed, status returned " + resp.statusCode);
      }
      console.log("Deleted: " + resp?.body?.deleted?.length);
      return callback();
    });
  });
}

function setupBisyncDataset(dataSetName, callback) {
  const files = fs.readdirSync(path.join(__dirname, `${dataSetName}GO`));
  const target = [];
  const source = [];
  const targetUpdated = [];

  fs.rmSync(path.join(__dirname, `targetDataset`), {
    recursive: true,
    force: true,
  });
  fs.rmSync(path.join(__dirname, `sourceDataset`), {
    recursive: true,
    force: true,
  });
  fs.mkdirSync(path.join(__dirname, `targetDataset`));
  fs.mkdirSync(path.join(__dirname, `sourceDataset`));

  for (let i = 0; i < files.length; i++) {
    if (i < files.length / 3) {
      source.push(files[i]);
      target.push(files[i]);
    } else if (i >= files.length / 3 && i < (files.length / 3) * 2) {
      source.push(files[i]);
      target.push(files[i]);
      targetUpdated.push(files[i]);
    } else {
      if (i % 2 === 0) {
        source.push(files[i]);
      } else {
        target.push(files[i]);
      }
    }
  }
  console.log(files.length, source.length, target.length, targetUpdated.length);
  for (let i = 0; i < target.length; i++) {
    fs.copyFile(
      path.join(__dirname, `${dataSetName}GO`, target[i]),
      path.join(__dirname, `targetDataset`, target[i]),
      function (err) {
        if (err) throw err;
      }
    );
  }
  for (let i = 0; i < source.length; i++) {
    fs.copyFile(
      path.join(__dirname, `${dataSetName}GO`, source[i]),
      path.join(__dirname, `sourceDataset`, source[i]),
      function (err) {
        if (err) throw err;
      }
    );
  }
  for (let i = 0; i < targetUpdated.length; i++) {
    console.log(
      "Updated:",
      path.join(__dirname, `targetDataset`, targetUpdated[i])
    );
    fs.readFile(
      path.join(__dirname, `targetDataset`, targetUpdated[i]),
      function (err, data) {
        if (err) throw err;
        data += buf;
        fs.writeFile(
          path.join(__dirname, `targetDataset`, targetUpdated[i]),
          data,
          function (err) {
            if (err) throw err;
          }
        );
      }
    );
  }
  return callback();
}

function uploadDataSet(bucketName, dataSetName) {
  const files = fs.readdirSync(path.join(__dirname, `${dataSetName}GO`));

  cleanBucket(storageSource, bucketName, (err) => {
    if (err) {
      return console.log("Clean bucket failed:" + err.toString());
    }
    execQueue(
      "upload-dataset",
      files,
      (fileName, next) => {
        storageSource.uploadFile(
          bucketName,
          fileName,
          path.join(__dirname, `${dataSetName}GO`, fileName),
          function (err) {
            if (err) {
              return next(err.toString());
            }
            return next();
          }
        );
      },
      { concurrency: 10 },
      function (err) {
        if (err) {
          console.log("Something went wrong:" + err.toString());
        }
        console.log("Upload done!");
      }
    );
  });
}

function uploadDataSetBi(bucketSource, bucketTarget) {
  const sourceFiles = fs.readdirSync(path.join(__dirname, `sourceDataset`));
  const targetFiles = fs.readdirSync(path.join(__dirname, `targetDataset`));

    execQueue(
        "upload-source-dataset",
        sourceFiles,
        (fileName, next) => {
            storageSource.uploadFile(
                bucketSource,
                fileName,
                path.join(__dirname, `sourceDataset`, fileName),
                function (err) {
                    if (err) {
                        return next(err.toString());
                    }
                    return next();
                }
            );
        },
        { concurrency: 10 },
        function (err) {
            if (err) {
                console.log("Something went wrong:" + err.toString());
            }
            console.log("🟢 Upload Source done!");
            execQueue(
                "upload-target-dataset",
                targetFiles,
                (fileName, next) => {
                    storageTarget.uploadFile(
                        bucketTarget,
                        fileName,
                        path.join(__dirname, `targetDataset`, fileName),
                        function (err) {
                            if (err) {
                                return next(err.toString());
                            }
                            return next();
                        }
                    );
                },
                { concurrency: 10 },
                function (err) {
                    if (err) {
                        console.log("Something went wrong:" + err.toString());
                    }
                    console.log("Upload target done!");
                }
            );
        }
    );
}

const mode = process?.env?.npm_config_mode;
const size = parseInt(process?.env?.npm_config_size);
const bucketName = process?.env?.npm_config_bucket;

if (mode === "generate") {
  if (isNaN(size) === true) {
    console.log(
      "Invalid or missing size argument, pass the option --size=2, the unit is GB"
    );
    process.exit();
  }
  console.log(`🟢 Generating ${size}GB of data-set`);
  generateDataSet(size, () => {
    console.log("🟢 Done");
  });
} else if (mode === "upload") {
  if (!bucketName) {
    console.log("Missing bucket name, pass the option --bucket=name");
    process.exit();
  }
  if (isNaN(size) === true) {
    console.log(
      "Invalid or missing size argument, pass the option --size=2, the unit is GB"
    );
    process.exit();
  }
  storageSource.headBucket(bucketName, (err, resp) => {
    if (err) {
      console.log("Head bucket error: " + err.toString());
      process.exit();
    }
    if (resp.statusCode !== 200) {
      console.log("Head bucket status error: " + resp.statusCode);
      process.exit();
    }
    console.log(`🟢 Bucket accessible ${bucketName}`);
    console.log(`🟢 Uploading ${size}GB of data-set into "${bucketName}"`);
    uploadDataSet(bucketName, size);
  });
} else if (mode === "uploadbi") {
    storageSource.headBucket(_config.source.bucket, (err, resp) => {
        if (err) {
          console.log("Head bucket error: " + err.toString());
          process.exit();
        }
        if (resp.statusCode !== 200) {
          console.log("Head bucket status error: " + resp.statusCode);
          process.exit();
        }
        storageTarget.headBucket(_config.target.bucket, (err, resp) => {
            if (err) {
              console.log("Head bucket error: " + err.toString());
              process.exit();
            }
            if (resp.statusCode !== 200) {
              console.log("Head bucket status error: " + resp.statusCode);
              process.exit();
            }
            console.log(`🟢 Buckets accessible! `, _config.source.bucket, '/', _config.target.bucket);
            uploadDataSetBi(_config.source.bucket, _config.target.bucket);
        })
    })
} else if (mode === "clean") {
  if (!bucketName) {
    console.log("Missing bucket name, pass the option --bucket=name");
    process.exit();
  }
  console.log("🟢 Clean storage", bucketName === _config.source.bucket ? 'source' : 'target');
  cleanBucket(bucketName === _config.source.bucket ? storageSource : storageTarget, bucketName, (err) => {
    if (err) {
      console.log("Something went wrong:" + err.toString());
      process.exit();
    }
    console.log("🟢 Done");
  });
} else if (mode === "generatebi") {
  setupBisyncDataset(size, function (err) {
    if (err) {
      console.log("Something went wrong:" + err.toString());
      process.exit();
    }
    console.log("🟢 Done");
  });
} else {
  console.log(
    "Missing mode option, add the to command: --mode=value. The value can be: generate or clean"
  );
}

/**
 * COMMANDS:
 * - npm run bench --mode=clean --bucket=name
 * - npm run bench --mode=generate --size=1
 * - npm run bench --mode=generatebi --size=1
 */
