/**
 * In-memory fake S3 and Swift storages for the offline matrix (tests/matrix.test.js), served by one local HTTP server:
 * - S3 (path style) at "/<bucket>": ListObjectsV2, GET, HEAD, PUT, DELETE, DeleteObjects,
 * - Swift at "/v1/AUTH_test/<container>" and its Keystone at "/v3/auth/tokens": listing, GET, HEAD, PUT, DELETE, bulk delete.
 * Each bucket follows a behaviour PROFILE: only the ETags, the versions and the dates change. The profiles reproduce
 * behaviours observed on real S3-compatible and Swift providers.
 */
const http = require('http');
const crypto = require('crypto');

const md5 = (data) => crypto.createHash('md5').update(data).digest('hex');
/** Pages are capped below the requested size, like some servers: every listing of the matrix spans several pages */
const PAGE_CAP = 7;
const PART_SIZE = 5 * 1024;
const SWIFT_ROOT = '/v1/AUTH_test';
const ACCOUNT = 'AUTH_test';
/** Header names kept on write, besides the metadata */
const STANDARD_HEADERS = ['content-type', 'content-encoding', 'content-disposition', 'content-language', 'cache-control', 'expires'];

/**
 * - s3-md5: plain S3, ETag = MD5.
 * - s3-sse-md5: server-side encryption that keeps the MD5 ETags.
 * - s3-sse-opaque: server-side encryption where an object copied server-side is LISTED with an opaque 64-hex ETag, while
 *   HEAD/GET return its MD5. The opaque ETag is stable until the object is rewritten. Objects PUT by sclone list their MD5.
 * - s3-versioned: a delete adds a delete marker, the listing shows the current objects only.
 * - s3-multipart: a large object written by another client is a multipart upload (`<hex>-<parts>`), LastModified is the
 *   completion time, not the initiation time.
 * - s3-sse-opaque-versioned: s3-sse-opaque and s3-versioned together.
 * - swift: JSON listing, `last_modified` in microseconds without "Z", a large object is an SLO with a quoted ETag,
 *   marker/limit paging that ends on an empty page, bulk delete.
 */
const PROFILES = {
  's3-md5'                 : { api: 's3' },
  's3-sse-md5'             : { api: 's3', sse: true },
  's3-sse-opaque'          : { api: 's3', sse: true, opaqueCopies: true },
  's3-versioned'           : { api: 's3', versioned: true },
  's3-multipart'           : { api: 's3', multipart: true },
  's3-sse-opaque-versioned': { api: 's3', sse: true, opaqueCopies: true, versioned: true },
  'swift'                  : { api: 'swift' }
};

/** Keys in UTF-8 byte order, the order of the S3 and Swift listings */
const compareUtf8 = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
const escapeXml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const unescapeXml = (s) => s.replace(/&(lt|gt|quot|apos|#(\d+)|#x([0-9a-f]+)|amp);/gi, (_, name, dec, hex) => (dec ? String.fromCodePoint(+dec) : hex ? String.fromCodePoint(parseInt(hex, 16)) : { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }[name]));
const parseQuery = (raw) => Object.fromEntries(raw.split('&').filter(Boolean).map((pair) => pair.split('=').map((part) => decodeURIComponent(part ?? ''))).map(([k, v]) => [k, v ?? '']));

function createFakeStorage () {
  /** Fake clock: one second per write, the dates are deterministic and strictly increasing */
  let clock = Date.UTC(2026, 10, 20, 10, 0, 0);
  const tick = () => (clock += 1000);
  const buckets = { s3: new Map(), swift: new Map() };
  let server = null;

  function createBucket (name, profileName) {
    const profile = PROFILES[profileName];
    if (profile === undefined) {
      throw new Error('unknown profile ' + profileName);
    }
    const objects = new Map();
    const store = (key, body, headers, etags) => {
      const _headers = {};
      for (const [name, value] of Object.entries(headers ?? {})) {
        const _name = name.toLowerCase();
        if (STANDARD_HEADERS.includes(_name) || _name.startsWith(profile.api === 's3' ? 'x-amz-meta-' : 'x-object-meta-')) {
          _headers[_name] = value;
        }
      }
      const _object = { body, headers: _headers, lastModified: tick(), versionId: profile.versioned ? crypto.randomBytes(8).toString('hex') : undefined, ...etags };
      objects.set(key, _object);
      bucket.versions += profile.versioned ? 1 : 0;
      return _object;
    };
    const bucket = {
      name, api: profile.api, profile: profileName, objects,
      /** Requests counted per method (HEAD...), and the versions and delete markers of a versioned bucket */
      counts: {}, versions: 0, deleteMarkers: 0,
      /** Keys deleted by another client just before their next GET: listed, then gone when downloaded */
      vanishOnGet: new Set(),
      /**
       * Write of another client (seed, edit of a user). An opaque profile receives server-side copies, a `large` object is a
       * multipart upload (s3-multipart) or an SLO (swift), anything else is a single PUT
       */
      write (key, body, headers, large = false) {
        if (large === true && profile.multipart === true) {
          const _parts = [];
          for (let i = 0; i < body.length; i += PART_SIZE) {
            _parts.push(Buffer.from(md5(body.subarray(i, i + PART_SIZE)), 'hex'));
          }
          /** Initiated now, completed after the parts: LastModified is the completion time */
          tick();
          const _etag = md5(Buffer.concat(_parts)) + '-' + _parts.length;
          return store(key, body, headers, { etag: _etag, listEtag: _etag });
        }
        if (large === true && profile.api === 'swift') {
          const _segments = [];
          for (let i = 0; i < body.length; i += PART_SIZE) {
            _segments.push(md5(body.subarray(i, i + PART_SIZE)));
          }
          const _etag = `"${md5(_segments.join(''))}"`;
          return store(key, body, headers, { etag: _etag, listEtag: _etag, slo: true });
        }
        if (profile.opaqueCopies === true) {
          return store(key, body, headers, { etag: md5(body), listEtag: crypto.randomBytes(32).toString('hex') });
        }
        return store(key, body, headers, { etag: md5(body), listEtag: md5(body) });
      },
      /** PUT of sclone: a single PUT, listed with its MD5 on every profile */
      put (key, body, headers) {
        return store(key, body, headers, { etag: md5(body), listEtag: md5(body) });
      },
      remove (key) {
        if (objects.delete(key) === false) {
          return false;
        }
        bucket.deleteMarkers += profile.versioned ? 1 : 0;
        return true;
      },
      keys () {
        return [...objects.keys()].sort(compareUtf8);
      },
      /** Objects listed after `after` (exclusive), before `end` (exclusive), with `prefix` */
      page (after, end, prefix, limit) {
        const _keys = bucket.keys().filter((key) => (after === undefined || compareUtf8(key, after) > 0) && (end === undefined || compareUtf8(key, end) < 0) && key.startsWith(prefix ?? ''));
        return { keys: _keys.slice(0, Math.min(limit, PAGE_CAP)), truncated: _keys.length > Math.min(limit, PAGE_CAP) };
      }
    };
    buckets[profile.api].set(name, bucket);
    return bucket;
  }

  function objectHeaders (bucket, object) {
    const _headers = { ...object.headers, 'content-length': object.body.length, 'last-modified': new Date(object.lastModified).toUTCString() };
    _headers['content-type'] ??= bucket.api === 's3' ? 'binary/octet-stream' : 'application/octet-stream';
    if (bucket.api === 's3') {
      _headers.etag = `"${object.etag}"`;
      if (PROFILES[bucket.profile].sse === true) {
        _headers['x-amz-server-side-encryption'] = 'AES256';
      }
      if (object.versionId !== undefined) {
        _headers['x-amz-version-id'] = object.versionId;
      }
    } else {
      _headers.etag = object.etag;
      _headers['x-timestamp'] = (object.lastModified / 1000).toFixed(5);
      if (object.slo === true) {
        _headers['x-static-large-object'] = 'True';
      }
    }
    /** A raw UTF-8 metadata value is sent as its bytes, as real servers do: Node writes header strings as latin1 */
    for (const [name, value] of Object.entries(_headers)) {
      if (typeof value === 'string' && /[^\x00-\xff]/.test(value)) { // eslint-disable-line no-control-regex
        _headers[name] = Buffer.from(value, 'utf8').toString('latin1');
      }
    }
    return _headers;
  }

  function sendObject (req, res, bucket, key) {
    if (req.method === 'GET' && bucket.vanishOnGet.delete(key) === true) {
      bucket.remove(key);
    }
    const _object = bucket.objects.get(key);
    if (_object === undefined) {
      const _headers = PROFILES[bucket.profile].versioned === true && req.method === 'HEAD' ? { 'x-amz-delete-marker': 'true' } : {};
      if (bucket.api === 's3' && req.method === 'GET') {
        return res.writeHead(404, { 'content-type': 'application/xml' }).end('<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>');
      }
      return res.writeHead(404, _headers).end();
    }
    res.writeHead(200, objectHeaders(bucket, _object));
    return res.end(req.method === 'HEAD' ? undefined : _object.body);
  }

  function s3 (req, res, path, query, body) {
    const _slash = path.indexOf('/', 1);
    const _bucket = buckets.s3.get(decodeURIComponent(_slash === -1 ? path.slice(1) : path.slice(1, _slash)));
    const _key = _slash === -1 ? '' : decodeURIComponent(path.slice(_slash + 1));
    if (_bucket === undefined) {
      return res.writeHead(404, { 'content-type': 'application/xml' }).end('<Error><Code>NoSuchBucket</Code></Error>');
    }
    _bucket.counts[req.method] = (_bucket.counts[req.method] ?? 0) + 1;
    const _xml = (xml) => res.writeHead(200, { 'content-type': 'application/xml' }).end('<?xml version="1.0" encoding="UTF-8"?>' + xml);
    if (req.method === 'GET' && _key === '' && query['list-type'] === '2') {
      const _after = query['continuation-token'] !== undefined ? Buffer.from(query['continuation-token'], 'base64').toString('utf8') : query['start-after'];
      const { keys, truncated } = _bucket.page(_after, undefined, query.prefix, Number(query['max-keys'] ?? 1000));
      const _contents = keys.map((key) => {
        const _object = _bucket.objects.get(key);
        return `<Contents><Key>${escapeXml(key)}</Key><LastModified>${new Date(_object.lastModified).toISOString()}</LastModified><ETag>&quot;${_object.listEtag}&quot;</ETag><Size>${_object.body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
      });
      const _next = truncated ? `<NextContinuationToken>${Buffer.from(keys.at(-1), 'utf8').toString('base64')}</NextContinuationToken>` : '';
      return _xml(`<ListBucketResult><Name>${_bucket.name}</Name><Prefix>${escapeXml(query.prefix ?? '')}</Prefix><KeyCount>${keys.length}</KeyCount><MaxKeys>${query['max-keys'] ?? 1000}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${_next}${_contents.join('')}</ListBucketResult>`);
    }
    if (req.method === 'POST' && _key === '' && query.delete !== undefined) {
      /** Grouped <Deleted> elements: the parser of the client keeps the last run of an interleaved tag only */
      const _keys = [...body.toString('utf8').matchAll(/<Key>([^<]*)<\/Key>/g)].map((match) => unescapeXml(match[1]));
      const _versioned = PROFILES[_bucket.profile].versioned === true;
      const _deleted = _keys.map((key) => {
        const _existed = _bucket.remove(key);
        return `<Deleted><Key>${escapeXml(key)}</Key>${_versioned && _existed ? `<DeleteMarker>true</DeleteMarker><DeleteMarkerVersionId>${crypto.randomBytes(8).toString('hex')}</DeleteMarkerVersionId>` : ''}</Deleted>`;
      });
      return _xml(`<DeleteResult>${_deleted.join('')}</DeleteResult>`);
    }
    if (req.method === 'PUT' && _key !== '') {
      const _object = _bucket.put(_key, body, req.headers);
      const _headers = { etag: `"${_object.etag}"` };
      if (_object.versionId !== undefined) {
        _headers['x-amz-version-id'] = _object.versionId;
      }
      return res.writeHead(200, _headers).end();
    }
    if (req.method === 'DELETE' && _key !== '') {
      _bucket.remove(_key);
      return res.writeHead(204).end();
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && _key !== '') {
      return sendObject(req, res, _bucket, _key);
    }
    return res.writeHead(501).end();
  }

  function swift (req, res, path, query, body) {
    if (req.headers['x-auth-token'] !== 'token-test') {
      return res.writeHead(401).end();
    }
    const _rest = path.slice(SWIFT_ROOT.length + 1);
    if (req.method === 'POST' && _rest === '' && query['bulk-delete'] !== undefined) {
      let _deleted = 0;
      let _missing = 0;
      for (const line of body.toString('utf8').split('\n').filter(Boolean)) {
        const _slash = line.indexOf('/');
        const _ok = buckets.swift.get(decodeURIComponent(line.slice(0, _slash)))?.remove(decodeURIComponent(line.slice(_slash + 1)));
        _ok === true ? _deleted++ : _missing++;
      }
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ 'Number Deleted': _deleted, 'Number Not Found': _missing, 'Response Body': '', 'Response Status': '200 OK', Errors: [] }));
    }
    const _slash = _rest.indexOf('/');
    const _container = buckets.swift.get(decodeURIComponent(_slash === -1 ? _rest : _rest.slice(0, _slash)));
    const _key = _slash === -1 ? '' : decodeURIComponent(_rest.slice(_slash + 1));
    if (_container === undefined) {
      return res.writeHead(404).end();
    }
    const _counted = _key === '' ? req.method + '_CONTAINER' : req.method;
    _container.counts[_counted] = (_container.counts[_counted] ?? 0) + 1;
    if (_key === '' && req.method === 'HEAD') {
      return res.writeHead(204, { 'x-container-object-count': _container.objects.size }).end();
    }
    if (_key === '' && req.method === 'GET') {
      const { keys } = _container.page(query.marker || undefined, query.end_marker || undefined, query.prefix, Number(query.limit ?? 10000));
      const _list = keys.map((key) => {
        const _object = _container.objects.get(key);
        /** Microseconds, without "Z" */
        const _date = new Date(_object.lastModified).toISOString().slice(0, -1) + '123';
        return { name: key, hash: _object.listEtag, bytes: _object.body.length, content_type: _object.headers['content-type'] ?? 'application/octet-stream', last_modified: _date };
      });
      return res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(_list));
    }
    if (req.method === 'PUT') {
      return res.writeHead(201, { etag: _container.put(_key, body, req.headers).etag }).end();
    }
    if (req.method === 'DELETE') {
      return res.writeHead(_container.remove(_key) ? 204 : 404).end();
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      return sendObject(req, res, _container, _key);
    }
    return res.writeHead(501).end();
  }

  function keystone (res) {
    const _url = `http://127.0.0.1:${server.address().port}/v1/${ACCOUNT}`;
    res.writeHead(201, { 'content-type': 'application/json', 'x-subject-token': 'token-test' });
    return res.end(JSON.stringify({ token: { catalog: [{ type: 'object-store', name: 'swift', endpoints: [{ region: 'REGION-1', interface: 'public', url: _url }] }] } }));
  }

  function handle (req, res) {
    const _chunks = [];
    req.on('data', (chunk) => _chunks.push(chunk));
    req.on('end', () => {
      const _index = req.url.indexOf('?');
      const _path = _index === -1 ? req.url : req.url.slice(0, _index);
      const _query = _index === -1 ? {} : parseQuery(req.url.slice(_index + 1));
      const _body = Buffer.concat(_chunks);
      try {
        if (req.method === 'POST' && _path === '/v3/auth/tokens') {
          return keystone(res);
        }
        if (_path === SWIFT_ROOT || _path.startsWith(SWIFT_ROOT + '/')) {
          return swift(req, res, _path, _query, _body);
        }
        return s3(req, res, _path, _query, _body);
      } catch (err) {
        return res.writeHead(500).end(String(err));
      }
    });
  }

  return {
    PROFILES,
    /** Start the server on a random local port */
    start (callback) {
      server = http.createServer(handle);
      server.listen(0, '127.0.0.1', callback);
    },
    stop (callback) {
      server.closeAllConnections();
      server.close(callback);
    },
    /** Remove every bucket, then create the given ones */
    reset () {
      buckets.s3.clear();
      buckets.swift.clear();
    },
    bucket: createBucket,
    /** Storage configuration of sclone for a bucket */
    config (bucket) {
      const _url = `http://127.0.0.1:${server.address().port}`;
      if (bucket.api === 's3') {
        return { name: 's3', accessKeyId: 'access-key-id', secretAccessKey: 'secret-access-key', url: _url, region: 'region-1', bucket: bucket.name };
      }
      return { name: 'swift', authUrl: _url + '/v3', username: 'user-test', password: 'password-test', tenantName: 'tenant-test', region: 'REGION-1', bucket: bucket.name };
    }
  };
}

module.exports = { createFakeStorage, PROFILES, md5 };
