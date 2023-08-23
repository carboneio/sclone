const clientStorage = require("tiny-storage-client");
const fs = require("fs");
const path = require("path");
const execQueue = require("../cqueue");
const loremIpsum = require("lorem-ipsum");

const getBytes = (string) => Buffer.byteLength(string, "utf8");
const convertBytesToGB = (n) => n / 1000 / 1000 / 1000;

const _config = JSON.parse(
  fs.readFileSync(path.join(__dirname, process?.env?.npm_config_config ?? "config.json"))
);
const s3 = clientStorage(_config);
s3.setTimeout(60000);


function generateDataSet(quantity, callback) {
  let total = 0;

  try {
    fs.mkdirSync(path.join(__dirname, `${quantity}GO`));
  } catch(err) {
    if (err.toString().includes('already exists') === true) {
        return callback();
    } else {
        return callback(err);
    }
  }

  for (let i = 0; i < 1000; i++) {
    const output = loremIpsum({ count: 1000000, units: "words" });
    total += getBytes(output);
    fs.writeFileSync(
      path.join(__dirname, `${quantity}GO`, `file-${i}.txt`),
      Buffer.from(output)
    );
    console.log(convertBytesToGB(total));
    if (convertBytesToGB(total) >= quantity) {
      console.log(`${quantity}GO Generated!`);
      callback()
      break;
    }
  }
}

function cleanBucket(bucketName, callback) {
  
  s3.listFiles(bucketName, (err, resp) => {
    if (err) {
      return callback(err.toString());
    }
    if (resp.statusCode !== 200) {
      return callback("Listing failed, status returned " + resp.statusCode);
    }
    if (!resp?.body?.contents) {
        return callback();
    }
    s3.deleteFiles(bucketName, resp.body?.contents, (err, resp) => {
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

function uploadDataSet(bucketName, dataSetName) {
  const files = fs.readdirSync(path.join(__dirname, `${dataSetName}GO`));

  cleanBucket(bucketName, (err) => {
    if (err) {
      return console.log("Clean bucket failed:" + err.toString());
    }
    execQueue(
      "upload-dataset",
      files,
      (fileName, next) => {
        s3.uploadFile(
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
      function (err, resp) {
        if (err) {
          console.log("Something went wrong:" + err.toString());
        }
        console.log("Upload done!");
      }
    );
  });
}

const mode = process?.env?.npm_config_mode;
const size = parseInt(process?.env?.npm_config_size);
const bucketName = process?.env?.npm_config_bucket;

if (!bucketName) {
    console.log("Missing bucket name, pass the option --bucket=name");
    process.exit();
}

if (mode === "generate") {
    if (isNaN(size) === true) {
        console.log("Invalid or missing size argument, pass the option --size=2, the unit is GB");
        process.exit();
    }
    console.log(`🟢 Generating ${size}GB of data-set into "${bucketName}"`);

    s3.headBucket(bucketName, (err, resp) => {
        if (err) {
            console.log("Head bucket error: " + err.toString())
            process.exit();
        }
        if (resp.statusCode !== 200) {
            console.log("Head bucket status error: " + resp.statusCode)
            process.exit();
        }
        console.log(`🟢 Bucket accessible ${bucketName}`);
        generateDataSet(size, () => {
            uploadDataSet(bucketName, size)
        });
    })

} else if (mode === 'clean') {
    cleanBucket(bucketName, (err) => {
        if (err) {
            console.log("Something went wrong:" + err.toString());
            process.exit();
        }
        console.log("🟢 Done")
    });
} else {
    console.log("Missing mode option, add the to command: --mode=value. The value can be: generate or clean");
}

/**
 * COMMANDS:
 * - npm run bench --mode=clean --bucket=name
 * - npm run bench --mode=generate --size=1 --bucket=templates
 */