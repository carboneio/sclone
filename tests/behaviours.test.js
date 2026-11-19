/**
 * Behaviours learned from the real-provider campaigns (OVH, Scaleway, Swift, MinIO), frozen here so that no regression can
 * come back. The behaviours already frozen by the other test files are not repeated.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const nock = require('nock');
const logic = require('../logic');
const helper = require('../helper');
const storage = require('../storage');
const { captureLogs } = require('./support/logs');

const UNI = helper.MODES.UNI;
const BI = helper.MODES.BI;
const MD5_A = 'a'.repeat(32);
const MD5_B = 'b'.repeat(32);
const MULTIPART = 'b62e2a390d253298e9f061541ec39fc6-2';
/** OVH SSE-OMK object copied server-side (CopyObject): listed with a 64 hex etag, a new one on each copy */
const OPAQUE = 'e'.repeat(64);
const OPAQUE_2 = 'f'.repeat(64);
const T0 = 1760040726000;
const md5 = (data) => crypto.createHash('md5').update(data).digest('hex');

function file (key, etag, bytes = 10, lastmodified = T0) {
  return { key, md5: etag, bytes, lastmodified, cachedEtag: undefined, cachedBytes: undefined };
}

/** Cache entries of the listed objects: key → [sourceEtag, sourceBytes, targetEtag, targetBytes] */
function entriesOf (files) {
  const _entries = {};
  for (const key of new Set([...files.source.keys(), ...files.target.keys()])) {
    const _source = files.source.get(key);
    const _target = files.target.get(key);
    if (logic.hasCache(_source, _target) === true) {
      _entries[key] = [_source?.cachedEtag ?? null, _source?.cachedBytes ?? null, _target?.cachedEtag ?? null, _target?.cachedBytes ?? null];
    }
  }
  return _entries;
}

function listings ({ source = [], target = [], cache = {} }) {
  const _files = { source: new Map(source.map((f) => [f.key, f])), target: new Map(target.map((f) => [f.key, f])) };
  for (const [key, entry] of Object.entries(cache)) {
    helper.setCacheEntry(_files, key, ...entry);
  }
  return _files;
}

/** computeSync on listings (or on the files of a previous pass), returns the keys of each list */
function sync (mode, deletion, input, files, options) {
  files = files ?? listings(input);
  const _plan = logic.computeSync(files, mode, deletion, false, options);
  const _keys = (list) => list.map((f) => f.key).sort();
  return {
    actions: {
      uploadTarget: _keys(_plan.objectsToUploadTarget),
      deleteTarget: _keys(_plan.objectsToDeleteTarget),
      uploadSource: _keys(_plan.objectsToUploadSource),
      deleteSource: _keys(_plan.objectsToDeleteSource),
      resolve     : _plan.objectsToResolve.map((r) => r.side + ':' + r.object.key).sort()
    },
    plan : _plan,
    files: files
  };
}

/** HEAD of the opaque etags to resolve: key → MD5 (or null) */
function resolveWith (result, md5ByKey) {
  for (const { object } of result.plan.objectsToResolve) {
    object.resolvedMd5 = md5ByKey[object.key];
  }
}

/** Simulate a successful transfer of every planned operation, the PUT returns `putEtag` (the MD5 of a single PUT) */
function transferAll (result, putEtag) {
  for (const object of [...result.plan.objectsToUploadTarget, ...result.plan.objectsToUploadSource]) {
    object.copied = { etag: putEtag ?? object.md5, bytes: object.bytes, sourceChanged: false };
  }
  for (const object of [...result.plan.objectsToDeleteTarget, ...result.plan.objectsToDeleteSource]) {
    object.deleted = true;
  }
  logic.updateCache(result.files, result.plan);
  return entriesOf(result.files);
}

const NOTHING = { uploadTarget: [], deleteTarget: [], uploadSource: [], deleteSource: [], resolve: [] };

describe('Behaviours learned from the real providers', function () {
  let logs = null;

  beforeEach(function () {
    logs = captureLogs();
  });

  afterEach(function () {
    logs.restore();
  });

  describe('Provider ETags and sizes (computeSync)', function () {
    it('OVH SSE-OMK: the listing token is the opaque etag AND the size: a new size is uploaded without any HEAD', function () {
      const _result = sync(UNI, false, { source: [file('a', OPAQUE, 11)], target: [file('a', MD5_A, 10)], cache: { a: [OPAQUE, 10, MD5_A, 10] } });
      assert.deepStrictEqual(_result.actions, { ...NOTHING, uploadTarget: ['a'] });
    });

    it('OVH SSE-OMK: a new copy (new opaque etag, same size) is resolved once, never uploaded if its MD5 is the synced one', function () {
      const _input = () => ({ source: [file('same', OPAQUE_2), file('edited', OPAQUE_2)], target: [file('same', MD5_A), file('edited', MD5_A)], cache: { same: [OPAQUE, 10, MD5_A, 10], edited: [OPAQUE, 10, MD5_A, 10] } });
      const _first = sync(UNI, true, _input());
      assert.deepStrictEqual(_first.actions, { ...NOTHING, resolve: ['source:edited', 'source:same'] });
      resolveWith(_first, { same: MD5_A, edited: MD5_B });
      const _second = sync(UNI, true, null, _first.files);
      assert.deepStrictEqual(_second.actions, { ...NOTHING, uploadTarget: ['edited'] }, 'only the object whose MD5 changed');
      assert.deepStrictEqual(entriesOf(_second.files).same, [OPAQUE_2, 10, MD5_A, 10], 'the new opaque token is recorded');
      transferAll(_second, MD5_B);
      const _next = sync(UNI, true, { source: [file('same', OPAQUE_2), file('edited', OPAQUE_2)], target: [file('same', MD5_A), file('edited', MD5_B)], cache: entriesOf(_second.files) });
      assert.deepStrictEqual(_next.actions, NOTHING, 'steady state: no HEAD, no transfer');
    });

    it('OVH SSE-OMK: an opaque etag of another size is never resolved (bidirectional first synchronisation: a conflict at once)', function () {
      const _result = sync(BI, false, { source: [file('a', OPAQUE, 10, T0)], target: [file('a', MD5_A, 12, T0 + 1)] });
      assert.deepStrictEqual(_result.actions, { ...NOTHING, uploadSource: ['a'] });
      assert.deepStrictEqual(logs.filter('sync_conflict').map((l) => [l.reason, l.winner]), [['both_new', 'target']]);
    });

    it('OVH silent encryption: a plain PUT listed later with an opaque etag is resolved once and never uploaded again (unidirectional)', function () {
      /** The previous run uploaded the object: the PUT etag (MD5) is cached. OVH lists it now with an opaque etag */
      const _first = sync(UNI, true, { source: [file('a', MD5_A)], target: [file('a', OPAQUE)], cache: { a: [MD5_A, 10, MD5_A, 10] } });
      assert.deepStrictEqual(_first.actions, { ...NOTHING, resolve: ['target:a'] });
      resolveWith(_first, { a: MD5_A });
      const _second = sync(UNI, true, null, _first.files);
      assert.deepStrictEqual(_second.actions, NOTHING);
      assert.deepStrictEqual(entriesOf(_second.files).a, [MD5_A, 10, OPAQUE, 10]);
      const _next = sync(UNI, true, { source: [file('a', MD5_A)], target: [file('a', OPAQUE)], cache: entriesOf(_second.files) });
      assert.deepStrictEqual(_next.actions, NOTHING, 'no HEAD in the steady state');
    });

    it('Scaleway (MD5 etags with AES256): plain MD5 etags are compared directly, whatever their case, without any HEAD', function () {
      const _result = sync(BI, true, { source: [file('a', MD5_A)], target: [file('a', MD5_A.toUpperCase(), 10, T0 + 5000)] });
      assert.deepStrictEqual(_result.actions, NOTHING);
      assert.deepStrictEqual(entriesOf(_result.files).a, [MD5_A, 10, MD5_A.toUpperCase(), 10]);
    });

    it('multipart (unidirectional): the first-sync rule applies only to a multipart source, never to a multipart target', function () {
      const _result = sync(UNI, false, {
        source: [file('mp-source', MULTIPART, 10, T0), file('mp-target', MD5_A, 10, T0 + 1)],
        target: [file('mp-source', MD5_A, 10, T0 + 1), file('mp-target', MULTIPART, 10, T0)]
      });
      assert.deepStrictEqual(_result.actions, { ...NOTHING, uploadTarget: ['mp-target'] });
    });

    it('multipart (bidirectional, first synchronisation): equal to its plain copy in the documented direction only (multipart not newer)', function () {
      const _result = sync(BI, true, {
        source: [file('copy', MD5_A, 10, T0 + 1), file('reuploaded', MD5_A, 10, T0)],
        target: [file('copy', MULTIPART, 10, T0), file('reuploaded', MULTIPART, 10, T0 + 1)]
      });
      assert.deepStrictEqual(_result.actions, { ...NOTHING, uploadSource: ['reuploaded'] });
      assert.deepStrictEqual(entriesOf(_result.files).copy, [MD5_A, 10, MULTIPART, 10]);
      assert.deepStrictEqual(logs.filter('sync_conflict').map((l) => [l.key, l.reason, l.winner]), [['reuploaded', 'both_new', 'target']]);
    });

    it('multipart: the first-sync rule is off once a cache exists (both modified: a conflict, never "identical")', function () {
      const _result = sync(BI, false, { source: [file('a', MULTIPART, 10, T0)], target: [file('a', MD5_B, 10, T0 + 1)], cache: { a: [MD5_A, 10, MD5_A, 10] } });
      assert.deepStrictEqual(_result.actions, { ...NOTHING, uploadSource: ['a'] });
      assert.deepStrictEqual(logs.filter('sync_conflict').map((l) => l.reason), ['both_modified']);
    });

    it('multipart LastModified is the completion time: a plain copy listed at the same ms is identical, 1 ms earlier is not', function () {
      assert.strictEqual(logic.isSameContent(file('a', MULTIPART, 10, T0), file('a', MD5_A, 10, T0), true), true);
      assert.strictEqual(logic.isSameContent(file('a', MULTIPART, 10, T0), file('a', MD5_A, 10, T0 - 1), true), false);
    });
  });

  describe('Bidirectional (computeSync)', function () {
    it('both modified at the same ms: deterministic, the source wins', function () {
      const _result = sync(BI, true, { source: [file('a', MD5_A, 10, T0 + 7)], target: [file('a', MD5_B, 10, T0 + 7)], cache: { a: [OPAQUE, 10, OPAQUE, 10] } });
      assert.deepStrictEqual(_result.actions, { ...NOTHING, uploadTarget: ['a'] });
      assert.deepStrictEqual(logs.filter('sync_conflict').map((l) => [l.reason, l.winner]), [['both_modified', 'source']]);
      /** The winner does not depend on the order of the listings */
      const _swapped = sync(BI, true, { source: [file('b', MD5_B, 10, T0 + 7)], target: [file('b', MD5_A, 10, T0 + 7)], cache: { b: [OPAQUE, 10, OPAQUE, 10] } });
      assert.deepStrictEqual(_swapped.actions, { ...NOTHING, uploadTarget: ['b'] });
    });

    it('a key on one side only is deleted only if the cache says it was synced, otherwise it is copied', function () {
      const _result = sync(BI, true, {
        source: [file('synced', MD5_A)],
        target: [file('synced', MD5_A), file('was-synced', MD5_B), file('never-synced', MD5_B)],
        cache : { synced: [MD5_A, 10, MD5_A, 10], 'was-synced': [MD5_B, 10, MD5_B, 10] }
      });
      assert.deepStrictEqual(_result.actions, { ...NOTHING, deleteTarget: ['was-synced'], uploadSource: ['never-synced'] });
    });
  });

  describe('Guards: empty side (computeSync)', function () {
    it('a side is empty if it is listed empty', function () {
      const _result = sync(UNI, true, { source: [], target: [file('a', MD5_A)] });
      assert.deepStrictEqual(_result.plan.emptySides, { source: true, target: false });
      assert.deepStrictEqual(_result.actions.deleteTarget, ['a'], 'the plan deletes: the guard (sclone.js) refuses it');
    });

    it('a side is empty if none of its listed keys is known in the cache while the other side has synced keys', function () {
      const _refilled = sync(BI, true, { source: [file('new', MD5_B)], target: [file('a', MD5_A)], cache: { a: [MD5_A, 10, MD5_A, 10] } });
      assert.deepStrictEqual(_refilled.plan.emptySides, { source: true, target: false });
      const _firstSync = sync(BI, true, { source: [file('new', MD5_B)], target: [file('a', MD5_A)] });
      assert.deepStrictEqual(_firstSync.plan.emptySides, { source: false, target: false }, 'without cache: only a side listed empty');
    });

    it('the empty sides of the first pass are kept after the resolution of the opaque etags', function () {
      const _first = sync(UNI, true, { source: [file('enc', OPAQUE)], target: [file('enc', MD5_A), file('old', MD5_B)], cache: { old: [MD5_B, 10, MD5_B, 10] } });
      assert.deepStrictEqual(_first.plan.emptySides, { source: true, target: false });
      resolveWith(_first, { enc: MD5_A });
      /** Recorded during the first pass: without the kept value, the source would no longer look empty */
      const _second = sync(UNI, true, null, _first.files, { emptySides: _first.plan.emptySides });
      assert.deepStrictEqual(_second.plan.emptySides, { source: true, target: false });
      assert.deepStrictEqual(_second.actions.deleteTarget, ['old']);
    });
  });

  describe('Cache', function () {
    const _dir = path.join(os.tmpdir(), `sclone-behaviours-${process.pid}`);
    const _cachePath = path.join(_dir, 'bi.cache.json');
    const _config = {
      mode  : BI,
      source: { name: 's3', url: 's3.a.test', region: 'gra', bucket: 'b', accessKeyId: 'key-1' },
      target: { name: 's3', url: 's3.b.test', region: 'sbg', bucket: 'b', accessKeyId: 'key-1' }
    };
    const _header = helper.cacheHeader(_config);
    const _line = (...items) => JSON.stringify(items) + '\n';

    beforeEach(function () {
      fs.rmSync(_dir, { recursive: true, force: true });
      fs.mkdirSync(_dir, { recursive: true });
    });

    afterEach(function () {
      fs.rmSync(_dir, { recursive: true, force: true });
    });

    for (const [_name, _content] of [
      ['empty', ''],
      ['truncated', JSON.stringify(_header) + '\n' + _line('s-deleted', MD5_A, 10, MD5_A, 10) + '["t-deleted",'],
      ['corrupted', '\u0000\u0000{"version'],
      ['of another account', JSON.stringify(helper.cacheHeader({ ..._config, target: { ..._config.target, accessKeyId: 'key-2' } })) + '\n' + _line('s-deleted', MD5_A, 10, MD5_A, 10) + _line('t-deleted', MD5_B, 10, MD5_B, 10)]
    ]) {
      it(`a cache ${_name} leads to a first synchronisation and never a deletion`, function (done) {
        fs.writeFileSync(_cachePath, _content);
        const _files = listings({ source: [file('t-deleted', MD5_B)], target: [file('s-deleted', MD5_A)] });
        helper.loadCache(_cachePath, _header, _files, function (warning) {
          assert.strictEqual(typeof warning, 'string');
          const _result = sync(BI, true, null, _files);
          assert.deepStrictEqual(_result.actions, { ...NOTHING, uploadTarget: ['t-deleted'], uploadSource: ['s-deleted'] });
          done();
        });
      });
    }

    it('the same cache is used again after a change of the secret key, but not of the access key id', function () {
      assert.strictEqual(helper.cacheHeader({ ..._config, source: { ..._config.source, secretAccessKey: 'rotated' } }).source, _header.source);
      assert.notStrictEqual(helper.cacheHeader({ ..._config, source: { ..._config.source, accessKeyId: 'key-2' } }).source, _header.source);
    });
  });

  describe('Storage (nock)', function () {
    const URL_A = 'https://s3.behaviours-a.test';
    const URL_B = 'https://s3.behaviours-b.test';
    const URL_AUTH = 'https://auth.behaviours.test/v3';
    const URL_SWIFT = 'https://swift.behaviours.test/v1/AUTH_behaviours';
    const S3_A = { name: 's3', accessKeyId: 'id-a', secretAccessKey: 'secret-a', url: 's3.behaviours-a.test', region: 'gra', bucket: 'invoices' };
    const S3_B = { name: 's3', accessKeyId: 'id-b', secretAccessKey: 'secret-b', url: 's3.behaviours-b.test', region: 'sbg', bucket: 'invoices' };
    const SWIFT = { name: 'swift', authUrl: URL_AUTH, username: 'user', password: 'password', tenantName: 'tenant', region: 'GRA', bucket: 'invoices' };
    const LIST_BUCKETS = '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>invoices</Name><KeyCount>0</KeyCount><MaxKeys>1</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>';
    const XML = { 'content-type': 'application/xml' };
    const JSON_TYPE = { 'content-type': 'application/json' };

    function nockConnection (auth) {
      if (auth.name === 'swift') {
        return nock(URL_AUTH).post('/auth/tokens').reply(200, { token: { catalog: [{ type: 'object-store', endpoints: [{ region: 'GRA', url: URL_SWIFT }] }] } }, { 'X-Subject-Token': 'token' });
      }
      return nock(auth === S3_A ? URL_A : URL_B).get('/invoices').query({ 'list-type': '2', 'max-keys': '1' }).reply(200, LIST_BUCKETS, XML);
    }

    /** Connect the storages of the test (no versioning check: "delete" is not set) */
    function connect (source, target, done, extra) {
      const _config = { test: true, mode: UNI, retryDelay: 0, listRetryDelay: 1, integrityCheck: false, source, target, ...extra };
      nockConnection(source);
      nockConnection(target);
      storage.connection(_config, 'source', (err) => {
        assert.strictEqual(err, undefined);
        storage.connection(_config, 'target', (err) => {
          assert.strictEqual(err, undefined);
          done();
        });
      });
    }

    function s3Listing (objects) {
      return '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>invoices</Name><KeyCount>' + objects.length + '</KeyCount><IsTruncated>false</IsTruncated>'
        + objects.map(([key, etag, size, lastModified]) => `<Contents><Key>${key}</Key><LastModified>${lastModified}</LastModified><ETag>"${etag}"</ETag><Size>${size}</Size></Contents>`).join('')
        + '</ListBucketResult>';
    }

    afterEach(function () {
      nock.cleanAll();
    });

    describe('Listing', function () {
      beforeEach(function (done) {
        connect(SWIFT, S3_B, done);
      });

      it('Swift "last_modified" in microseconds without Z, and S3 "LastModified" with ms, are parsed to UTC ms; S3 quotes are removed', function (done) {
        nock(URL_SWIFT)
          .get('/invoices').query({ limit: '10000' }).reply(200, JSON.stringify([
            { name: 'micro.pdf', hash: MD5_A, bytes: 1, last_modified: '2023-03-07T17:03:54.123456' },
            { name: 'zulu.pdf', hash: MD5_A, bytes: 1, last_modified: '2023-03-07T17:03:54.999999Z' }
          ]), JSON_TYPE)
          .get('/invoices').query({ limit: '10000', marker: 'zulu.pdf' }).reply(200, '[]', JSON_TYPE);
        nock(URL_B).get('/invoices').query({ 'list-type': '2' }).reply(200, s3Listing([['mp.bin', MULTIPART, 20, '2026-11-19T10:00:00.123Z']]), XML);
        const _files = { source: new Map(), target: new Map() };
        storage.fetchListFiles(_files, function (err) {
          assert.strictEqual(err, undefined);
          assert.strictEqual(_files.source.get('micro.pdf').lastmodified, Date.UTC(2023, 2, 7, 17, 3, 54, 123));
          assert.strictEqual(_files.source.get('zulu.pdf').lastmodified, Date.UTC(2023, 2, 7, 17, 3, 54, 999));
          assert.deepStrictEqual(_files.target.get('mp.bin'), { key: 'mp.bin', md5: MULTIPART, lastmodified: Date.UTC(2026, 10, 19, 10, 0, 0, 123), bytes: 20, cachedEtag: undefined, cachedBytes: undefined });
          assert.strictEqual(nock.pendingMocks().length, 0);
          done();
        });
      });

      it('an OVH opaque etag is kept as the listed token, as-is', function (done) {
        nock(URL_SWIFT).get('/invoices').query({ limit: '10000' }).reply(200, '[]', JSON_TYPE);
        nock(URL_B).get('/invoices').query({ 'list-type': '2' }).reply(200, s3Listing([['enc.pdf', OPAQUE, 7, '2026-11-19T10:00:00.000Z']]), XML);
        const _files = { source: new Map(), target: new Map() };
        storage.fetchListFiles(_files, function (err) {
          assert.strictEqual(err, undefined);
          assert.strictEqual(_files.target.get('enc.pdf').md5, OPAQUE);
          assert.strictEqual(logic.isOpaqueEtag(_files.target.get('enc.pdf').md5), true);
          done();
        });
      });
    });

    describe('Transfers', function () {
      beforeEach(function (done) {
        connect(S3_A, S3_B, done);
      });

      it('a gzip Content-Encoding object is copied byte for byte (no decompression): same size and MD5', function (done) {
        const _gzip = zlib.gzipSync(Buffer.from('compressed content, '.repeat(50)));
        nock(URL_A).get('/invoices/a.txt.gz').reply(200, _gzip, { 'content-type': 'text/plain', 'content-encoding': 'gzip', 'content-length': String(_gzip.length), etag: `"${md5(_gzip)}"` });
        let _uploaded = null;
        nock(URL_B).put('/invoices/a.txt.gz').reply(200, function (uri, body) {
          _uploaded = { headers: this.req.headers, body: Buffer.from(body, 'hex') };
          return '';
        }, { etag: `"${md5(_gzip)}"` });
        const _object = { key: 'a.txt.gz', md5: md5(_gzip), bytes: _gzip.length };
        storage.syncFiles([_object], [], [], [], { mode: UNI }, function (err, stats) {
          assert.strictEqual(err, undefined);
          assert.strictEqual(_uploaded.headers['content-encoding'], 'gzip');
          assert.strictEqual(md5(_uploaded.body), md5(_gzip));
          assert.strictEqual(_uploaded.body.length, _gzip.length);
          assert.deepStrictEqual(_object.copied, { etag: md5(_gzip), bytes: _gzip.length, sourceChanged: false });
          assert.strictEqual(stats.uploaded_bytes, _gzip.length);
          done();
        });
      });

      it('an object of exactly 5 GiB is transferred (the limit is "larger than")', function (done) {
        const _download = nock(URL_A).get('/invoices/limit.iso').reply(200, 'x');
        const _upload = nock(URL_B).put('/invoices/limit.iso').reply(200, '');
        storage.syncFiles([{ key: 'limit.iso', bytes: 5 * 1024 ** 3 }], [], [], [], { mode: UNI }, function (err, stats) {
          assert.strictEqual(err, undefined);
          assert.strictEqual(_download.pendingMocks().length + _upload.pendingMocks().length, 0);
          assert.strictEqual(stats.uploaded, 1);
          assert.strictEqual(logs.filter('transfer_failed').length, 0);
          done();
        });
      });

      for (const [_status, _code] of [[413, 'EntityTooLarge'], [400, 'InvalidArgument']]) {
        it(`an upload refused with a ${_status} (${_code}) is not retried`, function (done) {
          nock(URL_A).get('/invoices/a.pdf').reply(200, 'Hello');
          const _upload = nock(URL_B).put('/invoices/a.pdf').reply(_status, `<Error><Code>${_code}</Code></Error>`, XML);
          storage.syncFiles([{ key: 'a.pdf', bytes: 5 }], [], [], [], { mode: UNI, retry: 3 }, function (err, stats) {
            assert.strictEqual(err instanceof Error, true);
            assert.strictEqual(_upload.pendingMocks().length, 0);
            assert.strictEqual(stats.failed, 1);
            assert.deepStrictEqual(logs.filter('transfer_failed').map((l) => [l.status, l.code, l.reason, l.try]), [[_status, _code, 'permanent', 0]]);
            assert.strictEqual(logs.filter('queue_retry').length, 0);
            done();
          });
        });
      }

      it('a 5xx upload is retried: "transfer_failed" with status, without "reason", then a success', function (done) {
        nock(URL_A).get('/invoices/a.pdf').times(2).reply(200, 'Hello');
        nock(URL_B).put('/invoices/a.pdf').reply(500, '').put('/invoices/a.pdf').reply(200, '');
        storage.syncFiles([{ key: 'a.pdf', bytes: 5 }], [], [], [], { mode: UNI, retry: 1 }, function (err, stats) {
          assert.strictEqual(err, undefined);
          assert.deepStrictEqual(stats, { uploaded: 1, uploaded_bytes: 5, deleted: 0, failed: 0 });
          assert.deepStrictEqual(logs.filter('transfer_failed').map((l) => [l.phase, l.status, l.reason, l.try]), [['upload', 500, undefined, 0]]);
          assert.strictEqual(nock.pendingMocks().length, 0);
          done();
        });
      });

      /**
       * A local server for both storages, with nock deactivated: nock's "replyWithError" combined with the internal retry of
       * the HTTP client never calls back, and its pass-through breaks on a destroyed socket. The socket is destroyed on the
       * first 2 downloads (the HTTP client retries once by itself): one failed try, then a success.
       */
      it('a network error is retried, and logged with its code', function (done) {
        let _downloads = 0;
        let _uploads = 0;
        const _server = http.createServer((req, res) => {
          if (req.url.includes('max-keys=1')) {
            res.writeHead(200, XML);
            return res.end(LIST_BUCKETS);
          }
          if (req.method === 'PUT') {
            _uploads++;
            req.resume();
            return req.on('end', () => res.writeHead(200).end());
          }
          if (++_downloads <= 2) {
            return req.socket.destroy();
          }
          res.writeHead(200, { 'content-type': 'text/plain' });
          return res.end('Hello');
        });
        nock.restore();
        const _end = (err) => {
          _server.close();
          nock.activate();
          done(err);
        };
        _server.listen(0, '127.0.0.1', () => {
          const _url = `http://127.0.0.1:${_server.address().port}`;
          const _config = { test: true, mode: UNI, retryDelay: 0, source: { ...S3_A, url: _url }, target: { ...S3_B, url: _url } };
          storage.connection(_config, 'source', (err) => {
            if (err) {
              return _end(new Error(err));
            }
            storage.connection(_config, 'target', (err) => {
              if (err) {
                return _end(new Error(err));
              }
              storage.syncFiles([{ key: 'a.pdf', bytes: 5 }], [], [], [], { mode: UNI, retry: 1 }, function (err, stats) {
                try {
                  assert.strictEqual(err, undefined);
                  assert.deepStrictEqual([stats.uploaded, _downloads, _uploads], [1, 3, 1]);
                  assert.deepStrictEqual(logs.filter('transfer_failed').map((l) => [l.phase, l.code, l.reason, l.try]), [['download', 'ECONNRESET', undefined, 0]]);
                } catch (e) {
                  return _end(e);
                }
                return _end();
              });
            });
          });
        });
      });

      /** The HTTP client retries a 503 once by itself: 2 requests per try */
      it('a 503 is retried and logged on each try with its status and no permanent reason; the storage line is an error', function (done) {
        nock(URL_A).get('/invoices/a.pdf').times(2).reply(200, 'Hello');
        nock(URL_B).put('/invoices/a.pdf').times(4).reply(503, '<Error><Code>SlowDown</Code></Error>', XML);
        storage.syncFiles([{ key: 'a.pdf', bytes: 5 }], [], [], [], { mode: UNI, retry: 1 }, function (err, stats) {
          assert.strictEqual(err instanceof Error, true);
          assert.strictEqual(stats.failed, 1);
          const _failures = logs.filter('transfer_failed');
          assert.deepStrictEqual(_failures.map((l) => [l.level, l.phase, l.status, l.reason, l.try]), [['warn', 'upload', 503, undefined, 0], ['warn', 'upload', 503, undefined, 1]]);
          assert.strictEqual(nock.pendingMocks().length, 0);
          const _client = logs.filter('storage_client').filter((l) => l.msg.includes('503'));
          assert.strictEqual(_client.length > 0, true);
          assert.deepStrictEqual([...new Set(_client.map((l) => l.level))], ['error']);
          done();
        });
      });
    });

    describe('UTF-8 metadata', function () {
      const _raw = (text) => Buffer.from(text, 'utf8').toString('latin1');
      const _value = 'Remise — 50% sur 10 €';

      it('round-trips Swift → S3 → Swift → S3 with "%", "€" and an em dash, without crash or mojibake', function () {
        /** Node reads a raw UTF-8 header as latin1 */
        const _s3 = storage.convertHeaders({ 'x-object-meta-note': _raw(_value) }, 'swift', 's3');
        assert.match(_s3['x-amz-meta-note'], /^[\x20-\x7e]*$/, 'a header value must be ASCII');
        const _swift = storage.convertHeaders(_s3, 's3', 'swift');
        const _s3Again = storage.convertHeaders(_swift, 'swift', 's3');
        assert.strictEqual(_s3Again['x-amz-meta-note'], _s3['x-amz-meta-note'], 'stable: never encoded twice');
        assert.strictEqual(decodeURIComponent(_s3Again['x-amz-meta-note'].replace(/%(?![0-9A-F]{2})/g, '%25')), _value);
        for (const _header of [_s3['x-amz-meta-note'], _swift['x-object-meta-note'], _s3Again['x-amz-meta-note']]) {
          assert.strictEqual(_header.includes('Ã'), false, 'no mojibake');
        }
      });
    });

    describe('Deletion confirmation (HEAD)', function () {
      beforeEach(function (done) {
        connect(S3_A, S3_B, done);
      });

      it('404 deletes, 2xx skips (still_present), 403 skips without retry and fails, 5xx is retried', function (done) {
        nock(URL_A)
          .head('/invoices/gone.pdf').reply(404)
          .head('/invoices/present.pdf').reply(200, '', { etag: `"${MD5_A}"` })
          .head('/invoices/denied.pdf').reply(403)
          .head('/invoices/flaky.pdf').reply(500)
          .head('/invoices/flaky.pdf').reply(404);
        /** A deletion on the source is confirmed on the target */
        nock(URL_B).head('/invoices/src-gone.pdf').reply(404);
        const _plan = {
          objectsToDeleteTarget: ['gone', 'present', 'denied', 'flaky'].map((name) => ({ key: name + '.pdf' })),
          objectsToDeleteSource: [{ key: 'src-gone.pdf' }]
        };
        storage.confirmDeletions(_plan, { transfers: 1, retry: 1 }, function (failed) {
          assert.strictEqual(failed, 1);
          assert.deepStrictEqual(_plan.objectsToDeleteTarget.map((o) => o.key), ['gone.pdf', 'flaky.pdf']);
          assert.deepStrictEqual(_plan.objectsToDeleteSource.map((o) => o.key), ['src-gone.pdf']);
          assert.deepStrictEqual(logs.filter('deletion_skipped').map((l) => [l.reason, l.count, l.checked]), [['still_present', 1, 5], ['not_confirmed', 1, 5]]);
          assert.strictEqual(nock.pendingMocks().length, 0, 'the 403 is not retried: no extra HEAD');
          done();
        });
      });
    });

    describe('Run (sclone)', function () {
      const sclone = require('../sclone.js');
      const _dir = path.join(os.tmpdir(), `sclone-behaviours-run-${process.pid}`);
      const _configPath = path.join(_dir, 'config.json');
      const _cachePath = path.join(_dir, 'uni.cache.json');
      const _env = { config: process.env.SCLONE_CONFIG, cron: process.env.SCLONE_CRON };

      beforeEach(function () {
        fs.rmSync(_dir, { recursive: true, force: true });
        fs.mkdirSync(_dir, { recursive: true });
        delete process.env.SCLONE_CRON;
        process.env.SCLONE_CONFIG = _configPath;
      });

      afterEach(function () {
        fs.rmSync(_dir, { recursive: true, force: true });
        for (const [_name, _value] of [['SCLONE_CONFIG', _env.config], ['SCLONE_CRON', _env.cron]]) {
          if (_value === undefined) {
            delete process.env[_name];
          } else {
            process.env[_name] = _value;
          }
        }
      });

      it('"maxDeletion": 0 means no limit; "sync_end" carries status, uploaded, deleted, failed, bytes and duration_ms', function (done) {
        fs.writeFileSync(_configPath, JSON.stringify({ test: true, retryDelay: 0, listRetryDelay: 1, mode: UNI, delete: true, maxDeletion: 0, cacheFilename: _cachePath, source: S3_A, target: S3_B }));
        nockConnection(S3_A);
        nockConnection(S3_B);
        const _old = [1, 2, 3, 4, 5].map((i) => [`old${i}.pdf`, MD5_B, 10, '2026-11-19T10:00:00.000Z']);
        nock(URL_A).get('/invoices').query({ 'list-type': '2' }).reply(200, s3Listing([['new.pdf', md5('Hello1234'), 9, '2026-11-19T10:00:00.000Z']]), XML);
        nock(URL_B).get('/invoices').query({ 'list-type': '2' }).reply(200, s3Listing(_old), XML);
        nock(URL_A).head(/^\/invoices\/old[1-5]\.pdf$/).times(5).reply(404);
        nock(URL_B).post('/invoices/').query({ delete: '' }).reply(200, (uri, body) => '<DeleteResult>' + (body.match(/<Key>[^<]*<\/Key>/g) ?? []).map((key) => `<Deleted>${key}</Deleted>`).join('') + '</DeleteResult>');
        nock(URL_A).get('/invoices/new.pdf').reply(200, 'Hello1234');
        nock(URL_B).put('/invoices/new.pdf').reply(200, '', { etag: `"${md5('Hello1234')}"` });
        sclone((err) => {
          assert.strictEqual(err, undefined);
          assert.strictEqual(nock.pendingMocks().length, 0);
          assert.strictEqual(logs.filter('deletion_refused').length, 0);
          const _end = logs.filter('sync_end')[0];
          assert.deepStrictEqual([_end.level, _end.status, _end.uploaded, _end.uploaded_bytes, _end.deleted, _end.failed], ['info', 'success', 1, 9, 5, 0]);
          assert.deepStrictEqual([_end.source_objects, _end.target_objects, _end.source_bytes, _end.target_bytes], [1, 5, 9, 50]);
          assert.strictEqual(Number.isInteger(_end.duration_ms) && _end.duration_ms >= 0, true);
          /** The PUT etag is stored in the cache */
          const _lines = fs.readFileSync(_cachePath, 'utf8').trimEnd().split('\n').slice(1).map((line) => JSON.parse(line));
          assert.deepStrictEqual(_lines, [['new.pdf', md5('Hello1234'), 9, md5('Hello1234'), 9]]);
          done();
        });
      });
    });
  });
});
