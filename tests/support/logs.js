const logger = require('../../logger');

const PAIR = /([a-z0-9_]+)=("(?:[^"\\]|\\.)*"|[^ ]*)/g;
/** Fields written by the logger itself are always strings: a random run id such as "66836152" must not become a number */
const STRING_KEYS = new Set(['ts', 'level', 'job', 'run', 'event', 'msg']);

/** Parse one logfmt line into an object: quoted values are unescaped, numbers and booleans converted */
function parseLine (line) {
  const _fields = {};
  for (const [, key, raw] of line.trimEnd().matchAll(PAIR)) {
    let _value = raw.startsWith('"') ? JSON.parse(raw) : raw;
    if (STRING_KEYS.has(key) === true) {
      _fields[key] = _value;
      continue;
    }
    if (raw.startsWith('"') === false && /^-?\d+(\.\d+)?$/.test(raw)) {
      _value = Number(raw);
    } else if (raw === 'true' || raw === 'false') {
      _value = raw === 'true';
    }
    _fields[key] = _value;
  }
  return _fields;
}

/** Capture the lines of the logger instead of writing them to stdout. The level is reset (info or SCLONE_LOG_LEVEL) */
function captureLogs () {
  const _lines = [];
  logger.setup({});
  logger.setOutput((line) => _lines.push(line));
  return {
    lines  : _lines,
    events : () => _lines.map(parseLine),
    filter : (event) => _lines.map(parseLine).filter((line) => line.event === event),
    restore: () => logger.setOutput(null)
  };
}

module.exports = {
  parseLine,
  captureLogs
};
