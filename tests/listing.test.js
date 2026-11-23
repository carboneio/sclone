const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const nock = require('nock');
const storage = require('../storage');
const helper = require('../helper');
const logger = require('../logger');
const { captureLogs } = require('./support/logs');

/**
 * Listing by key ranges in parallel: fake S3 and Swift buckets (nock) implementing `start-after` / `marker` in UTF-8 byte
 * order. The parallel listing must build exactly the Map of the sequential one: same keys, same order, same values.
 */
const URLS = { source: 'https://s3.gra.first.cloud.test', target: 'https://s3.sbg.first.cloud.test' };
const SWIFT_URLS = { source: 'https://storage.sbg.cloud.ovh.net/v1/AUTH_test', target: 'https://storage.gra.cloud.ovh.net/v1/AUTH_test' };
const AUTH_URL = 'https://auth.cloud.ovh.net/v3';
const S3_CONFIG = {
  test: true, mode: 'bidirectional', listRetryDelay: 1, retryDelay: 0,
  source: { name: 's3', accessKeyId: 'id', secretAccessKey: 'secret', url: 's3.gra.first.cloud.test', region: 'gra', bucket: 'invoices' },
  target: { name: 's3', accessKeyId: 'id', secretAccessKey: 'secret', url: 's3.sbg.first.cloud.test', region: 'sbg', bucket: 'invoices' }
};
const SWIFT_CONFIG = {
  ...S3_CONFIG,
  source: { name: 'swift', authUrl: AUTH_URL, username: 'user', password: 'password', tenantName: 'tenant', region: 'SBG', bucket: 'invoices' },
  target: { name: 'swift', authUrl: AUTH_URL, username: 'user', password: 'password', tenantName: 'tenant', region: 'GRA', bucket: 'invoices' }
};
const SWIFT_AUTH = {
  token: {
    catalog: [{
      type: 'object-store', id: 'swift', name: 'swift',
      endpoints: [
        { region_id: 'SBG', region: 'SBG', url: SWIFT_URLS.source, interface: 'public', id: 'sbg' },
        { region_id: 'GRA', region: 'GRA', url: SWIFT_URLS.target, interface: 'public', id: 'gra' }
      ]
    }]
  }
};

/** Characters whose UTF-16 and UTF-8 orders differ (U+E000, U+FB00, U+FFFD against astral characters), unicode, `/`, spaces */
const CHARS = ['a', 'b', 'Z', '0', '9', '/', ' ', '-', '.', '_', 'é', '日', '😀', '𝄞', '�', '', 'ﬀ', '&', '<', '"', '%', '+'];
const byteOrder = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

function random (seed) {
  let _state = seed >>> 0;
  return (max) => {
    _state = (_state + 0x6D2B79F5) >>> 0;
    let _t = _state;
    _t = Math.imul(_t ^ (_t >>> 15), _t | 1);
    _t ^= _t + Math.imul(_t ^ (_t >>> 7), _t | 61);
    return Math.floor((((_t ^ (_t >>> 14)) >>> 0) / 4294967296) * max);
  };
}

function randomKey (rand) {
  let _key = '';
  for (let i = rand(10); i >= 0; i--) {
    _key += CHARS[rand(CHARS.length)];
  }
  return _key;
}

function fileOf (key, rand) {
  return { key, hash: crypto.createHash('md5').update(key).digest('hex'), lastModified: new Date(1700000000000 + rand(1e9)).toISOString().slice(0, -1), bytes: rand(1e6) };
}

/** Fake bucket: files sorted in UTF-8 byte order (or `order`), `requests` the queries received, `onRequest(query)` called before each answer */
function fakeBucket (keys, rand, order = byteOrder) {
  const _bucket = { files: [], requests: [], onRequest: null, fault: null };
  _bucket.set = (key) => {
    const _index = _bucket.files.findIndex((file) => order(file.key, key) >= 0);
    if (_bucket.files[_index]?.key !== key) {
      _bucket.files.splice(_index === -1 ? _bucket.files.length : _index, 0, fileOf(key, rand));
    }
  };
  _bucket.remove = (key) => {
    _bucket.files = _bucket.files.filter((file) => file.key !== key);
  };
  _bucket.page = (after, limit) => {
    const _start = after === null ? 0 : _bucket.files.findIndex((file) => order(file.key, after) > 0);
    const _page = _start === -1 ? [] : _bucket.files.slice(_start, _start + limit);
    return { page: _page.map((file) => ({ ...file })), isTruncated: _start !== -1 && _start + limit < _bucket.files.length };
  };
  _bucket.files = [...new Set(keys)].sort(order).map((key) => fileOf(key, rand));
  return _bucket;
}

const escapeXml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const s3Body = (page, isTruncated) => '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>invoices</Name>'
  + `<KeyCount>${page.length}</KeyCount><IsTruncated>${isTruncated}</IsTruncated>`
  + page.map((file) => `<Contents><Key>${escapeXml(file.key)}</Key><LastModified>${file.lastModified}Z</LastModified><ETag>&quot;${file.hash}&quot;</ETag><Size>${file.bytes}</Size></Contents>`).join('')
  + '</ListBucketResult>';

/** Answer of a fake bucket to a listing request. `fault(query, page)` may change the page once (invariant tests) */
function answer (bucket, uri, isSwift) {
  const _query = Object.fromEntries(new URL('http://test' + uri).searchParams);
  bucket.requests.push(_query);
  bucket.onRequest?.(_query);
  if (bucket.error?.(_query) === true) {
    return [503, 'Service Unavailable'];
  }
  const _after = (isSwift ? _query.marker : _query['start-after']) ?? null;
  const _limit = Number(isSwift ? _query.limit : _query['max-keys'] ?? 1000);
  const { page, isTruncated } = bucket.page(_after, _limit);
  const _page = bucket.fault?.(_query, page) ?? page;
  if (isSwift) {
    return [200, JSON.stringify(_page.map((file) => ({ name: file.key, hash: file.hash, last_modified: file.lastModified, bytes: file.bytes, content_type: 'text/plain' }))), { 'content-type': 'application/json' }];
  }
  return [200, s3Body(_page, isTruncated), { 'content-type': 'application/xml' }];
}

const buckets = { source: null, target: null };

/** Connect both sides to the fake buckets, with the config overrides (listingConcurrency...) */
function connect (isSwift, overrides, callback) {
  nock.cleanAll();
  const _config = { ...(isSwift ? SWIFT_CONFIG : S3_CONFIG), ...overrides };
  if (isSwift) {
    nock(AUTH_URL).persist().post('/auth/tokens').reply(200, SWIFT_AUTH, { 'X-Subject-Token': 'token' });
  }
  for (const _side of ['source', 'target']) {
    nock(isSwift ? SWIFT_URLS[_side] : URLS[_side]).persist().get('/invoices').query(true).reply((uri) => answer(buckets[_side], uri, isSwift));
  }
  storage.connection(_config, 'source', (err) => {
    assert.strictEqual(err, undefined);
    storage.connection(_config, 'target', (err) => {
      assert.strictEqual(err, undefined);
      buckets.source.requests.length = 0;
      buckets.target.requests.length = 0;
      return rethrow(callback);
    });
  });
}

/** An assertion failing in a callback of a queue must fail the test, not be swallowed */
function rethrow (fn) {
  try {
    return fn();
  } catch (err) {
    setImmediate(() => {
      throw err;
    });
  }
}

/** List both sides: (err, files, stats) */
function list (isSwift, pageSize, listing, callback) {
  const _files = { source: new Map(), target: new Map() };
  const _options = isSwift ? { swift: { queries: { limit: pageSize } }, listing } : { s3: { queries: { 'max-keys': pageSize } }, listing };
  storage.fetchListFiles(_files, _options, (err, stats) => rethrow(() => callback(err, _files, stats)));
}

const entries = (map) => [...map.entries()];

describe('Listing by key ranges', function () {
  let _logs = null;
  beforeEach(function () {
    _logs = captureLogs();
    logger.setup({ logLevel: 'debug' });
    if (process.env.LISTING_DEBUG) { _logs.restore(); }
    buckets.source = fakeBucket([], random(0));
    buckets.target = fakeBucket([], random(0));
  });
  afterEach(function () {
    _logs.restore();
    logger.setup({});
    nock.cleanAll();
  });

  describe('compareKeys', function () {
    it('should compare in UTF-8 byte order like Buffer.compare, never in UTF-16 order (lone surrogates included)', function () {
      assert.strictEqual(storage.compareKeys('', '😀') < 0, true);
      assert.strictEqual(storage.compareKeys('�', '😀') < 0, true);
      assert.strictEqual('�' < '😀', false, 'JS order is the trap');
      const _rand = random(42);
      const _chars = [...CHARS, '\uD800', '\uDBFF', '\uDC00', '\uDFFF', '\u007F', '\u0080', '߿', 'ࠀ', '￿', '\u{10FFFF}'];
      for (let i = 0; i < 20000; i++) {
        let _a = '';
        let _b = '';
        for (let j = _rand(6); j >= 0; j--) {
          _a += _chars[_rand(_chars.length)];
        }
        _b = _rand(3) === 0 ? _a.slice(0, _rand(_a.length + 1)) + _chars[_rand(_chars.length)] : _a.slice(0, _rand(_a.length + 1));
        for (let j = _rand(3); j > 0; j--) {
          _b += _chars[_rand(_chars.length)];
        }
        assert.strictEqual(Math.sign(storage.compareKeys(_a, _b)), Math.sign(byteOrder(_a, _b)), JSON.stringify([_a, _b]));
        assert.strictEqual(Math.sign(storage.compareKeys(_b, _a)), Math.sign(byteOrder(_b, _a)), JSON.stringify([_b, _a]));
      }
    });
  });

  for (const isSwift of [false, true]) {
    describe(isSwift ? 'Swift' : 'S3', function () {

      const _seeds = isSwift ? 120 : 200;
      it(`should build exactly the Map of the sequential listing, on ${_seeds} random buckets changed between runs (property test)`, function (done) {
        this.timeout(120000);
        let _seed = 1;
        let _parallelRuns = 0;
        const _next = () => {
          if (_seed > _seeds) {
            assert.strictEqual(_parallelRuns >= _seeds * 0.75, true, `only ${_parallelRuns} parallel listings`);
            return done();
          }
          const _rand = random(_seed++ * (isSwift ? 7919 : 1));
          const _pageSize = 2 + _rand(12);
          const _keys = new Set();
          for (let i = 20 + _rand(150); i > 0; i--) {
            _keys.add(randomKey(_rand));
          }
          buckets.source = fakeBucket([..._keys], _rand);
          buckets.target = fakeBucket(_rand(2) === 0 ? [] : [..._keys].slice(0, _rand(_keys.size)), _rand);
          const _concurrency = [2, 3, 4, 8, 16][_rand(5)];
          connect(isSwift, { listingConcurrency: _concurrency }, () => list(isSwift, _pageSize, undefined, (err, _first, firstStats) => {
            assert.strictEqual(err, undefined);
            assert.strictEqual(firstStats.source.ranges, 1, 'first run: sequential');
            /** Bounds of the previous run, or random bounds (any strings, duplicates, not keys) */
            const _listing = { source: firstStats.source.bounds !== undefined ? { objects: firstStats.source.objects, bounds: firstStats.source.bounds } : undefined, target: firstStats.target.bounds !== undefined ? { objects: firstStats.target.objects, bounds: firstStats.target.bounds } : undefined };
            if (_rand(3) === 0) {
              _listing.source = { objects: 1e6, bounds: Array.from({ length: 63 }, () => randomKey(_rand)).sort(byteOrder) };
            }
            const _bounds = _listing.source?.bounds ?? [];
            /** The bucket changes between the runs: before the first bound, between bounds, after the last one, bounds deleted */
            for (let i = _rand(30); i > 0; i--) {
              const _bound = _bounds[_rand(_bounds.length)] ?? '';
              switch (_rand(5)) {
                case 0: buckets.source.set(randomKey(_rand)); break;
                case 1: buckets.source.remove(_bound); break;
                case 2: buckets.source.set(_bound + randomKey(_rand)); break;
                case 3: buckets.source.set('\u0001' + randomKey(_rand)); break;
                default: buckets.source.set('\u{10FFFF}' + randomKey(_rand)); break;
              }
            }
            list(isSwift, _pageSize, _listing, (err, parallel, stats) => {
              assert.strictEqual(err, undefined);
              _parallelRuns += stats.source.ranges > 1 ? 1 : 0;
              connect(isSwift, { listingConcurrency: 1 }, () => list(isSwift, _pageSize, _listing, (err, sequential, sequentialStats) => {
                try {
                  assert.strictEqual(err, undefined);
                  assert.strictEqual(sequentialStats.source.ranges, 1);
                  assert.deepStrictEqual(entries(parallel.source), entries(sequential.source));
                  assert.deepStrictEqual(entries(parallel.target), entries(sequential.target));
                  assert.deepStrictEqual([...parallel.source.keys()], buckets.source.files.map((file) => file.key));
                  assert.deepStrictEqual({ ...stats.source, ranges: 1 }, sequentialStats.source);
                  assert.strictEqual(_logs.filter('listing_fallback').length, 0);
                } catch (error) {
                  return done(new Error(`seed ${_seed - 1}: ${error.message}`));
                }
                return _next();
              }));
            });
          }));
        };
        _next();
      });

      it('should never miss a file present during the whole listing, with files added and removed during the listing', function (done) {
        this.timeout(60000);
        let _seed = 1;
        const _next = () => {
          if (_seed > 100) {
            return done();
          }
          const _rand = random(_seed++ * 31 + (isSwift ? 1 : 0));
          const _keys = new Set();
          for (let i = 50 + _rand(200); i > 0; i--) {
            _keys.add(randomKey(_rand));
          }
          buckets.source = fakeBucket([..._keys], _rand);
          const _sorted = [..._keys].sort(byteOrder);
          const _bounds = Array.from({ length: 63 }, (_, i) => _sorted[Math.floor((i + 1) * _sorted.length / 64)]);
          /** Removed during the listing: some of the initial files. Added: new files, removed again sometimes */
          const _volatile = new Set(_sorted.filter(() => _rand(5) === 0));
          const _ever = new Set(_keys);
          /** A second listing from the first key: the ranges changed meanwhile, listed again sequentially (bucket no longer changed). S3: after the connection check */
          let _starts = isSwift ? 0 : -1;
          let _fallback = false;
          buckets.source.onRequest = (query) => {
            _fallback ||= (isSwift ? query.marker : query['start-after']) === undefined && ++_starts > 1;
            if (_fallback === true) {
              return;
            }
            for (let i = _rand(3); i > 0; i--) {
              if (_rand(2) === 0) {
                const _key = randomKey(_rand);
                if (_keys.has(_key) === false) {
                  _volatile.add(_key);
                  _ever.add(_key);
                  buckets.source.set(_key);
                }
              } else {
                buckets.source.remove([..._volatile][_rand(_volatile.size)]);
              }
            }
          };
          connect(isSwift, { listingConcurrency: [2, 4, 8][_rand(3)] }, () => list(isSwift, 1 + _rand(6), { source: { objects: 1e6, bounds: _bounds } }, (err, files, stats) => {
            try {
              assert.strictEqual(err, undefined);
              assert.strictEqual(_fallback === true ? stats.source.ranges === 1 : stats.source.ranges > 1, true, `ranges ${stats.source.ranges}, listed again ${_fallback}`);
              const _listed = [...files.source.keys()];
              if (_fallback === true) {
                assert.deepStrictEqual(_listed, buckets.source.files.map((file) => file.key), 'listed again: exactly the bucket');
              }
              assert.deepStrictEqual(_listed, [..._listed].sort(byteOrder), 'sorted in UTF-8 byte order');
              assert.strictEqual(new Set(_listed).size, _listed.length);
              for (const _key of _keys) {
                assert.strictEqual(_volatile.has(_key) || files.source.has(_key), true, `missed ${JSON.stringify(_key)}`);
              }
              for (const _key of _listed) {
                assert.strictEqual(_ever.has(_key), true);
              }
            } catch (error) {
              return done(new Error(`seed ${_seed - 1}: ${error.message}`));
            }
            return _next();
          }));
        };
        _next();
      });

      for (const [_name, _fault] of [
        ['a page not sorted', (page) => (page.length > 2 ? [page[1], page[0], ...page.slice(2)] : null)],
        ['a duplicate key (lower bound returned again)', (page, after) => (page.length > 0 ? [{ ...page[0], key: after }, ...page.slice(1)] : null)],
        ['a page not sorted after the upper bound', (page) => (page.length > 3 ? [...page.slice(0, page.length - 2), page[page.length - 1], page[page.length - 2]] : null)]
      ]) {
        it(`should list the side again sequentially (listing_fallback) on ${_name}, and give the right result`, function (done) {
          const _rand = random(5);
          const _keys = Array.from({ length: 300 }, (_, i) => 'k/' + String(i).padStart(4, '0') + randomKey(_rand));
          buckets.source = fakeBucket(_keys, _rand);
          const _sorted = buckets.source.files.map((file) => file.key);
          const _bounds = [_sorted[100], _sorted[200]];
          let _armed = true;
          buckets.source.fault = (query, page) => {
            const _after = isSwift ? query.marker : query['start-after'];
            if (_armed === true && _after === _bounds[0]) {
              const _page = _fault(page, _after);
              _armed = _page === null;
              return _page;
            }
            return null;
          };
          connect(isSwift, { listingConcurrency: 4 }, () => list(isSwift, 10, { source: { objects: 1e6, bounds: _bounds } }, (err, files, stats) => {
            assert.strictEqual(err, undefined);
            assert.strictEqual(_armed, false, 'fault injected');
            const _fallback = _logs.filter('listing_fallback');
            assert.strictEqual(_fallback.length, 1);
            assert.strictEqual(_fallback[0].level, 'warn');
            assert.strictEqual(_fallback[0].side, 'source');
            assert.strictEqual(stats.source.ranges, 1);
            assert.deepStrictEqual([...files.source.keys()], _sorted);
            assert.strictEqual(stats.source.objects, 300);
            assert.strictEqual(_logs.filter('listing_done').find((line) => line.side === 'source').ranges, 1);
            done();
          }));
        });
      }

      it('should list again sequentially when a range does not end at the first key of the next one (server order not UTF-8), never miss a key', function (done) {
        /** U+FF00 is below U+10000 in UTF-16 (JS) order, above in UTF-8: a server sorting in UTF-16 lists "m\u{10000}" below the bound */
        const _keys = ['a', 'b', 'm\uFF01', 'm\u{10000}', 'n', 'o', 'p'];
        const _listing = { source: { objects: 1e6, bounds: ['m\uFF00'] } };
        const _utf16Order = (a, b) => (a < b ? -1 : (a > b ? 1 : 0));
        buckets.source = fakeBucket(_keys, random(10));
        connect(isSwift, { listingConcurrency: 4 }, () => list(isSwift, 3, _listing, (err, files, stats) => {
          assert.strictEqual(err, undefined);
          assert.strictEqual(stats.source.ranges, 2, 'same order as compareKeys: by ranges');
          assert.strictEqual(_logs.filter('listing_fallback').length, 0);
          assert.deepStrictEqual([...files.source.keys()], _keys);
          buckets.source = fakeBucket(_keys, random(10), _utf16Order);
          connect(isSwift, { listingConcurrency: 4 }, () => list(isSwift, 3, _listing, (err, files, stats) => {
            assert.strictEqual(err, undefined);
            const _fallback = _logs.filter('listing_fallback');
            assert.strictEqual(_fallback.length, 1);
            assert.strictEqual(_fallback[0].reason, 'range 1/2 does not end at the first key of the next range');
            assert.strictEqual(stats.source.ranges, 1);
            assert.deepStrictEqual([...files.source.keys()].sort(byteOrder), _keys);
            done();
          }));
        }));
      });

      it('should list the side again sequentially (listing_fallback) when a range gets a page over twice the page size (max-keys / limit ignored)', function (done) {
        buckets.source = fakeBucket(Array.from({ length: 300 }, (_, i) => 'k' + String(i).padStart(4, '0')), random(12));
        const _listing = { source: { objects: 1e6, bounds: ['k0100', 'k0200'] } };
        const _marker = (query) => (isSwift ? query.marker : query['start-after']);
        connect(isSwift, { listingConcurrency: 4 }, () => list(isSwift, 10, _listing, (err, healthy, stats) => {
          assert.strictEqual(err, undefined);
          assert.strictEqual(stats.source.ranges, 3, 'healthy server: by ranges');
          buckets.source.requests.length = 0;
          buckets.source.fault = (query) => buckets.source.page(_marker(query) ?? null, 1e6).page;
          list(isSwift, 10, _listing, (err, files, stats) => {
            assert.strictEqual(err, undefined);
            assert.deepStrictEqual(_logs.filter('listing_fallback').map((line) => line.reason), ['oversized_page']);
            assert.strictEqual(stats.source.ranges, 1);
            assert.deepStrictEqual(entries(files.source), entries(healthy.source));
            /** Ranges 2 and 3 never started: one huge page of range 1, then the sequential listing */
            assert.strictEqual(buckets.source.requests.some((query) => _listing.source.bounds.includes(_marker(query))), false);
            assert.strictEqual(_marker(buckets.source.requests[0]), undefined);
            assert.strictEqual(_marker(buckets.source.requests[1]), undefined);
            done();
          });
        }));
      });

      it('should never start the other ranges when the first page of range 1 fails after the retries', function (done) {
        buckets.source = fakeBucket(Array.from({ length: 300 }, (_, i) => 'k' + String(i).padStart(4, '0')), random(13));
        connect(isSwift, { listingConcurrency: 4, listRetry: 1 }, () => {
          buckets.source.error = (query) => (isSwift ? query.marker : query['start-after']) === undefined;
          list(isSwift, 10, { source: { objects: 1e6, bounds: ['k0100', 'k0200'] } }, (err, files) => {
            assert.strictEqual(err, 'List files error | Error: ' + (isSwift ? 'Object Storages are not available' : 'All S3 storages are not available'));
            assert.strictEqual(files.source.size, 0);
            assert.strictEqual(_logs.filter('listing_retry').length, 1);
            assert.strictEqual(buckets.source.requests.every((query) => (isSwift ? query.marker : query['start-after']) === undefined), true, 'range 1 only');
            done();
          });
        });
      });

      it('should fail a sequential listing whose pages loop (pagination ignored), instead of listing forever', function (done) {
        buckets.source = fakeBucket(Array.from({ length: 30 }, (_, i) => 'k' + String(i).padStart(4, '0')), random(11));
        /** Back to the first page after k0019, every time */
        buckets.source.fault = (query) => ((isSwift ? query.marker : query['start-after']) === 'k0019' ? buckets.source.page(null, 5).page : null);
        connect(isSwift, {}, () => list(isSwift, 5, undefined, (err, files) => {
          assert.strictEqual(err, 'List files error | Invalid listing: the key "k0000" is listed twice, the pagination loops | Bucket: invoices');
          assert.strictEqual(files.source.size, 0);
          assert.strictEqual(buckets.source.requests.length, 5);
          done();
        }));
      });

      it('should fail the listing as before when a page of a range still fails after the retries, and leave the side empty', function (done) {
        const _rand = random(6);
        buckets.source = fakeBucket(Array.from({ length: 300 }, (_, i) => 'k' + String(i).padStart(4, '0')), _rand);
        const _bounds = ['k0100', 'k0200'];
        buckets.source.error = (query) => (isSwift ? query.marker : query['start-after']) === 'k0150';
        connect(isSwift, { listingConcurrency: 4, listRetry: 2 }, () => list(isSwift, 10, { source: { objects: 1e6, bounds: _bounds } }, (err, files) => {
          assert.strictEqual(err, 'List files error | Error: ' + (isSwift ? 'Object Storages are not available' : 'All S3 storages are not available'));
          assert.strictEqual(files.source.size, 0);
          assert.strictEqual(_logs.filter('listing_retry').length, 2);
          assert.strictEqual(_logs.filter('listing_fallback').length, 0);
          done();
        }));
      });

      it('should list sequentially without the bounds of a previous listing (first run), with too few files, or with listingConcurrency 1, sending the same requests as 2.0', function (done) {
        const _rand = random(7);
        buckets.source = fakeBucket(Array.from({ length: 300 }, (_, i) => 'k' + String(i).padStart(4, '0')), _rand);
        const _bounds = ['k0100', 'k0200'];
        connect(isSwift, { listingConcurrency: 4 }, () => list(isSwift, 10, undefined, (err, reference, stats) => {
          assert.strictEqual(err, undefined);
          assert.strictEqual(stats.source.ranges, 1);
          const _requests = [...buckets.source.requests];
          assert.deepStrictEqual(_logs.filter('listing_sequential').map((line) => [line.side, line.reason, line.level]).sort(), [['source', 'no_cache', 'debug'], ['target', 'no_cache', 'debug']]);
          const _cases = [
            [{ listingConcurrency: 1 }, { objects: 1e6, bounds: _bounds }, 'concurrency_1'],
            [{ listingConcurrency: 4 }, { objects: 39, bounds: _bounds }, 'small'],
            [{ listingConcurrency: 4 }, { objects: 1e6, bounds: [] }, 'no_cache']
          ];
          const _nextCase = () => {
            const _case = _cases.shift();
            if (_case === undefined) {
              return done();
            }
            connect(isSwift, _case[0], () => {
              _logs.lines.length = 0;
              list(isSwift, 10, { source: _case[1] }, (err, files, stats) => {
                assert.strictEqual(err, undefined);
                assert.strictEqual(stats.source.ranges, 1);
                assert.deepStrictEqual(buckets.source.requests, _requests, 'same requests');
                assert.deepStrictEqual(entries(files.source), entries(reference.source));
                assert.strictEqual(_logs.filter('listing_sequential').find((line) => line.side === 'source').reason, _case[2]);
                return _nextCase();
              });
            });
          };
          _nextCase();
        }));
      });

      it('should use fewer ranges when the side is too small for listingConcurrency, and log the number of ranges', function (done) {
        const _rand = random(8);
        buckets.source = fakeBucket(Array.from({ length: 300 }, (_, i) => 'k' + String(i).padStart(4, '0')), _rand);
        const _bounds = Array.from({ length: 63 }, (_, i) => 'k' + String(Math.floor((i + 1) * 300 / 64)).padStart(4, '0'));
        /** 300 files, pages of 10: 15 ranges of 2 pages at most */
        connect(isSwift, { listingConcurrency: 64 }, () => list(isSwift, 10, { source: { objects: 300, bounds: _bounds } }, (err, files, stats) => {
          assert.strictEqual(err, undefined);
          assert.strictEqual(stats.source.ranges, 15);
          assert.strictEqual(files.source.size, 300);
          assert.deepStrictEqual([...files.source.keys()], buckets.source.files.map((file) => file.key));
          assert.strictEqual(_logs.filter('listing_done').find((line) => line.side === 'source').ranges, 15);
          done();
        }));
      });
    });
  }

  describe('Bounds recorded in the cache header', function () {
    const _dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sclone-listing-'));
    const _cachePath = path.join(_dir, 'test.cache.json');
    const _header = helper.cacheHeader(S3_CONFIG);
    after(function () {
      fs.rmSync(_dir, { recursive: true, force: true });
    });

    it('should read only valid bounds of the same synchronisation, never fail', function (done) {
      const _cases = [
        [JSON.stringify({ ..._header, listing: { source: { objects: 5000, bounds: ['a', '😀'] }, target: { objects: 1, bounds: 'x' } } }) + '\n["a",null,null,null,null]\n', { source: { objects: 5000, bounds: ['a', '😀'] } }],
        [JSON.stringify({ ..._header, listing: { source: { objects: 5000, bounds: ['a', 2] } } }) + '\n', {}],
        [JSON.stringify({ ..._header, listing: { source: { objects: 5000, bounds: Array(64).fill('a') } } }) + '\n', {}],
        /** Not a key: a lone surrogate (cannot be sent in a URL), over 1024 bytes in UTF-8 (S3 limit, too large for a request) */
        [JSON.stringify({ ..._header, listing: { source: { objects: 5000, bounds: ['a', 'k\uD800'] }, target: { objects: 5000, bounds: ['a', 'k' + 'z'.repeat(17000)] } } }) + '\n', {}],
        [JSON.stringify({ ..._header, listing: { source: { objects: 5000, bounds: ['é'.repeat(512)] }, target: { objects: 5000, bounds: ['é'.repeat(512) + 'a'] } } }) + '\n', { source: { objects: 5000, bounds: ['é'.repeat(512)] } }],
        [JSON.stringify(_header) + '\n', {}],
        [JSON.stringify({ ..._header, mode: 'unidirectional', listing: { source: { objects: 5000, bounds: ['a'] } } }) + '\n', undefined],
        ['{"version":2,', undefined],
        ['not json\n', undefined],
        [null, undefined]
      ];
      const _next = () => {
        const _case = _cases.shift();
        if (_case === undefined) {
          return done();
        }
        fs.rmSync(_cachePath, { force: true });
        if (_case[0] !== null) {
          fs.writeFileSync(_cachePath, _case[0]);
        }
        helper.readCacheListing(_cachePath, _header, (listing) => {
          assert.deepStrictEqual(listing, _case[1], _case[0]);
          return _next();
        });
      };
      _next();
    });

    it('should still load a cache whose header holds the bounds (2.0 ignores them too)', function (done) {
      const _files = { source: new Map([['a', { key: 'a', md5: 'x', bytes: 1, cachedEtag: 'x', cachedBytes: 1 }]]), target: new Map() };
      helper.saveCache(_cachePath, { ..._header, listing: { source: { objects: 1, bounds: ['a'] } } }, _files, (err) => {
        assert.strictEqual(err, undefined);
        const _loaded = { source: new Map([['a', { key: 'a', md5: 'x', bytes: 1, cachedEtag: undefined, cachedBytes: undefined }]]), target: new Map() };
        helper.loadCache(_cachePath, _header, _loaded, (warning, migrated, count) => {
          assert.strictEqual(warning, undefined);
          assert.strictEqual(count, 1);
          assert.strictEqual(_loaded.source.get('a').cachedEtag, 'x');
          helper.readCacheListing(_cachePath, _header, (listing) => {
            assert.deepStrictEqual(listing, { source: { objects: 1, bounds: ['a'] } });
            done();
          });
        });
      });
    });

    it('should record the bounds of a listing in byte order: 63 keys, one every 1/64 of the listing', function (done) {
      const _rand = random(9);
      buckets.source = fakeBucket(Array.from({ length: 6400 }, (_, i) => 'k' + String(i).padStart(5, '0')), _rand);
      connect(false, {}, () => list(false, 1000, undefined, (err, files, stats) => {
        assert.strictEqual(err, undefined);
        assert.strictEqual(stats.source.bounds.length, 63);
        assert.deepStrictEqual(stats.source.bounds, Array.from({ length: 63 }, (_, i) => 'k' + String((i + 1) * 100).padStart(5, '0')));
        assert.strictEqual(stats.target.bounds, undefined, 'empty side');
        /** 6400 files: 3 ranges of 2 pages at least (default listingConcurrency 4) */
        list(false, 1000, { source: { objects: stats.source.objects, bounds: stats.source.bounds } }, (err, parallel, parallelStats) => {
          assert.strictEqual(err, undefined);
          assert.strictEqual(parallelStats.source.ranges, 3);
          assert.deepStrictEqual(entries(parallel.source), entries(files.source));
          done();
        });
      }));
    });
  });
});
