const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { parseLine } = require('./support/logs');

const INDEX = path.join(__dirname, '..', 'index.js');

/**
 * Stop signals on the real entry point: a child process synchronises against a local S3 server which never answers
 * (unless `_answer`), so the run is always in progress when the signal arrives.
 */
describe('stop signals (SIGTERM, SIGINT)', function () {
  this.timeout(10000);
  /** Windows has no POSIX signals: `child.kill(signal)` terminates the process at once, its handlers never run */
  if (process.platform === 'win32') {
    return it.skip('POSIX stop signals: not available on Windows');
  }
  let _server = null;
  let _url = '';
  let _dir = '';
  let _requests = 0;
  /** Called on each request received by the server */
  let _onRequest = () => {};
  /** The connection of a storage gets an empty bucket, instead of no answer */
  let _answer = false;

  before(function (done) {
    _server = http.createServer((req, res) => {
      _requests++;
      if (_answer === true) {
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        return res.end('<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>b</Name><KeyCount>0</KeyCount><IsTruncated>false</IsTruncated></ListBucketResult>');
      }
      _onRequest();
    });
    _server.listen(0, '127.0.0.1', () => {
      _url = `http://127.0.0.1:${_server.address().port}`;
      done();
    });
  });

  after(function (done) {
    _server.closeAllConnections();
    _server.close(done);
  });

  beforeEach(function () {
    _dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sclone-signal-'));
    _requests = 0;
    _onRequest = () => {};
    _answer = false;
  });

  afterEach(function () {
    _server.closeAllConnections();
    fs.rmSync(_dir, { recursive: true, force: true });
  });

  /** Start sclone in its own directory, `onLine` is called with each parsed line, `callback` with the exit code and the lines */
  function startSclone (options, onLine, callback) {
    const _storage = (bucket) => ({ name: 's3', accessKeyId: 'id', secretAccessKey: 'secret', url: _url, region: 'gra', bucket });
    const _config = { mode: 'unidirectional', retry: 0, listRetry: 0, source: _storage('source'), target: _storage('target'), ...options };
    fs.writeFileSync(path.join(_dir, 'config.json'), JSON.stringify(_config));
    const _child = spawn(process.execPath, [INDEX], { cwd: _dir, env: { ...process.env, SCLONE_CONFIG: 'config.json', SCLONE_NAME: 'signal-test', SCLONE_LOG_LEVEL: 'info', SCLONE_CRON: '' } });
    const _lines = [];
    let _rest = '';
    _child.stdout.on('data', (chunk) => {
      const _parts = (_rest + chunk).split('\n');
      _rest = _parts.pop();
      for (const _part of _parts) {
        const _line = parseLine(_part);
        _lines.push(_line);
        onLine(_line, _child);
      }
    });
    _child.on('close', (code, signal) => callback(code, signal, _lines));
    return _child;
  }

  function lockFiles () {
    return fs.readdirSync(_dir).filter((file) => file.endsWith('.lock'));
  }

  for (const [_signal, _code] of [['SIGTERM', 143], ['SIGINT', 130]]) {
    it(`should end the run in progress with sync_end status=interrupted, release the lock and exit with ${_code} on ${_signal}`, function (done) {
      /** The listing has started: the run is in progress, with its lock */
      _onRequest = () => {
        if (_requests === 1) {
          assert.strictEqual(lockFiles().length, 1);
          _child.kill(_signal);
        }
      };
      fs.writeFileSync(path.join(_dir, 'previous.cache.json'), 'previous');
      const _child = startSclone({ cacheFilename: 'previous.cache.json' }, () => {}, (code, signal, lines) => {
        assert.strictEqual(signal, null);
        assert.strictEqual(code, _code);
        const _last = lines[lines.length - 1];
        assert.strictEqual(_last.event, 'sync_end');
        assert.strictEqual(_last.level, 'warn');
        assert.strictEqual(_last.status, 'interrupted');
        assert.strictEqual(_last.signal, _signal);
        assert.strictEqual(typeof _last.duration_ms, 'number');
        assert.deepStrictEqual([_last.uploaded, _last.deleted, _last.failed], [0, 0, 0]);
        assert.strictEqual(_last.run, lines.find((line) => line.event === 'sync_start').run);
        assert.strictEqual(lines.filter((line) => line.event === 'sync_end').length, 1);
        assert.deepStrictEqual(lockFiles(), []);
        /** The previous cache is kept, nothing else is written */
        assert.strictEqual(fs.readFileSync(path.join(_dir, 'previous.cache.json'), 'utf8'), 'previous');
        assert.deepStrictEqual(fs.readdirSync(_dir).sort(), ['config.json', 'previous.cache.json']);
        done();
      });
    });
  }

  it('should write a single shutdown line and exit with 143 on SIGTERM between two cron runs', function (done) {
    _answer = true;
    startSclone({ cron: '0 0 1 1 *' }, (line, child) => {
      if (line.event === 'cron_scheduled') {
        child.kill('SIGTERM');
      }
    }, (code, signal, lines) => {
      assert.strictEqual(code, 143);
      const _last = lines[lines.length - 1];
      assert.strictEqual(_last.event, 'shutdown');
      assert.strictEqual(_last.signal, 'SIGTERM');
      assert.strictEqual(_last.run, undefined);
      assert.strictEqual(lines.some((line) => line.event === 'sync_end'), false);
      done();
    });
  });
});
