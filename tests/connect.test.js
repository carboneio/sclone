const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');
const sclone = require('../sclone.js');
const helper = require('../helper');
const { captureLogs } = require('./support/logs');

/**
 * Connection of the storages at the start of a run: source and target are connected in parallel. Each side is a local
 * Swift-like server whose authentication answers after a delay (`authDelay`), with a 401 if `fail` is set.
 */
describe('Storages connection (parallel)', function () {
  this.timeout(10000);
  const DELAY = 300;
  let logs = null;
  let _dir = '';
  let _configPath = '';
  const _sides = {};

  function createSide (callback) {
    const _side = { authDelay: 0, fail: false, auths: 0, listings: 0, url: '' };
    _side.server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/v3/auth/tokens') {
        _side.auths++;
        return setTimeout(() => {
          if (_side.fail === true) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            return res.end('{"error":{"code":401}}');
          }
          res.writeHead(201, { 'Content-Type': 'application/json', 'X-Subject-Token': 'token' });
          res.end(JSON.stringify({ token: { catalog: [{ type: 'object-store', endpoints: [{ region: 'GRA', interface: 'public', url: _side.url + '/swift' }] }] } }));
        }, _side.authDelay);
      }
      _side.listings++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
    });
    _side.server.listen(0, '127.0.0.1', () => {
      _side.url = `http://127.0.0.1:${_side.server.address().port}`;
      callback(_side);
    });
    return _side;
  }

  before(function (done) {
    createSide((source) => {
      _sides.source = source;
      createSide((target) => {
        _sides.target = target;
        done();
      });
    });
  });

  after(function (done) {
    _sides.source.server.close(() => _sides.target.server.close(done));
  });

  beforeEach(function () {
    _dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sclone-connect-'));
    for (const _side of Object.values(_sides)) {
      Object.assign(_side, { authDelay: DELAY, fail: false, auths: 0, listings: 0 });
    }
    const _storage = (side) => ({ name: 'swift', authUrl: _sides[side].url + '/v3', username: 'user', password: 'password', tenantName: 'tenant', region: 'GRA', bucket: side });
    const _config = { test: true, mode: 'unidirectional', retry: 0, listRetry: 0, retryDelay: 0, cacheFilename: path.join(_dir, 'cache.json'), source: _storage('source'), target: _storage('target') };
    _configPath = path.join(_dir, 'config.json');
    fs.writeFileSync(_configPath, JSON.stringify(_config));
    process.env.SCLONE_CONFIG = _configPath;
    delete process.env.SCLONE_CRON;
    logs = captureLogs();
  });

  afterEach(function () {
    logs.restore();
    fs.rmSync(_dir, { recursive: true, force: true });
  });

  function lockExists () {
    const _config = JSON.parse(fs.readFileSync(_configPath));
    return fs.existsSync(helper.lockPath(_config));
  }

  /** Time between the start of sclone and its callback, with its error */
  function run (callback) {
    const _start = Date.now();
    sclone((err) => callback(err, Date.now() - _start));
  }

  it('should connect both storages in parallel: the run waits for the slowest side, not for the sum', function (done) {
    _sides.target.authDelay = DELAY + 100;
    run((err, elapsed) => {
      assert.strictEqual(err, undefined);
      assert.strictEqual(_sides.source.auths, 1);
      assert.strictEqual(_sides.target.auths, 1);
      assert.strictEqual(_sides.source.listings + _sides.target.listings > 0, true);
      /** Sequential: 300 + 400 ms */
      assert.strictEqual(elapsed >= DELAY + 100, true, `elapsed ${elapsed}`);
      assert.strictEqual(elapsed < 2 * DELAY + 100, true, `elapsed ${elapsed}`);
      assert.strictEqual(logs.filter('storage_connect_failed').length, 0);
      assert.deepStrictEqual(logs.filter('sync_end').map((line) => line.status), ['success']);
      assert.strictEqual(lockExists(), false);
      done();
    });
  });

  it('should log both failures, source then target, and return the source error, without starting the synchronisation', function (done) {
    _sides.source.fail = true;
    _sides.target.fail = true;
    /** The target fails first: the order of the lines does not depend on the order of the answers */
    _sides.source.authDelay = DELAY + 100;
    run((err, elapsed) => {
      assert.strictEqual(typeof err, 'string');
      assert.strictEqual(err.startsWith('[SWIFT source] Connexion error'), true, err);
      assert.strictEqual(elapsed < 2 * DELAY + 100, true, `elapsed ${elapsed}`);
      const _failed = logs.filter('storage_connect_failed');
      assert.deepStrictEqual(_failed.map((line) => line.side), ['source', 'target']);
      assert.deepStrictEqual(_failed.map((line) => line.level), ['error', 'error']);
      assert.strictEqual(_failed[0].error, err);
      assert.strictEqual(_failed[1].error.startsWith('[SWIFT target] Connexion error'), true);
      assert.strictEqual(_sides.source.listings + _sides.target.listings, 0);
      const _end = logs.filter('sync_end');
      assert.deepStrictEqual(_end.map((line) => line.status), ['failed']);
      assert.strictEqual(_end[0].error, err);
      assert.strictEqual(logs.events().findIndex((line) => line.event === 'sync_end') > logs.events().findIndex((line) => line.side === 'target' && line.event === 'storage_connect_failed'), true);
      assert.strictEqual(lockExists(), false);
      done();
    });
  });

  for (const side of ['source', 'target']) {
    it(`should fail the run when only the ${side} cannot be connected, without starting the synchronisation`, function (done) {
      _sides[side].fail = true;
      run((err) => {
        assert.strictEqual(err.startsWith(`[SWIFT ${side}] Connexion error`), true, err);
        const _failed = logs.filter('storage_connect_failed');
        assert.deepStrictEqual(_failed.map((line) => line.side), [side]);
        assert.strictEqual(_failed[0].error, err);
        assert.strictEqual(_sides.source.auths + _sides.target.auths, 2);
        assert.strictEqual(_sides.source.listings + _sides.target.listings, 0);
        assert.deepStrictEqual(logs.filter('sync_end').map((line) => line.status), ['failed']);
        assert.strictEqual(lockExists(), false);
        done();
      });
    });
  }

  it('should end the run as interrupted and release the lock on a stop signal during the connection', function (done) {
    _sides.source.fail = true;
    _sides.target.fail = true;
    let _called = false;
    sclone(() => {
      _called = true;
    });
    setTimeout(() => {
      assert.strictEqual(lockExists(), true);
      sclone.interrupt('SIGTERM');
      assert.strictEqual(lockExists(), false);
      const _end = logs.filter('sync_end');
      assert.deepStrictEqual(_end.map((line) => line.status), ['interrupted']);
      assert.strictEqual(_end[0].signal, 'SIGTERM');
      assert.strictEqual(_end[0].run, logs.filter('sync_start')[0].run);
      /** The connections answer after the signal: no second `sync_end`, no callback */
      setTimeout(() => {
        assert.strictEqual(logs.filter('sync_end').length, 1);
        assert.strictEqual(_called, false);
        assert.strictEqual(lockExists(), false);
        done();
      }, DELAY);
    }, DELAY / 3);
  });
});
