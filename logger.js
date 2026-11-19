const crypto = require('crypto');
const path = require('path');

/**
 * Structured logs: one logfmt line per event, written to stdout with a single write
 * `ts=<ISO UTC> level=<level> job=<job> run=<run> event=<event> msg="<text>" key=value ...`
 * Designed for journald → Loki (`| logfmt`): see docs/grafana.md
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const DEFAULT_LEVEL = 'info';
/** A value longer than this (once escaped) is truncated with `…`: a log line must stay readable and bounded */
const MAX_VALUE_LENGTH = 2048;
/**
 * The fields which do not fit in this length are dropped, and `truncated=true` is added: at most 48 000 bytes of UTF-8,
 * under the journald limit (`LineMax`, 48K), beyond which a line is split and no longer parsed by Loki
 */
const MAX_LINE_LENGTH = 16000;
const TRUNCATED = ' truncated=true';
/** Keys written by the logger itself: a field with the same name is ignored */
const RESERVED_KEYS = new Set(['ts', 'level', 'job', 'run', 'event', 'msg', 'truncated']);
/** Written as `\uXXXX`: control characters (C0, DEL, C1), line separators and bidirectional controls (a misleading display) */
const UNSAFE_CHARS = '\\u0000-\\u001f\\u007f-\\u009f\\u200e\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069';
/** A value written without quotes: not empty, no space, `=`, `"`, `\` or unsafe character */
const BARE_VALUE = new RegExp(`^[^\\s="\\\\${UNSAFE_CHARS}]+$`);
const ESCAPED_CHARS = new RegExp(`[\\\\"${UNSAFE_CHARS}]`, 'g');
const ESCAPES = { '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t' };
/**
 * Defense in depth: a secret passed as a URL query, a `key=value`, a header (`X-Auth-Token: tok`, `password: "x"`) or an
 * `Authorization: Bearer x` / `Authorization: AWS4-HMAC-SHA256 Credential=..., SignedHeaders=..., Signature=...` header never
 * reaches the logs. One scan, linear: no nested ambiguous quantifier
 */
const SECRETS = /\b(?:(authorization\s*[:=]\s*)(?:(?:bearer|basic|aws4-hmac-sha256|aws)[ \t]+)?[^\s",&]+(?:,[ \t]*[^\s",&]+)*|(x-amz-signature|x-amz-credential|x-amz-security-token|signature|awsaccesskeyid|temp_url_sig|x-auth-token|aws_secret_access_key|secret_?access_?key|password|secret|token)(=|:[ \t]*"?)[^&\s"]+)/gi;
/** Same for a JSON-like `"secretAccessKey": "value"` (a serialized configuration or storage response): the key name is checked apart */
const JSON_PAIRS = /("[\w-]*"\s*:\s*")(?:[^"\\]|\\.)*\\?(?:"|$)/g;
const SECRET_NAMES = /secret|password|token|signature|accesskey|credential|stringtosign|authorization/i;
/**
 * Free-text fields which can quote a URL, a header or a response: the secrets are redacted. Never the
 * identifier fields (`key`, `bucket`, `path`...): an object key containing `token=` must be logged as is.
 */
const FREE_TEXT_KEYS = new Set(['msg', 'error', 'summary', 'reason', 'message']);
const NO_KEYS = [];

let threshold = LEVELS[DEFAULT_LEVEL];
let job = process.env.SCLONE_NAME || path.basename(process.cwd());
let run = null;
let output = defaultOutput;
let stdoutErrorHandled = false;

function defaultOutput (line) {
  if (stdoutErrorHandled === false) {
    /** Like console.log: a closed stdout (EPIPE) must not crash the synchronisation */
    stdoutErrorHandled = true;
    process.stdout.on('error', () => {});
  }
  process.stdout.write(line);
}

/**
 * Set the job name and the level threshold. The environment variables win over the configuration,
 * like `SCLONE_CRON`: several systemd units can share a configuration file with distinct names.
 *
 * @param {Object} options { name, logLevel }
 */
function setup (options) {
  job = process.env.SCLONE_NAME || options?.name || path.basename(process.cwd());
  const _level = String(process.env.SCLONE_LOG_LEVEL || options?.logLevel || DEFAULT_LEVEL).toLowerCase();
  threshold = LEVELS[_level] ?? LEVELS[DEFAULT_LEVEL];
  if (LEVELS[_level] === undefined) {
    log('warn', 'config_warning', `Invalid log level, "${DEFAULT_LEVEL}" is used`, { log_level: _level, accepted: Object.keys(LEVELS).join(',') });
  }
}

/** Start a synchronisation run: every next line carries a new short random `run` id, until endRun() */
function startRun () {
  run = crypto.randomBytes(4).toString('hex');
  return run;
}

function endRun () {
  run = null;
}

function formatKey (key) {
  return String(key).toLowerCase().replace(/[^a-z0-9_]/g, '_');
}

/** In a JSON value: a function is not logged as its source, an Error as its message and code only (never its cause, its headers...) */
function jsonReplacer (_key, value) {
  if (typeof value === 'function') {
    return '[function]';
  }
  return value instanceof Error ? { message: value.message, code: value.code } : value;
}

function escapeChar (char) {
  return ESCAPES[char] ?? '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0');
}

/** The first `end` characters, without a high surrogate cut from its pair */
function sliceChars (str, end) {
  const _code = str.charCodeAt(end - 1);
  return str.slice(0, _code >= 0xd800 && _code <= 0xdbff ? end - 1 : end);
}

/** Cut an escaped value to `max` characters at most, never inside an escape sequence (`\\`, `\"`, `\n`, `\u001b`...) */
function cutEscaped (str, max) {
  if (str.length <= max) {
    return str;
  }
  let _end = max;
  const _slash = str.lastIndexOf('\\', _end - 1);
  if (_slash > _end - 6) {
    /** In a run of backslashes, the escapes start at the first one, then every 2 characters */
    let _runStart = _slash;
    while (_runStart > 0 && str.charCodeAt(_runStart - 1) === 92) {
      _runStart--;
    }
    if ((_slash - _runStart) % 2 === 0 && _slash + (str[_slash + 1] === 'u' ? 6 : 2) > _end) {
      _end = _slash;
    }
  }
  return sliceChars(str, _end);
}

function redactSecrets (str) {
  return str.replace(SECRETS, '$1$2$3***').replace(JSON_PAIRS, (pair, head) => (SECRET_NAMES.test(head) === true ? head + '***"' : pair));
}

/**
 * @param {*} value
 * @param {Boolean} redact true (default): the secrets of a free-text value are redacted
 */
function formatValue (value, redact = true) {
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }
  let _str = '';
  if (typeof value === 'string') {
    _str = value;
  } else if (typeof value === 'function') {
    _str = '[function]';
  } else if (value instanceof Error || typeof value !== 'object') {
    _str = String(value);
  } else {
    /** Throws on a circular structure: caught by the caller */
    _str = JSON.stringify(value, jsonReplacer) ?? String(value);
  }
  /** Bounded first (escaping never shortens a value): the redaction and the escaping always run on a short string */
  const _cut = _str.length > MAX_VALUE_LENGTH;
  if (_cut === true) {
    _str = sliceChars(_str, MAX_VALUE_LENGTH);
  }
  if (redact === true) {
    _str = redactSecrets(_str);
  }
  if (_cut === false && BARE_VALUE.test(_str) === true) {
    return _str;
  }
  _str = _str.replace(ESCAPED_CHARS, escapeChar);
  /** Truncated once escaped: an escaped value can be 6 times longer */
  if (_cut === true || _str.length > MAX_VALUE_LENGTH) {
    _str = cutEscaped(_str, MAX_VALUE_LENGTH - 1) + '…';
  }
  return '"' + _str + '"';
}

function safeFormatValue (value, redact) {
  try {
    return formatValue(value, redact);
  } catch (_err) {
    return '"[unserializable]"';
  }
}

/** Formatted value of a field, null if the field is null or undefined. A throwing getter is caught like a throwing value */
function formatField (fields, key, redact) {
  try {
    const _value = fields[key];
    return _value === null || _value === undefined ? null : formatValue(_value, redact);
  } catch (_err) {
    return '"[unserializable]"';
  }
}

/**
 * Write one logfmt line. Never throws: a log must never stop a synchronisation.
 *
 * @param {String} level debug, info, warn, error
 * @param {String} event Stable snake_case name, the contract of the dashboards
 * @param {String} msg Human readable message
 * @param {Object} fields Flat object: strings, numbers, booleans. null and undefined values are omitted
 */
function log (level, event, msg, fields) {
  if (typeof level !== 'string' || LEVELS[level] === undefined) {
    level = 'info';
  }
  /** Small enough to be inlined: a filtered line costs nothing */
  if (LEVELS[level] >= threshold) {
    write(level, event, msg, fields);
  }
}

function write (level, event, msg, fields) {
  try {
    let _line = `ts=${new Date().toISOString()} level=${level} job=${formatValue(job, false)}`;
    if (run !== null) {
      _line += ` run=${run}`;
    }
    _line += ` event=${formatValue(formatKey(event), false)} msg=${safeFormatValue(msg ?? '', true)}`;
    /** Own keys only (never inherited ones). Two keys equal once sanitised (`Foo-Bar`, `foo_bar`): the first one wins */
    const _keys = typeof fields === 'object' && fields !== null ? Object.keys(fields) : NO_KEYS;
    const _names = [];
    let _truncated = false;
    for (let i = 0; i < _keys.length; i++) {
      const _name = formatKey(_keys[i]);
      if (_name === '' || RESERVED_KEYS.has(_name) === true || _names.includes(_name) === true) {
        continue;
      }
      const _value = formatField(fields, _keys[i], FREE_TEXT_KEYS.has(_name));
      if (_value === null) {
        continue;
      }
      _names.push(_name);
      if (_line.length + _name.length + _value.length + 2 > MAX_LINE_LENGTH - TRUNCATED.length) {
        _truncated = true;
        continue;
      }
      _line += ` ${_name}=${_value}`;
    }
    if (_truncated === true) {
      _line += TRUNCATED;
    }
    output(_line + '\n');
  } catch (_err) {
    /** Nothing else to do: logging must not crash the process */
  }
}

/**
 * Replace the output, for tests only
 * @param {Function} newOutput (line) => {}, null restores stdout
 */
function setOutput (newOutput) {
  output = newOutput ?? defaultOutput;
}

module.exports = {
  log,
  setup,
  startRun,
  endRun,
  setOutput,
  formatValue,
  LEVELS
};
