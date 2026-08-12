const sclone = require('./sclone');
const helper = require('./helper');

sclone((err) => {
  if (err) {
    return helper.stop(err.toString());
  }
});