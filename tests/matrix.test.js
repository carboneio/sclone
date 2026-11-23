/**
 * Offline sync matrix: every pair of storage profiles, in both modes, against in-memory fake S3 and Swift servers
 * (tests/support/fakeStorage.js). The profiles reproduce behaviours observed on real S3-compatible and Swift providers.
 * sclone runs through its real entry, with a written configuration. No network, no credentials.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const nock = require('nock');
const sclone = require('../sclone.js');
const { captureLogs } = require('./support/logs');
const { createFakeStorage, PROFILES, md5 } = require('./support/fakeStorage');

const NAMES = Object.keys(PROFILES);
const UNI = 'unidirectional';
const BI = 'bidirectional';
/** Raw UTF-8 values are sent as their bytes by the fake server; the others are already percent-encoded */
const META = { label: encodeURIComponent('Remise été 50% €'), pct: '50% off', plain: 'hello', raw: 'Prix 50% € été' };
const META_TEXT = { label: 'Remise été 50% €', pct: '50% off', plain: 'hello', raw: 'Prix 50% € été' };
/** Decode a metadata value, a lone "%" is kept */
const decodeMeta = (value) => decodeURIComponent(String(value).replace(/%(?![0-9A-Fa-f]{2})/g, '%25'));

/** Deterministic bytes */
function bytes (seed, length) {
  const _chunks = [];
  for (let h = Buffer.from(seed), n = 0; n < length; n += 32) {
    h = crypto.createHash('sha256').update(h).digest();
    _chunks.push(h);
  }
  return Buffer.concat(_chunks).subarray(0, length);
}

/** The files of a pair: small, empty, large (multipart / SLO by profile), gzip, unicode and special keys, metadata */
function dataset () {
  const _files = [];
  for (const n of ['a', 'b', 'c', 'd', 'e']) {
    _files.push({ key: `d1/${n}.txt`, body: Buffer.from(`file ${n} v0\n`) });
  }
  for (const n of ['f1', 'f2', 'f3']) {
    _files.push({ key: `d2/sub/${n}.txt`, body: Buffer.from(`sub ${n} v0 ` + 'x'.repeat(100)) });
  }
  _files.push({ key: 'empty.txt', body: Buffer.alloc(0) });
  _files.push({ key: 'big/large.bin', body: bytes('large', 12 * 1024 + 123), large: true });
  _files.push({ key: 'gz/data.json', body: zlib.gzipSync(JSON.stringify({ hello: 'wörld €', n: [...Array(50).keys()] })), headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } });
  for (const key of ['unicode/été €uro 日本語.txt', 'unicode/emoji-😀.txt', 'unicode/Ünïcödé/ß.txt', 'unicode/emoji-～.txt', 'special/a+b=c&d.txt', 'special/space name (1).txt', 'special/percent%20literal.txt', 'special/hash#q?x.txt', 'special/quote\'"<>.txt', 'special/0001', 'special/semi;colon,comma@at$dollar.txt', 'special/tilde~star*.txt']) {
    _files.push({ key, body: Buffer.from('content of ' + key) });
  }
  _files.push({ key: 'meta/with-meta.txt', body: Buffer.from('metadata carrier €'), meta: true, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'max-age=60', 'content-disposition': 'attachment; filename="x.txt"' } });
  return _files;
}

function seed (bucket, files) {
  for (const file of files) {
    const _headers = { ...file.headers };
    if (file.meta === true) {
      for (const [name, value] of Object.entries(META)) {
        _headers[(bucket.api === 's3' ? 'x-amz-meta-' : 'x-object-meta-') + name] = value;
      }
    }
    bucket.write(file.key, file.body, _headers, file.large === true);
  }
}

/** The bucket holds exactly the expected keys (Map key → body), byte for byte */
function assertContent (bucket, expected) {
  assert.deepStrictEqual(bucket.keys(), [...expected.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))), `keys of ${bucket.profile}`);
  for (const [key, body] of expected) {
    assert.strictEqual(md5(bucket.objects.get(key).body), md5(body), `${bucket.profile} ${key}`);
  }
}

/** Headers of the copies: gzip encoding, standard headers and UTF-8 metadata with "%" and "€" */
function assertHeaders (bucket) {
  const _gz = bucket.objects.get('gz/data.json').headers;
  assert.deepStrictEqual([_gz['content-encoding'], _gz['content-type']], ['gzip', 'application/json'], bucket.profile);
  const _meta = bucket.objects.get('meta/with-meta.txt').headers;
  const _prefix = bucket.api === 's3' ? 'x-amz-meta-' : 'x-object-meta-';
  for (const [name, text] of Object.entries(META_TEXT)) {
    assert.match(_meta[_prefix + name], /^[\x20-\x7e]*$/, 'an ASCII header value');
    assert.strictEqual(decodeMeta(_meta[_prefix + name]), text, `${bucket.profile} meta ${name}`);
  }
  assert.deepStrictEqual([_meta['content-type'], _meta['cache-control'], _meta['content-disposition']], ['text/plain; charset=utf-8', 'max-age=60', 'attachment; filename="x.txt"']);
}

function assertEnd (result, expected) {
  const _end = result.end;
  assert.deepStrictEqual({ status: _end.status, uploaded: _end.uploaded, deleted: _end.deleted, failed: _end.failed }, { failed: 0, ...expected }, result.summary());
}

describe('Matrix (offline, fake storages)', function () {
  this.timeout(10000);
  const fake = createFakeStorage();
  const env = {};
  let nockWasActive = false;

  before(function (done) {
    /** Real local HTTP: nock is deactivated during the matrix */
    nockWasActive = nock.isActive();
    nock.restore();
    for (const name of ['SCLONE_CONFIG', 'SCLONE_CRON', 'SCLONE_LOG_LEVEL', 'SCLONE_NAME']) {
      env[name] = process.env[name];
      delete process.env[name];
    }
    fake.start(done);
  });

  after(function (done) {
    for (const [name, value] of Object.entries(env)) {
      value === undefined ? delete process.env[name] : process.env[name] = value;
    }
    if (nockWasActive === true) {
      nock.activate();
    }
    fake.stop(done);
  });

  /** Fresh buckets and cache directory: returns the pair context */
  function setup (mode, profileA, profileB) {
    fake.reset();
    const _dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sclone-matrix-'));
    const _ctx = { mode, A: fake.bucket('src', profileA), B: fake.bucket('dst', profileB), dir: _dir, failed: false, configPath: path.join(_dir, 'config.json') };
    fs.writeFileSync(_ctx.configPath, JSON.stringify({
      test: true, mode, delete: true, retry: 1, retryDelay: 0, listRetryDelay: 1, transfers: 8, logLevel: 'debug', name: 'matrix',
      cacheFilename: path.join(_dir, 'matrix.cache.json'), source: fake.config(_ctx.A), target: fake.config(_ctx.B)
    }));
    return _ctx;
  }

  /** One run of sclone: its `sync_end`, its events, and the requests received by each side */
  function run (ctx) {
    const _before = { A: { ...ctx.A.counts }, B: { ...ctx.B.counts } };
    const _logs = captureLogs();
    process.env.SCLONE_CONFIG = ctx.configPath;
    return new Promise((resolve) => sclone(() => {
      _logs.restore();
      delete process.env.SCLONE_CONFIG;
      const _events = _logs.events();
      const _delta = (side) => Object.fromEntries(Object.entries(ctx[side].counts).map(([m, n]) => [m, n - (_before[side][m] ?? 0)]).filter(([, n]) => n > 0));
      resolve({
        end    : _events.find((line) => line.event === 'sync_end'),
        events : (name) => _events.filter((line) => line.event === name),
        counts : { A: _delta('A'), B: _delta('B') },
        summary: () => _logs.lines.filter((line) => / level=(warn|error) | event=sync_(end|plan) /.test(line)).join('')
      });
    }));
  }

  /** The `it` of a step: skipped once a previous step of the pair failed, the rest would only repeat its failure */
  function step (getCtx, title, fn) {
    it(title, async function () {
      const _ctx = getCtx();
      if (_ctx.failed === true) {
        this.skip();
      }
      try {
        await fn(_ctx);
      } catch (err) {
        _ctx.failed = true;
        throw err;
      }
    });
  }

  /** Expected content of both sides after each step: key → body */
  const expectedOf = (files) => new Map(files.map((file) => [file.key, file.body]));

  function idempotence (ctx) {
    return run(ctx).then((result) => {
      assertEnd(result, { status: 'success', uploaded: 0, deleted: 0 });
      assert.deepStrictEqual(result.events('etag_resolved'), [], 'no etag resolved');
      assert.strictEqual((result.counts.A.HEAD ?? 0) + (result.counts.B.HEAD ?? 0), 0, 'no HEAD: ' + JSON.stringify(result.counts));
      assert.strictEqual((result.counts.A.PUT ?? 0) + (result.counts.B.PUT ?? 0), 0, 'no PUT');
    });
  }

  /** Pairs of the guard: each profile is the emptied side once and the other side once */
  const isGuardPair = (i, j) => j - i === 1 || (i === 0 && j === NAMES.length - 1);

  const pairs = [];
  NAMES.forEach((a, i) => NAMES.forEach((b, j) => i !== j && pairs.push([UNI, a, b, (j - i + NAMES.length) % NAMES.length === 1])));
  NAMES.forEach((a, i) => NAMES.forEach((b, j) => i < j && pairs.push([BI, a, b, isGuardPair(i, j)])));

  for (const [mode, profileA, profileB, withGuard] of pairs) {
    describe(`${mode} ${profileA} ${mode === UNI ? '→' : '↔'} ${profileB}`, function () {
      let ctx = null;
      let exp = null;
      const getCtx = () => ctx;
      before(function () {
        ctx = setup(mode, profileA, profileB);
      });
      after(function () {
        fs.rmSync(ctx.dir, { recursive: true, force: true });
      });

      step(getCtx, 'first_sync', async ({ A, B }) => {
        const _files = dataset();
        exp = expectedOf(_files);
        if (mode === UNI) {
          seed(A, _files);
        } else {
          seed(A, _files.filter((file) => file.key.startsWith('d2/') === false));
          seed(B, _files.filter((file) => file.key.startsWith('d2/') === true));
        }
        const _result = await run(ctx);
        assertEnd(_result, { status: 'success', uploaded: _files.length, deleted: 0 });
        assertContent(A, exp);
        assertContent(B, exp);
        assertHeaders(B);
      });

      step(getCtx, 'idempotence', idempotence);

      step(getCtx, 'modify, delete and add on each side', async (ctx) => {
        const { A, B } = ctx;
        const _a = Buffer.from('a modified on the source side\n');
        const _c = Buffer.from('c modified on the target side\n');
        A.write('d1/a.txt', _a);
        A.remove('d1/b.txt');
        A.write('new/added-A.txt', Buffer.from('added on A'));
        B.write('d1/c.txt', _c);
        B.remove('d1/d.txt');
        B.write('new/added-B.txt', Buffer.from('added on B'));
        exp.set('d1/a.txt', _a);
        exp.delete('d1/b.txt');
        exp.set('new/added-A.txt', Buffer.from('added on A'));
        if (mode === UNI) {
          /** The source wins: c restored, d copied again, added-B is a real deletion of the target-only file */
          exp.delete('new/added-B.txt');
        } else {
          exp.set('d1/c.txt', _c);
          exp.delete('d1/d.txt');
          exp.set('new/added-B.txt', Buffer.from('added on B'));
        }
        const _result = await run(ctx);
        assertEnd(_result, { status: 'success', uploaded: 4, deleted: 2 });
        assertContent(A, exp);
        assertContent(B, exp);
        /** Only the real deletions: each deleted key was confirmed missing by a HEAD on the other side */
        assert.strictEqual((_result.counts.A.HEAD ?? 0) + (_result.counts.B.HEAD ?? 0), 2, JSON.stringify(_result.counts));
        assert.deepStrictEqual(_result.events('deletion_skipped'), []);
      });

      step(getCtx, 'idempotence after the changes', idempotence);

      if (mode === BI) {
        /** One run for both conflicts (f1 modified on both sides, f2 and f3 deleted on one side, modified on the other) */
        let conflicts = null;
        const conflictOf = (key) => conflicts.events('sync_conflict').filter((line) => line.key === key).map((line) => [line.reason, line.winner]);

        step(getCtx, 'conflict: both modified, the newest wins', async (ctx) => {
          const _newer = Buffer.from('f1 modified on B later, newer');
          const _f2 = Buffer.from('f2 modified on B');
          const _f3 = Buffer.from('f3 modified on A');
          ctx.A.write('d2/sub/f1.txt', Buffer.from('f1 modified on A first'));
          ctx.B.write('d2/sub/f1.txt', _newer);
          ctx.A.remove('d2/sub/f2.txt');
          ctx.B.write('d2/sub/f2.txt', _f2);
          ctx.A.write('d2/sub/f3.txt', _f3);
          ctx.B.remove('d2/sub/f3.txt');
          exp.set('d2/sub/f1.txt', _newer);
          exp.set('d2/sub/f2.txt', _f2);
          exp.set('d2/sub/f3.txt', _f3);
          conflicts = await run(ctx);
          assertEnd(conflicts, { status: 'success', uploaded: 3, deleted: 0 });
          assert.strictEqual(conflicts.events('sync_conflict').length, 3);
          assert.deepStrictEqual(conflictOf('d2/sub/f1.txt'), [['both_modified', 'target']]);
          assert.strictEqual(md5(ctx.A.objects.get('d2/sub/f1.txt').body), md5(_newer));
          assert.strictEqual(md5(ctx.B.objects.get('d2/sub/f1.txt').body), md5(_newer));
        });

        step(getCtx, 'conflict: delete vs modify keeps the modified file', async (ctx) => {
          assert.deepStrictEqual(conflictOf('d2/sub/f2.txt'), [['deleted_modified', 'target']]);
          assert.deepStrictEqual(conflictOf('d2/sub/f3.txt'), [['deleted_modified', 'source']]);
          assertContent(ctx.A, exp);
          assertContent(ctx.B, exp);
        });

        step(getCtx, 'idempotence after the conflicts', idempotence);
      }

      if (withGuard === true) {
        step(getCtx, 'guard_empty_side: an emptied side deletes nothing', async (ctx) => {
          for (const key of ctx.A.keys()) {
            ctx.A.remove(key);
          }
          const _result = await run(ctx);
          assert.strictEqual(_result.end.status, 'failed');
          assert.strictEqual(_result.end.deleted, 0);
          assert.deepStrictEqual(_result.events('deletion_refused').map((line) => line.reason), ['empty_side']);
          assert.deepStrictEqual(ctx.A.keys(), [], 'nothing uploaded to the empty side');
          assertContent(ctx.B, exp);
        });
      }

      if (mode === UNI && PROFILES[profileA].opaqueCopies === true) {
        /** Production fix: the opaque etags are resolved once by HEAD, identical files are not uploaded, the next run does no HEAD */
        it('opaque etags: resolved by HEAD on the first run only, identical files not uploaded', async function () {
          fs.rmSync(ctx.dir, { recursive: true, force: true });
          ctx = setup(mode, profileA, profileB);
          const _files = dataset().filter((file) => file.large !== true);
          const _differ = { key: 'd1/differ.txt', body: Buffer.from('same size, source') };
          seed(ctx.A, [..._files, _differ]);
          seed(ctx.B, [..._files, { key: _differ.key, body: Buffer.from('same size, target') }]);
          const _opaque = ctx.A.keys().filter((key) => /^[0-9a-f]{64}$/.test(ctx.A.objects.get(key).listEtag)).length;
          assert.strictEqual(_opaque, _files.length + 1, 'every seeded object is listed with an opaque etag');
          const _first = await run(ctx);
          assertEnd(_first, { status: 'success', uploaded: 1, deleted: 0 });
          const _resolved = _first.events('etag_resolved');
          assert.strictEqual(_resolved.length, 1);
          assert.strictEqual(_resolved[0].unresolved, 0);
          assert.strictEqual(_resolved[0].resolved, _opaque + (PROFILES[profileB].opaqueCopies === true ? _opaque : 0));
          assert.strictEqual(_first.counts.A.HEAD, _opaque, 'one HEAD per opaque object');
          assert.strictEqual(md5(ctx.B.objects.get(_differ.key).body), md5(_differ.body), 'the different file is copied');
          await idempotence(ctx);
        });
      }
    });
  }

  /** An object deleted between the listing and its download: skipped (`transfer_skipped reason=source_gone`), never a failure */
  describe('object deleted after the listing (download 404)', function () {
    const _files = [{ key: 'a.txt', body: Buffer.from('a') }, { key: 'gone.txt', body: Buffer.from('gone v1') }];

    it('unidirectional: skipped, the run succeeds, the next run has nothing to do', async function () {
      const _ctx = setup(UNI, 's3-md5', 'swift');
      seed(_ctx.A, _files);
      _ctx.A.vanishOnGet.add('gone.txt');
      const _first = await run(_ctx);
      assertEnd(_first, { status: 'success', uploaded: 1, deleted: 0 });
      assert.strictEqual(_first.end.skipped, 1);
      assert.deepStrictEqual(_first.events('transfer_failed'), []);
      assert.deepStrictEqual(_first.events('transfer_skipped').map((l) => [l.level, l.key, l.phase, l.status, l.reason, l.direction]), [['warn', 'gone.txt', 'download', 404, 'source_gone', 'source_to_target']]);
      assertContent(_ctx.B, expectedOf(_files.slice(0, 1)));
      const _second = await run(_ctx);
      assertEnd(_second, { status: 'success', uploaded: 0, deleted: 0 });
      assert.strictEqual(_second.end.skipped, 0);
      fs.rmSync(_ctx.dir, { recursive: true, force: true });
    });

    it('bidirectional: skipped with its cache kept, the next run deletes the other side only once confirmed by HEAD', async function () {
      const _ctx = setup(BI, 'swift', 's3-sse-opaque');
      seed(_ctx.A, _files);
      seed(_ctx.B, _files);
      assertEnd(await run(_ctx), { status: 'success', uploaded: 0, deleted: 0 });
      const _cache = fs.readFileSync(path.join(_ctx.dir, 'matrix.cache.json'), 'utf8');
      /** Modified on A, then deleted by another client after the listing: the copy to B is skipped */
      seed(_ctx.A, [{ key: 'gone.txt', body: Buffer.from('gone v2') }]);
      _ctx.A.vanishOnGet.add('gone.txt');
      const _second = await run(_ctx);
      assertEnd(_second, { status: 'success', uploaded: 0, deleted: 0 });
      assert.strictEqual(_second.end.skipped, 1);
      assert.deepStrictEqual(_second.events('transfer_skipped').map((l) => [l.key, l.reason, l.direction]), [['gone.txt', 'source_gone', 'source_to_target']]);
      assertContent(_ctx.B, expectedOf(_files));
      assert.strictEqual(fs.readFileSync(path.join(_ctx.dir, 'matrix.cache.json'), 'utf8').split('\n').find((l) => l.includes('gone.txt')), _cache.split('\n').find((l) => l.includes('gone.txt')), 'cache of the skipped key unchanged');
      /** Gone from A, unchanged on B since the last synchronisation: deleted from B after a HEAD 404 on A */
      const _third = await run(_ctx);
      assertEnd(_third, { status: 'success', uploaded: 0, deleted: 1 });
      assert.strictEqual(_third.counts.A.HEAD >= 1, true, 'deletion confirmed by HEAD');
      assertContent(_ctx.A, expectedOf(_files.slice(0, 1)));
      assertContent(_ctx.B, expectedOf(_files.slice(0, 1)));
      await idempotence(_ctx);
      fs.rmSync(_ctx.dir, { recursive: true, force: true });
    });
  });
});
