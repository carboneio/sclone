const assert = require('assert');
const storage = require('../storage');
const nock = require('nock');
const path = require('path');
const fs = require('fs');
const helper = require('../helper');
const zlib = require('zlib');
const { captureLogs } = require('./support/logs');

/**
 * TODO:
 * - [ ] test deleting source files with `syncFiles`
 * - [ ] test `maxDeletion` options
 */

const files = {
  target        : new Map(),
  source        : new Map(),
  cache         : new Map(),
};
const urlS3 = 'https://s3.gra.first.cloud.test';
const urlS3SBG = 'https://s3.sbg.first.cloud.test';

const urlAuthSwift   = 'https://auth.cloud.ovh.net/v3';
const urlSwift = 'https://storage.gra.cloud.ovh.net/v1/AUTH_ce3e510224d740a685cb0ae7bdb8ebc3';
const urlSwiftSBG = 'https://storage.sbg.cloud.ovh.net/v1/AUTH_ce3e510224d740a685cb0ae7bdb8ebc3';
const tokenAuthSwift = 'gAAAAABe8JlEGYPUwwOyjqgUBl11gSjDOw5VTtUZ5n8SWxghRGwakDkP_lelLfRctzyhbIFUXjsdPaGmV2xicL-9333lJUnL3M4JYlYCYMWsX3IhnLPYboyti835VdhAHQ7K_d0OC4OYvM04bvL3w_uSbkxPmL27uO0ISUgQdB_mHxoYlol8xYI';


let _config = {};

/**
 * Random listing for the property tests of fetchListFiles: unique keys (unicode, XML special characters), split into pages
 * of 1 to 7 files. Seeded: a failure can be replayed.
 */
function randomListing (seed) {
  let _state = seed;
  const _random = (max) => {
    _state = (_state * 1103515245 + 12345) % 2147483648;
    return Math.floor(_state / 65536) % max;
  };
  const _chars = ['a', 'Z', '0', '9', '/', '-', '_', '.', ' ', 'é', 'ü', '日', '本', '😀', '&', '<', '>', '"', '\'', '%', '+', '#'];
  const _keys = new Set();
  const _count = _random(40);
  while (_keys.size < _count) {
    let _key = 'k';
    for (let i = _random(12); i >= 0; i--) {
      _key += _chars[_random(_chars.length)];
    }
    _keys.add(_key);
  }
  const _pages = [];
  let _page = [];
  for (const _key of _keys) {
    const _hash = require('crypto').createHash('md5').update(_key).digest('hex');
    _page.push({ key: _key, hash: _hash, lastModified: new Date(1700000000000 + _random(1e9)).toISOString().slice(0, -1), bytes: _random(1e6) });
    if (_page.length >= 1 + _random(7)) {
      _pages.push(_page);
      _page = [];
    }
  }
  if (_page.length > 0 || _pages.length === 0) {
    _pages.push(_page);
  }
  /** Pages answered with a 503 before the success: retried, never inserted twice nor skipped */
  const _failures = _pages.map(() => _random(4) === 0 ? 1 + _random(2) : 0);
  return { pages: _pages, failures: _failures };
}

/** Listing as built before the listing page by page: every page collected, then converted in order */
function expectedListing (pages) {
  const _map = new Map();
  for (const _object of pages.flat()) {
    _map.set(_object.key, { key: _object.key, md5: _object.hash, lastmodified: new Date(_object.lastModified + 'Z').getTime(), bytes: _object.bytes, cachedEtag: undefined, cachedBytes: undefined });
  }
  return _map;
}

/** Realistic S3 DeleteObjects response: every key of the request body is reported as deleted */
function deleteResultFromRequest (body) {
  const _keys = body.match(/<Key>[^<]*<\/Key>/g) ?? [];
  return '<?xml version="1.0" encoding="UTF-8"?><DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' + _keys.map((key) => `<Deleted>${key}</Deleted>`).join('') + '</DeleteResult>';
}

describe("storage", function() {

  beforeEach(function(done) {
    const nockAuthSwift = nock(urlAuthSwift)
      .post('/auth/tokens')
      .reply(200, connectionResultSuccessV3, { "X-Subject-Token": tokenAuthSwift });

    const nockAuthS3 = nock(urlS3)
      .defaultReplyHeaders({ 'content-type': 'application/xml' })
      .get('/invoices').query({ 'list-type': '2', 'max-keys': '1' })
      .reply(200, () => {
        return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListBucketResult><Name>invoices</Name><KeyCount>0</KeyCount><MaxKeys>1</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>";
      });

    helper.loadConfig(path.join(__dirname, 'config.test-swift-s3.json'), function(err, config) {
      assert.strictEqual(err, null);
      _config = config;
      storage.connection(_config, 'source', function(err) {
        assert.strictEqual(err, undefined);
          storage.connection(_config, 'target', function(err) {
          assert.strictEqual(err, undefined);
          assert.strictEqual(nockAuthSwift.pendingMocks().length, 0);
          assert.strictEqual(nockAuthS3.pendingMocks().length, 0);
          files.source = new Map();
          files.target = new Map();
          files.cache = new Map();
          return done();
        });
      });
    });

  });

  describe('syncFiles', function() {

    it('should bulkDeletes objects on the target (S3) (less than 1000 objects)', function(done) {
      const nockBulkDeleteS3 = nock(urlS3)
        .post('/invoices/')
        .query((actualQueryObject) => {
          assert.strictEqual(actualQueryObject.delete !== undefined, true);
          return true;
        })
        .reply(200, (uri, body) => {
          assert.strictEqual(body, "<Delete><Object><Key>file1.txt</Key></Object><Object><Key>file2.txt</Key></Object><Object><Key>file3.txt</Key></Object><Object><Key>file4.txt</Key></Object><Quiet>false</Quiet></Delete>");
          return deleteResultFromRequest(body);
        });

      const _filestoDeleteTarget = [
        { 'key': 'file1.txt'  },
        { 'key': 'file2.txt' },
        { 'key': 'file3.txt' },
        { 'key': 'file4.txt' }
      ];
      storage.syncFiles([], _filestoDeleteTarget, [], [], { mode: helper.MODES.BI }, function(err) {
        assert.strictEqual(err, undefined);
        assert.strictEqual(nockBulkDeleteS3.pendingMocks().length, 0);
        done();
      });
    });

    it('should bulkDeletes objects on the target (S3) whose keys contain XML special characters', function(done) {
      const nockBulkDeleteS3 = nock(urlS3)
        .post('/invoices/')
        .query((actualQueryObject) => actualQueryObject.delete !== undefined)
        .reply(200, (uri, body) => {
          assert.strictEqual(body, "<Delete><Object><Key>R&amp;D &lt;2024&gt;.pdf</Key></Object><Object><Key>l&apos;offre &quot;v2&quot;.pdf</Key></Object><Quiet>false</Quiet></Delete>");
          return deleteResultFromRequest(body);
        });

      storage.syncFiles([], [{ key: 'R&D <2024>.pdf' }, { key: 'l\'offre "v2".pdf' }], [], [], { mode: helper.MODES.BI }, function(err) {
        assert.strictEqual(err, undefined);
        assert.strictEqual(nockBulkDeleteS3.pendingMocks().length, 0);
        done();
      });
    });

    it('should bulkDeletes objects on the S3 and should split the list into 2 chunk of 1000 objects (more than 1000 objects)', function(done) {
      const nockBulkDeleteS3 = nock(urlS3)
        .post('/invoices/')
        .query((actualQueryObject) => {
          assert.strictEqual(actualQueryObject.delete !== undefined, true);
          return true;
        })
        .reply(200, (uri, body) => {
          assert.strictEqual(body.split("files").length - 1, 1000);
          return deleteResultFromRequest(body);
        })
        .post('/invoices/')
        .query((actualQueryObject) => {
          assert.strictEqual(actualQueryObject.delete !== undefined, true);
          return true;
        })
        .reply(200, (uri, body) => {
          assert.strictEqual(body.split("files").length - 1, 1000);
          return deleteResultFromRequest(body);
        });

      const _filestoDeleteS3 = [];

      for (let i = 0; i < 2000; i++) {
        _filestoDeleteS3.push({ key: `files${i}.txt` });
      }
      storage.syncFiles([], _filestoDeleteS3, [], [], { mode: helper.MODES.BI }, function(err) {
        assert.strictEqual(err, undefined);
        assert.strictEqual(nockBulkDeleteS3.pendingMocks().length, 0);
        done();
      });
    });

    describe('Files not deleted', function() {
      let _logs = null;

      beforeEach(function() {
        _logs = captureLogs();
      });

      afterEach(function() {
        _logs.restore();
        nock.cleanAll();
      });

      /** The cause of each failed operation is logged by a "transfer_failed" line */
      const _assertDeleteError = (queueName, expectedMessage, done) => (err, stats) => {
        assert.strictEqual(err instanceof Error, true);
        assert.strictEqual(err.toString().includes(`${queueName} | 1 operation(s) failed`), true, err.toString());
        const _failures = _logs.filter('transfer_failed');
        assert.strictEqual(_failures.length, 1, _logs.lines.join(''));
        assert.strictEqual(_failures[0].queue, queueName);
        assert.strictEqual(_failures[0].op, 'delete');
        assert.strictEqual(_failures[0].direction, queueName === 'delete-files-target' ? 'source_to_target' : 'target_to_source');
        assert.strictEqual(_failures[0].try, 0);
        assert.strictEqual(_failures[0].error.includes(expectedMessage), true, _failures[0].error);
        /** The number of files of the chunk */
        assert.strictEqual(stats.failed, _failures[0].count);
        assert.strictEqual(stats.deleted, 0);
        done();
      };

      it('should return an error if S3 does not delete some files (status 200 with errors per file)', function(done) {
        const nockBulkDeleteS3 = nock(urlS3)
          .post('/invoices/')
          .query((actualQueryObject) => actualQueryObject.delete !== undefined)
          .reply(200, '<?xml version="1.0" encoding="UTF-8"?><DeleteResult><Deleted><Key>file1.txt</Key></Deleted><Error><Key>file2.txt</Key><Code>AccessDenied</Code><Message>Access Denied</Message></Error></DeleteResult>');

        storage.syncFiles([], [{ key: 'file1.txt' }, { key: 'file2.txt' }], [], [], { mode: helper.MODES.BI }, _assertDeleteError('delete-files-target', 'S3 Delete files | 1/2 file(s) not deleted | file2.txt: AccessDenied', () => {
          assert.strictEqual(nockBulkDeleteS3.pendingMocks().length, 0);
          done();
        }));
      });

      it('should return an error if S3 replies 200 without a DeleteResult (the deletion is not confirmed)', function(done) {
        /** For instance a proxy page: the objects are not deleted, the caller must not save the cache */
        const nockBulkDeleteS3 = nock(urlS3)
          .defaultReplyHeaders({ 'content-type': 'text/html' })
          .post('/invoices/')
          .query((actualQueryObject) => actualQueryObject.delete !== undefined)
          .reply(200, '<html><body><h1>Service Unavailable</h1></body></html>');

        storage.syncFiles([], [{ key: 'file1.txt' }], [], [], { mode: helper.MODES.BI }, _assertDeleteError('delete-files-target', '"DeleteResult" not found', () => {
          assert.strictEqual(nockBulkDeleteS3.pendingMocks().length, 0);
          done();
        }));
      });

      it('should not return an error if S3 deletes all files', function(done) {
        const nockBulkDeleteS3 = nock(urlS3)
          .post('/invoices/')
          .query((actualQueryObject) => actualQueryObject.delete !== undefined)
          .reply(200, '<?xml version="1.0" encoding="UTF-8"?><DeleteResult><Deleted><Key>file1.txt</Key></Deleted><Deleted><Key>file2.txt</Key></Deleted></DeleteResult>');

        storage.syncFiles([], [{ key: 'file1.txt' }, { key: 'file2.txt' }], [], [], { mode: helper.MODES.BI }, function(err) {
          assert.strictEqual(err, undefined);
          assert.strictEqual(nockBulkDeleteS3.pendingMocks().length, 0);
          done();
        });
      });

      it('should list the first 10 files not deleted only', function(done) {
        const _keys = Array.from({ length: 12 }, (value, i) => `file${i}.txt`);
        nock(urlS3)
          .post('/invoices/')
          .query((actualQueryObject) => actualQueryObject.delete !== undefined)
          .reply(200, '<?xml version="1.0" encoding="UTF-8"?><DeleteResult>' + _keys.map((key) => `<Error><Key>${key}</Key><Code>AccessDenied</Code></Error>`).join('') + '</DeleteResult>');

        storage.syncFiles([], _keys.map((key) => ({ key })), [], [], { mode: helper.MODES.BI }, _assertDeleteError('delete-files-target', 'file9.txt: AccessDenied, ... (2 more)', done));
      });

      it('should return an error if the SWIFT bulk delete does not delete some files', function(done) {
        const nockBulkDeleteSwift = nock(urlSwift)
          .post('/')
          .query(true)
          .reply(200, { 'Number Not Found': 0, 'Response Status': '400 Bad Request', 'Response Body': '', 'Errors': [['/invoices/old2.txt', '403 Forbidden']], 'Number Deleted': 1 });

        storage.syncFiles([], [], [], [{ key: 'old1.txt' }, { key: 'old2.txt' }], { mode: helper.MODES.BI }, _assertDeleteError('delete-files-source', 'Swift Delete files | 1/2 file(s) not deleted | Response Status: 400 Bad Request | /invoices/old2.txt: 403 Forbidden', () => {
          assert.strictEqual(nockBulkDeleteSwift.pendingMocks().length, 0);
          done();
        }));
      });

      it('should return an error if the SWIFT bulk delete fails (status code)', function(done) {
        nock(urlSwift)
          .post('/')
          .query(true)
          .reply(403, 'Forbidden');

        storage.syncFiles([], [], [], [{ key: 'old1.txt' }], { mode: helper.MODES.BI }, _assertDeleteError('delete-files-source', 'Swift Delete files | Status code 403', () => {
          assert.strictEqual(_logs.filter('transfer_failed')[0].status, 403);
          assert.strictEqual(_logs.filter('transfer_failed')[0].key, 'old1.txt');
          done();
        }));
      });

      it('should return an error if the SWIFT bulk delete response cannot be read', function(done) {
        nock(urlSwift)
          .post('/')
          .query(true)
          .reply(200, '<html><body>OK</body></html>', { 'content-type': 'text/html' });

        storage.syncFiles([], [], [], [{ key: 'old1.txt' }], { mode: helper.MODES.BI }, _assertDeleteError('delete-files-source', 'Swift Delete files | Unexpected response, the deleted files cannot be checked | <html><body>OK</body></html>', done));
      });

      it('should print the unexpected JSON body of the SWIFT bulk delete in the error', function(done) {
        nock(urlSwift)
          .post('/')
          .query(true)
          .reply(200, { 'Number Deleted': 1 });

        storage.syncFiles([], [], [], [{ key: 'old1.txt' }], { mode: helper.MODES.BI }, _assertDeleteError('delete-files-source', 'cannot be checked | {"Number Deleted":1}', done));
      });

      it('should not return an error if the SWIFT bulk delete does not find a file (already deleted)', function(done) {
        const nockBulkDeleteSwift = nock(urlSwift)
          .post('/', (body) => body === 'invoices/old1.txt\ninvoices/old2.txt\n')
          .query(true)
          .reply(200, { 'Number Not Found': 1, 'Response Status': '200 OK', 'Response Body': '', 'Errors': [], 'Number Deleted': 1 });

        storage.syncFiles([], [], [], [{ key: 'old1.txt' }, { key: 'old2.txt' }], { mode: helper.MODES.BI }, function(err, stats) {
          assert.strictEqual(err, undefined);
          assert.strictEqual(stats.deleted, 2);
          assert.strictEqual(_logs.filter('transfer_failed').length, 0);
          assert.strictEqual(nockBulkDeleteSwift.pendingMocks().length, 0);
          done();
        });
      });
    });

    it('should upload objects on the target storage with headers (S3)', function(done) {

      const _fileContent = Buffer.from('Hello1234');

      const nockS3Upload = nock(urlS3, {
          reqheaders: {
            'x-amz-meta-name': () => true,
            'x-amz-meta-desc': () => true,
            'content-type': () => true,
          }
        })
        .put('/invoices/1!file.txt')
        .reply(200, (uri, requestBody) => {
          assert.strictEqual(requestBody, _fileContent.toString());
          return '';
        });

      const nockSwiftDownload = nock(urlSwift)
        .defaultReplyHeaders({
          'x-object-meta-name': 'RÃ©capitulatif des quantitÃ©s sa',
          'x-object-meta-desc': 'RÃ©capitulatif des quantitÃ©s saisies par Ã©lÃ©ment de repas dans chaque trame de menu par site',
          'last-modified': 'Thu, 23 Feb 2023 01:14:34 GMT',
          'accept-ranges': 'bytes',
          etag: '84f955aea2728719fdeca60fbcb98494',
          'x-timestamp': '1677114873.57139',
          'content-type': 'application/vnd.oasis.opendocument.spreadsheet',
          'x-trans-id': 'txf38b8c7f1a5945b2b93c8-0064520f5f',
          'x-openstack-request-id': 'txf38b8c7f1a5945b2b93c8-0064520f5f',
          date: 'Wed, 03 May 2023 07:38:07 GMT',
          'x-iplb-request-id': '25A903A8:1DC8_5762BBC9:01BB_64520F5E_267D4F42:133BB',
          'x-iplb-instance': '42085'
        })
        .get('/invoices/1!file.txt')
        .reply(200, () => {
          return _fileContent;
        });

      const _filesToUploadS3 = [];

      _filesToUploadS3.push({ key: `1!file.txt` });

      storage.syncFiles(_filesToUploadS3, [], [], [], { mode: helper.MODES.BI }, function(err) {
        assert.strictEqual(err, undefined);
        assert.strictEqual(nockS3Upload.pendingMocks().length, 0);
        assert.strictEqual(nockSwiftDownload.pendingMocks().length, 0);
        done();
      });
    });

    it('should upload objects on the source storage (swift)', function(done) {

      const _fileContent = Buffer.from('Hello1234');

      const nockS3Download = nock(urlS3)
        .defaultReplyHeaders({
          'x-amz-meta-name': 'R%C3%83%C2%A9capitulatif%20des%20quantit%C3%83%C2%A9s%20sa',
          'x-amz-meta-desc': 'R%C3%83%C2%A9capitulatif%20des%20quantit%C3%83%C2%A9s%20saisies%20par%20%C3%83%C2%A9l%C3%83%C2%A9ment%20de%20repas%20dans%20chaque%20trame%20de%20menu%20par%20site',
          'content-type': 'application/vnd.oasis.opendocument.spreadsheet'
        })
        .get('/invoices/1-file.txt')
        .reply(200, () => {
          return _fileContent;
        });

      const nockSwiftUpload = nock(urlSwift, {
          reqheaders: {
            'x-object-meta-name': () => true,
            'x-object-meta-desc': () => true,
            'content-type': () => true,
          }
        })
        .put('/invoices/1-file.txt')
        .reply(201, (uri, requestBody) => {
          assert.strictEqual(requestBody, _fileContent.toString());
          return '';
        });

      const _filesToUploadSwift = [];

      _filesToUploadSwift.push({ key: `1-file.txt` });

      storage.syncFiles([], [], _filesToUploadSwift, [], { mode: helper.MODES.BI }, function(err) {
        assert.strictEqual(err, undefined);
        assert.strictEqual(nockS3Download.pendingMocks().length, 0);
        assert.strictEqual(nockSwiftUpload.pendingMocks().length, 0);
        done();
      });
    });

    /** Swift returns the 4xx errors without any error: the error page was uploaded as the content of the file */
    for (const _status of [404, 403, 429, 498]) {
      it(`should not upload the body of a Swift download error (status ${_status})`, function(done) {
        const nockSwiftDownload = nock(urlSwift)
          .defaultReplyHeaders({ 'content-type': 'text/html; charset=UTF-8' })
          .get('/invoices/file.pdf')
          /** rock-req retries a 429 once */
          .times(_status === 429 ? 2 : 1)
          .reply(_status, '<html><h1>Error</h1></html>');
        const nockS3Upload = nock(urlS3)
          .put('/invoices/file.pdf')
          .reply(200, '');

        storage.syncFiles([{ key: 'file.pdf' }], [], [], [], { mode: helper.MODES.UNI }, function(err, stats) {
          if (_status === 404) {
            /** Deleted after the listing: skipped, not a failure */
            assert.strictEqual(err, undefined);
            assert.strictEqual(stats.skipped, 1);
          } else {
            assert.strictEqual(err instanceof Error, true);
            assert.strictEqual(err.toString().includes('upload-from-source-to-target | 1 operation(s) failed'), true, err.toString());
          }
          assert.strictEqual(nockSwiftDownload.pendingMocks().length, 0);
          assert.strictEqual(nockS3Upload.pendingMocks().length, 1);
          nock.cleanAll();
          done();
        });
      });
    }

    /** A refused upload counted as synchronised is saved in the cache: in bidirectional mode, the next run deletes the file from the other storage */
    for (const _status of [403, 404, 413, 422]) {
      it(`should return an error if a Swift upload is refused (status ${_status})`, function(done) {
        const nockS3Download = nock(urlS3)
          .get('/invoices/file.pdf')
          .reply(200, 'Hello1234');
        const nockSwiftUpload = nock(urlSwift)
          .put('/invoices/file.pdf')
          .reply(_status, '<html><h1>Error</h1></html>');

        storage.syncFiles([], [], [{ key: 'file.pdf' }], [], { mode: helper.MODES.BI }, function(err) {
          assert.strictEqual(err instanceof Error, true);
          assert.strictEqual(err.toString().includes('upload-from-target-to-source | 1 operation(s) failed'), true, err.toString());
          assert.strictEqual(nockS3Download.pendingMocks().length, 0);
          assert.strictEqual(nockSwiftUpload.pendingMocks().length, 0);
          done();
        });
      });
    }

    describe('Tokens recorded in the cache', function() {
      const _md5 = (str) => require('crypto').createHash('md5').update(str).digest('hex');

      afterEach(function() {
        nock.cleanAll();
      });

      it('should keep the etag returned by the upload (S3 PUT) and the stored size on the transferred object', function(done) {
        nock(urlSwift).get('/invoices/a.pdf').reply(200, 'Hello1234', { etag: _md5('Hello1234') });
        nock(urlS3).put('/invoices/a.pdf').reply(200, '', { etag: '"0123456789abcdef0123456789abcdef"' });
        const _object = { key: 'a.pdf', md5: _md5('Hello1234'), bytes: 9 };
        storage.syncFiles([_object], [], [], [], { mode: helper.MODES.UNI }, function(err) {
          assert.strictEqual(err, undefined);
          assert.deepStrictEqual(_object.copied, { etag: '0123456789abcdef0123456789abcdef', bytes: 9, sourceChanged: false });
          done();
        });
      });

      it('should use the MD5 of the body if the upload response has no etag (SWIFT PUT)', function(done) {
        nock(urlS3).get('/invoices/b.pdf').reply(200, 'Hello');
        nock(urlSwift).put('/invoices/b.pdf').reply(201, '');
        const _object = { key: 'b.pdf', md5: _md5('Hello'), bytes: 5 };
        storage.syncFiles([], [], [_object], [], { mode: helper.MODES.BI }, function(err) {
          assert.strictEqual(err, undefined);
          assert.deepStrictEqual(_object.copied, { etag: _md5('Hello'), bytes: 5, sourceChanged: false });
          done();
        });
      });

      it('should flag an S3 object rewritten after the listing (downloaded etag different from the listed MD5)', function(done) {
        nock(urlS3).get('/invoices/c.pdf').reply(200, 'Version2', { etag: `"${_md5('Version2')}"` });
        nock(urlSwift).put('/invoices/c.pdf').reply(201, '', { etag: _md5('Version2') });
        const _object = { key: 'c.pdf', md5: _md5('Version1'), bytes: 8 };
        storage.syncFiles([], [], [_object], [], { mode: helper.MODES.BI }, function(err) {
          assert.strictEqual(err, undefined);
          assert.strictEqual(_object.copied.sourceChanged, true);
          done();
        });
      });

      it('should flag a Swift object rewritten after the listing, but never a Swift large object (its GET etag is not its listed hash)', function(done) {
        nock(urlSwift).get('/invoices/f.pdf').reply(200, 'Version2', { etag: _md5('Version2') });
        nock(urlSwift).get('/invoices/slo.pdf').reply(200, 'Version1', { etag: `"${_md5('segments')}"`, 'x-static-large-object': 'True' });
        nock(urlSwift).get('/invoices/dlo.pdf').reply(200, 'Version1', { etag: `"${_md5('segments')}"`, 'x-object-manifest': 'segments/dlo' });
        nock(urlS3).put(/\/invoices\/(f|slo|dlo)\.pdf/).times(3).reply(200, '');
        const _objects = [{ key: 'f.pdf', md5: _md5('Version1'), bytes: 8 }, { key: 'slo.pdf', md5: _md5('Version1'), bytes: 8 }, { key: 'dlo.pdf', md5: 'd41d8cd98f00b204e9800998ecf8427e', bytes: 0 }];
        storage.syncFiles(_objects, [], [], [], { mode: helper.MODES.UNI }, function(err) {
          assert.strictEqual(err, undefined);
          assert.deepStrictEqual(_objects.map((o) => o.copied.sourceChanged), [true, false, false]);
          done();
        });
      });

      it('should not flag a multipart or opaque listed etag as rewritten', function(done) {
        nock(urlS3).get('/invoices/d.pdf').reply(200, 'Hello', { etag: `"${_md5('Hello')}"` });
        nock(urlS3).get('/invoices/e.pdf').reply(200, 'Hello', { etag: `"${_md5('Hello')}"` });
        nock(urlSwift).put(/\/invoices\/[de]\.pdf/).times(2).reply(201, '');
        const _objects = [{ key: 'd.pdf', md5: 'b62e2a390d253298e9f061541ec39fc6-2', bytes: 5 }, { key: 'e.pdf', md5: 'e'.repeat(64), bytes: 5 }];
        storage.syncFiles([], [], _objects, [], { mode: helper.MODES.BI }, function(err) {
          assert.strictEqual(err, undefined);
          assert.deepStrictEqual(_objects.map((o) => o.copied.sourceChanged), [false, false]);
          done();
        });
      });

      it('should flag the deleted objects, and not the objects of a failed chunk', function(done) {
        nock(urlS3).post('/invoices/').query({ delete: '' }).reply(200, (uri, body) => deleteResultFromRequest(body));
        const _deleted = [{ key: 'a.pdf' }, { key: 'b.pdf' }];
        storage.syncFiles([], _deleted, [], [], { mode: helper.MODES.UNI }, function(err) {
          assert.strictEqual(err, undefined);
          assert.deepStrictEqual(_deleted.map((o) => o.deleted), [true, true]);
          nock(urlS3).post('/invoices/').query({ delete: '' }).reply(500, '');
          const _failed = [{ key: 'c.pdf' }];
          storage.syncFiles([], _failed, [], [], { mode: helper.MODES.UNI }, function(err) {
            assert.strictEqual(err instanceof Error, true);
            assert.strictEqual(_failed[0].deleted, undefined);
            done();
          });
        });
      });
    });

    describe('Permanent errors', function() {
      let _logs = null;

      beforeEach(function() {
        _logs = captureLogs();
      });

      afterEach(function() {
        _logs.restore();
        nock.cleanAll();
      });

      const _s3Error = (code) => `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>error</Message></Error>`;

      it('should not retry an upload refused with a 403 (AccessDenied): one "transfer_failed" line with the S3 error code', function(done) {
        nock(urlSwift).get('/invoices/a.pdf').reply(200, 'Hello');
        const nockUpload = nock(urlS3).put('/invoices/a.pdf').reply(403, _s3Error('AccessDenied'), { 'content-type': 'application/xml' });
        storage.syncFiles([{ key: 'a.pdf', bytes: 5 }], [], [], [], { mode: helper.MODES.UNI, retry: 3 }, function(err, stats) {
          assert.strictEqual(err instanceof Error, true);
          assert.strictEqual(err.toString().includes('upload-from-source-to-target | 1 operation(s) failed'), true, err.toString());
          assert.strictEqual(nockUpload.pendingMocks().length, 0);
          assert.deepStrictEqual(stats, { uploaded: 0, uploaded_bytes: 0, deleted: 0, skipped: 0, failed: 1 });
          const _failures = _logs.filter('transfer_failed');
          assert.deepStrictEqual(_failures.map((l) => [l.key, l.phase, l.status, l.code, l.reason, l.try]), [['a.pdf', 'upload', 403, 'AccessDenied', 'permanent', 0]]);
          assert.strictEqual(_logs.filter('queue_retry').length, 0);
          done();
        });
      });

      it('should copy a raw UTF-8 metadata which looks already encoded or holds a "%" (never an invalid header)', function(done) {
        const _raw = (text) => Buffer.from(text, 'utf8').toString('latin1');
        nock(urlSwift).get('/invoices/a.pdf').reply(200, 'Hello', { 'x-object-meta-note': _raw('Réduction — 50%'), 'x-object-meta-enc': _raw('R%C3%A9sum%C3%A9 €') });
        const nockUpload = nock(urlS3, { reqheaders: { 'x-amz-meta-note': 'R%C3%A9duction %E2%80%94 50%', 'x-amz-meta-enc': 'R%C3%A9sum%C3%A9 %E2%82%AC' } }).put('/invoices/a.pdf').reply(200, '');
        storage.syncFiles([{ key: 'a.pdf', bytes: 5 }], [], [], [], { mode: helper.MODES.UNI }, function(err, stats) {
          assert.strictEqual(err, undefined);
          assert.strictEqual(nockUpload.pendingMocks().length, 0);
          assert.strictEqual(stats.uploaded, 1);
          done();
        });
      });

      it('should count an upload refused synchronously (invalid header, invalid name...) as failed, never crash', function(done) {
        nock(urlSwift).get('/invoices/a.pdf').reply(200, 'Hello');
        /** The request of the upload throws before being sent: a lone surrogate cannot be encoded in the URL */
        storage.syncFiles([{ key: 'a.pdf', target: 'b\uD800', bytes: 5 }], [], [], [], { mode: helper.MODES.UNI, retry: 0 }, function(err, stats) {
          assert.strictEqual(err instanceof Error, true);
          assert.strictEqual(stats.failed, 1);
          assert.deepStrictEqual(_logs.filter('transfer_failed').map((l) => [l.key, l.phase]), [['a.pdf', 'upload']]);
          done();
        });
      });

      it('should skip, without retrying, a download refused with a 404 (NoSuchKey): deleted after the listing', function(done) {
        const nockDownload = nock(urlS3).get('/invoices/gone.pdf').reply(404, _s3Error('NoSuchKey'), { 'content-type': 'application/xml' });
        storage.syncFiles([], [], [{ key: 'gone.pdf', bytes: 5 }], [], { mode: helper.MODES.BI, retry: 3 }, function(err, stats) {
          assert.strictEqual(err, undefined);
          assert.strictEqual(nockDownload.pendingMocks().length, 0);
          assert.deepStrictEqual(stats, { uploaded: 0, uploaded_bytes: 0, deleted: 0, skipped: 1, failed: 0 });
          assert.deepStrictEqual(_logs.filter('transfer_failed'), []);
          assert.deepStrictEqual(_logs.filter('transfer_skipped').map((l) => [l.key, l.phase, l.status, l.reason]), [['gone.pdf', 'download', 404, 'source_gone']]);
          done();
        });
      });

      for (const [_status, _code] of [[403, 'InvalidObjectState'], [400, 'InvalidRequest']]) {
        it(`should not retry a download refused with a ${_status} (${_code})`, function(done) {
          const nockDownload = nock(urlS3).get('/invoices/archived.pdf').reply(_status, _s3Error(_code), { 'content-type': 'application/xml' });
          storage.syncFiles([], [], [{ key: 'archived.pdf', bytes: 5 }], [], { mode: helper.MODES.BI, retry: 3 }, function(err, stats) {
            assert.strictEqual(err instanceof Error, true);
            assert.strictEqual(nockDownload.pendingMocks().length, 0);
            assert.strictEqual(stats.failed, 1);
            const _failures = _logs.filter('transfer_failed');
            assert.strictEqual(_failures.length, 1);
            assert.strictEqual(_failures[0].reason, 'permanent');
            assert.strictEqual(_failures[0].status, _status);
            done();
          });
        });
      }

      it('should not transfer an object larger than 5 GiB to an S3 target', function(done) {
        const _object = { key: 'huge.iso', bytes: 5 * 1024 ** 3 + 1 };
        storage.syncFiles([_object], [], [], [], { mode: helper.MODES.UNI, retry: 3 }, function(err, stats) {
          assert.strictEqual(err instanceof Error, true);
          assert.strictEqual(stats.failed, 1);
          const _tooLarge = _logs.filter('transfer_failed').filter((l) => l.reason === 'too_large');
          assert.deepStrictEqual(_tooLarge.map((l) => [l.key, l.phase]), [['huge.iso', 'upload']]);
          assert.strictEqual(_object.copied, undefined);
          done();
        });
      });
    });

    it('should not transfer an object larger than 5 GiB to a Swift target (default limit of a Swift object)', function(done) {
      const _logs = captureLogs();
      const _object = { key: 'huge.iso', bytes: 5 * 1024 ** 3 + 1 };
      storage.syncFiles([], [], [_object], [], { mode: helper.MODES.BI }, function(err, stats) {
        _logs.restore();
        assert.strictEqual(err instanceof Error, true);
        assert.strictEqual(stats.failed, 1);
        assert.deepStrictEqual(_logs.filter('transfer_failed').map((l) => [l.key, l.reason, l.direction]), [['huge.iso', 'too_large', 'target_to_source']]);
        done();
      });
    });

    describe('Swift versioning (X-Versions-Location)', function() {
      let _logs = null;

      beforeEach(function() {
        _logs = captureLogs();
        nock(urlAuthSwift).post('/auth/tokens').reply(200, connectionResultSuccessV3, { "X-Subject-Token": tokenAuthSwift });
      });

      afterEach(function() {
        _logs.restore();
        nock.cleanAll();
      });

      it('should refuse the deletions on a Swift container with "X-Versions-Location" (a DELETE restores the previous version)', function(done) {
        const _head = nock(urlSwift).head('/invoices').reply(204, '', { 'x-versions-location': 'invoices_versions' });
        storage.connection({ ..._config, delete: true }, 'source', function(err) {
          assert.strictEqual(err, undefined);
          assert.strictEqual(_head.pendingMocks().length, 0);
          assert.strictEqual(storage.getDeletionRefusal('source'), 'swift_versions_stack');
          assert.strictEqual(storage.getDeletionRefusal('target'), undefined);
          assert.deepStrictEqual(_logs.filter('swift_versions_stack').map((l) => [l.level, l.side, l.versions_location]), [['error', 'source', 'invoices_versions']]);
          done();
        });
      });

      it('should accept the deletions with "X-History-Location", and not check the container without "delete"', function(done) {
        nock(urlSwift).head('/invoices').reply(204, '', { 'x-history-location': 'invoices_history' });
        storage.connection({ ..._config, delete: true }, 'source', function(err) {
          assert.strictEqual(err, undefined);
          assert.strictEqual(storage.getDeletionRefusal('source'), undefined);
          nock(urlAuthSwift).post('/auth/tokens').reply(200, connectionResultSuccessV3, { "X-Subject-Token": tokenAuthSwift });
          storage.connection({ ..._config, delete: false }, 'source', function(err) {
            assert.strictEqual(err, undefined, 'no HEAD request (not mocked)');
            assert.strictEqual(storage.getDeletionRefusal('source'), undefined);
            assert.strictEqual(_logs.filter('swift_versions_stack').length, 0);
            done();
          });
        });
      });

      it('should fail the connection if the container cannot be checked', function(done) {
        nock(urlSwift).head('/invoices').reply(404, '');
        storage.connection({ ..._config, delete: true }, 'source', function(err) {
          assert.strictEqual(err.includes('Container check error | Status 404 | Container: invoices'), true, err);
          done();
        });
      });
    });

    describe('resolveEtags', function() {
      afterEach(function() {
        nock.cleanAll();
      });

      it('should resolve opaque etags with a HEAD, and set null when the HEAD does not return an MD5', function(done) {
        const _md5 = 'a'.repeat(32);
        nock(urlS3)
          .head('/invoices/enc.pdf').reply(200, '', { etag: `"${_md5.toUpperCase()}"` })
          .head('/invoices/missing.pdf').reply(404)
          .head('/invoices/ssec.pdf').reply(200, '', { etag: '"' + 'f'.repeat(64) + '"' })
          .head('/invoices/flaky.pdf').reply(503)
          .head('/invoices/flaky.pdf').reply(200, '', { etag: _md5 });
        nock(urlSwift).head('/invoices/swift.pdf').reply(200, '', { etag: _md5 });
        const _list = ['enc', 'missing', 'ssec', 'flaky'].map((name) => ({ side: 'target', object: { key: name + '.pdf' } }));
        _list.push({ side: 'source', object: { key: 'swift.pdf' } });
        storage.resolveEtags(_list, { transfers: 2, retry: 1 }, function(stats) {
          assert.deepStrictEqual(_list.map((r) => r.object.resolvedMd5), [_md5, null, null, _md5, _md5]);
          assert.strictEqual(stats.resolved, 3);
          assert.strictEqual(stats.unresolved, 2);
          assert.strictEqual(nock.pendingMocks().length, 0);
          done();
        });
      });
    });

    describe('Failure logs', function() {
      let _logs = null;

      beforeEach(function() {
        _logs = captureLogs();
      });

      afterEach(function() {
        _logs.restore();
        nock.cleanAll();
      });

      it('should log "logMaxFailures" failed operations per queue, then one summary line', function(done) {
        /** 409: a temporary error, retried */
        nock(urlSwift).get(/\/invoices\/file[0-9]\.pdf/).times(6).reply(409);

        const _files = [1, 2, 3].map((i) => ({ key: `file${i}.pdf` }));
        storage.syncFiles(_files, [], [], [], { mode: helper.MODES.UNI, retry: 1, transfers: 1, logMaxFailures: 2 }, function(err, stats) {
          assert.strictEqual(err instanceof Error, true);
          const _failures = _logs.filter('transfer_failed');
          assert.strictEqual(_failures.length, 2);
          assert.deepStrictEqual(_failures.map((line) => [line.key, line.status, line.phase, line.try]), [['file1.pdf', 409, 'download', 0], ['file2.pdf', 409, 'download', 0]]);
          const _summary = _logs.filter('transfer_failed_summary');
          assert.strictEqual(_summary.length, 1);
          assert.strictEqual(_summary[0].level, 'warn');
          assert.strictEqual(_summary[0].queue, 'upload-from-source-to-target');
          assert.strictEqual(_summary[0].omitted, 4);
          assert.strictEqual(_summary[0].max, 2);
          assert.deepStrictEqual(stats, { uploaded: 0, uploaded_bytes: 0, deleted: 0, skipped: 0, failed: 3 });
          done();
        });
      });

      it('should count the uploaded files and bytes, and forget a failure fixed by a retry', function(done) {
        nock(urlSwift)
          .get('/invoices/a.pdf').reply(200, 'Hello1234')
          .get('/invoices/b.pdf').reply(409)
          .get('/invoices/b.pdf').reply(200, 'Hello');
        nock(urlS3).put('/invoices/a.pdf').reply(200, '').put('/invoices/b.pdf').reply(200, '');

        storage.syncFiles([{ key: 'a.pdf' }, { key: 'b.pdf' }], [], [], [], { mode: helper.MODES.UNI, retry: 1, transfers: 1 }, function(err, stats) {
          assert.strictEqual(err, undefined);
          assert.deepStrictEqual(stats, { uploaded: 2, uploaded_bytes: 14, deleted: 0, skipped: 0, failed: 0 });
          assert.strictEqual(_logs.filter('transfer_failed').length, 1);
          assert.strictEqual(_logs.filter('queue_end')[0].level, 'info');
          done();
        });
      });

      it('should run the next queue and call back once even if the queue calls back twice', function(done) {
        const cqueue = require('@carboneio/cqueue');
        const _execQueue = cqueue.execQueue;
        const _queues = [];
        cqueue.execQueue = function (queueName, list, worker, options, callback) {
          _queues.push(queueName);
          callback(null, [], []);
          callback(null, [], []);
        };
        let _calls = 0;
        try {
          storage.syncFiles([], [], [], [], { mode: helper.MODES.BI }, function(err) {
            _calls++;
            assert.strictEqual(err, undefined);
          });
        } finally {
          cqueue.execQueue = _execQueue;
        }
        setImmediate(() => {
          assert.strictEqual(_calls, 1);
          assert.deepStrictEqual(_queues, ['delete-files-target', 'upload-from-source-to-target', 'upload-from-target-to-source', 'delete-files-source']);
          done();
        });
      });

      it('should log the start and end of an empty queue at debug level', function(done) {
        storage.syncFiles([], [], [], [], { mode: helper.MODES.BI }, function(err) {
          assert.strictEqual(err, undefined);
          const _queueEvents = _logs.events().filter((line) => line.event.startsWith('queue_'));
          assert.strictEqual(_queueEvents.length, 0, 'debug lines are not written at info level');
          done();
        });
      });
    });

    /**
     * An object stored compressed must be copied with its "content-encoding" and its exact bytes. tiny-storage-client <= 3.6.0
     * decompresses the downloaded body: the header is then dropped, the copy is the decompressed content. Never a mix of both.
     */
    describe('Content-Encoding', function() {
      const _content = Buffer.from('Hello world, compressed content '.repeat(20));
      const _gzip = zlib.gzipSync(_content);
      const _responseHeaders = { 'content-type': 'text/plain', 'content-encoding': 'gzip', 'content-length': String(_gzip.length), 'cache-control': 'max-age=60', 'content-disposition': 'attachment; filename="a.txt"' };

      function assertConsistentCopy (headers, body) {
        /** nock gives a binary body as hex, a text body as is */
        const _bytes = /^[0-9a-f]*$/.test(body) ? Buffer.from(body, 'hex') : Buffer.from(body);
        if (headers['content-encoding'] === 'gzip') {
          assert.strictEqual(_bytes.equals(_gzip), true, 'the exact compressed bytes are copied with the header');
        } else {
          assert.strictEqual(headers['content-encoding'], undefined);
          assert.strictEqual(_bytes.equals(_content), true, 'the decompressed bytes are copied without the header');
        }
        assert.strictEqual(headers['cache-control'], 'max-age=60');
        assert.strictEqual(headers['content-disposition'], 'attachment; filename="a.txt"');
        assert.strictEqual(headers['content-type'], 'text/plain');
      }

      it('should copy a gzip object from SWIFT to S3 consistently', function(done) {
        nock(urlSwift).get('/invoices/a.txt.gz').reply(200, _gzip, _responseHeaders);
        let _upload = null;
        nock(urlS3).put('/invoices/a.txt.gz').reply(200, function (uri, body) {
          _upload = { headers: this.req.headers, body: body };
          return '';
        });
        storage.syncFiles([{ key: 'a.txt.gz' }], [], [], [], { mode: helper.MODES.UNI }, function(err) {
          try {
            assert.strictEqual(err, undefined);
            assertConsistentCopy(_upload.headers, _upload.body);
          } catch (e) { return done(e); }
          done();
        });
      });

      /** Raw bytes returned by the HTTP client (rock-req does not decode "zstd"): the exact bytes and the header are copied */
      it('should copy the exact bytes and the "content-encoding" of an object returned as stored (SWIFT to S3)', function(done) {
        nock(urlSwift).get('/invoices/a.txt.zst').reply(200, _gzip, { ..._responseHeaders, 'content-encoding': 'zstd' });
        let _upload = null;
        nock(urlS3).put('/invoices/a.txt.zst').reply(200, function (uri, body) {
          _upload = { headers: this.req.headers, body: body };
          return '';
        });
        storage.syncFiles([{ key: 'a.txt.zst' }], [], [], [], { mode: helper.MODES.UNI }, function(err, stats) {
          try {
            assert.strictEqual(err, undefined);
            assert.strictEqual(_upload.headers['content-encoding'], 'zstd');
            assert.strictEqual(Buffer.from(_upload.body, 'hex').equals(_gzip), true);
            assert.strictEqual(stats.uploaded_bytes, _gzip.length);
          } catch (e) { return done(e); }
          done();
        });
      });

      /** Chunked or proxy-compressed response: the received bytes cannot be proven to be the stored bytes */
      it('should NOT copy the "content-encoding" of a response without "content-length" (SWIFT to S3)', function(done) {
        const _headers = { ..._responseHeaders, 'content-encoding': 'zstd' };
        delete _headers['content-length'];
        nock(urlSwift).get('/invoices/a.txt.zst').reply(200, _gzip, _headers);
        let _upload = null;
        nock(urlS3).put('/invoices/a.txt.zst').reply(200, function (uri, body) {
          _upload = { headers: this.req.headers, body: body };
          return '';
        });
        storage.syncFiles([{ key: 'a.txt.zst' }], [], [], [], { mode: helper.MODES.UNI }, function(err) {
          try {
            assert.strictEqual(err, undefined);
            assert.strictEqual(_upload.headers['content-encoding'], undefined);
            assert.strictEqual(_upload.headers['cache-control'], 'max-age=60');
          } catch (e) { return done(e); }
          done();
        });
      });

      it('should never copy an "aws-chunked" content-encoding (SWIFT to S3)', function(done) {
        nock(urlSwift)
          .get('/invoices/a.txt').reply(200, _gzip, { ..._responseHeaders, 'content-encoding': 'aws-chunked' })
          .get('/invoices/b.txt').reply(200, _gzip, { ..._responseHeaders, 'content-encoding': 'aws-chunked, zstd' });
        const _uploads = {};
        nock(urlS3).put(/\/invoices\/[ab]\.txt/).times(2).reply(200, function (uri) {
          _uploads[uri] = this.req.headers;
          return '';
        });
        storage.syncFiles([{ key: 'a.txt' }, { key: 'b.txt' }], [], [], [], { mode: helper.MODES.UNI }, function(err) {
          try {
            assert.strictEqual(err, undefined);
            assert.strictEqual(_uploads['/invoices/a.txt']['content-encoding'], undefined);
            assert.strictEqual(_uploads['/invoices/b.txt']['content-encoding'], 'zstd');
          } catch (e) { return done(e); }
          done();
        });
      });

      it('should copy a gzip object from S3 to S3 consistently', function(done) {
        helper.loadConfig(path.join(__dirname, 'config.test-s3-s3.json'), function(err, config) {
          nock(urlS3).get('/invoices').query({ 'list-type': '2', 'max-keys': '1' }).reply(200, "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListBucketResult><Name>invoices</Name><KeyCount>0</KeyCount><MaxKeys>1</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>", { 'content-type': 'application/xml' });
          nock(urlS3SBG).get('/invoices').query({ 'list-type': '2', 'max-keys': '1' }).reply(200, "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListBucketResult><Name>invoices</Name><KeyCount>0</KeyCount><MaxKeys>1</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>", { 'content-type': 'application/xml' });
          storage.connection(config, 'source', function(err) {
            assert.strictEqual(err, undefined);
            storage.connection(config, 'target', function(err) {
              assert.strictEqual(err, undefined);
              nock(urlS3).get('/invoices/a.txt.gz').reply(200, _gzip, { ..._responseHeaders, 'x-amz-server-side-encryption': 'AES256', 'x-amz-version-id': 'v1', etag: '"abc"', 'last-modified': 'Thu, 23 Feb 2023 01:14:34 GMT', 'x-amz-meta-owner': 'me' });
              let _upload = null;
              nock(urlS3SBG).put('/invoices/a.txt.gz').reply(200, function (uri, body) {
                _upload = { headers: this.req.headers, body: body };
                return '';
              });
              storage.syncFiles([{ key: 'a.txt.gz' }], [], [], [], { mode: helper.MODES.UNI }, function(err) {
                assert.strictEqual(err, undefined);
                assertConsistentCopy(_upload.headers, _upload.body);
                assert.strictEqual(_upload.headers['x-amz-meta-owner'], 'me');
                assert.strictEqual(_upload.headers['x-amz-server-side-encryption'], undefined);
                assert.strictEqual(_upload.headers['x-amz-version-id'], undefined);
                assert.strictEqual(_upload.headers['etag'], undefined);
                assert.strictEqual(_upload.headers['last-modified'], undefined);
                done();
              });
            });
          });
        });
      });
    });

    describe('integrityCheck', function() {
      const _fileContent = Buffer.from('Hello1234');
      const _fileMD5 = '43d5d2b9e7e4c4e1c1fbb7a2bc4a7c4a';

      beforeEach(function(done) {
        const nockAuthS3 = nock(urlS3)
          .defaultReplyHeaders({ 'content-type': 'application/xml' })
          .get('/invoices').query({ 'list-type': '2', 'max-keys': '1' })
          .reply(200, "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListBucketResult><Name>invoices</Name><KeyCount>0</KeyCount><MaxKeys>1</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>");
        storage.connection({ ..._config, integrityCheck: true }, 'target', function(err) {
          assert.strictEqual(err, undefined);
          assert.strictEqual(nockAuthS3.pendingMocks().length, 0);
          done();
        });
      });

      it('should transfer an S3 file with a multipart etag: it is not the MD5 of the content and cannot be checked', function(done) {
        const nockS3Download = nock(urlS3)
          .defaultReplyHeaders({ etag: '"b62e2a390d253298e9f061541ec39fc6-2"' })
          .get('/invoices/multipart.pdf')
          .reply(200, () => _fileContent);
        const nockSwiftUpload = nock(urlSwift)
          .put('/invoices/multipart.pdf')
          .reply(201, '');

        storage.syncFiles([], [], [{ key: 'multipart.pdf' }], [], { mode: helper.MODES.BI }, function(err) {
          assert.strictEqual(err, undefined);
          assert.strictEqual(nockS3Download.pendingMocks().length, 0);
          assert.strictEqual(nockSwiftUpload.pendingMocks().length, 0);
          done();
        });
      });

      it('should check a Swift file against its etag without quotes, and skip the check for a large object (SLO, DLO)', function(done) {
        nock(urlSwift).get("/invoices/quoted.pdf").reply(200, _fileContent, { etag: `"${require("crypto").createHash("md5").update(_fileContent).digest("hex").toUpperCase()}"` });
        nock(urlSwift).get('/invoices/slo.pdf').reply(200, _fileContent, { etag: '"0123456789abcdef0123456789abcdef"', 'x-static-large-object': 'True' });
        nock(urlSwift).get('/invoices/dlo.pdf').reply(200, _fileContent, { etag: '"0123456789abcdef0123456789abcdef"', 'x-object-manifest': 'segments/dlo' });
        const _upload = nock(urlS3).put(/\/invoices\/(quoted|slo|dlo)\.pdf/).times(3).reply(200, '');
        storage.syncFiles([{ key: 'quoted.pdf' }, { key: 'slo.pdf' }, { key: 'dlo.pdf' }], [], [], [], { mode: helper.MODES.UNI }, function(err, stats) {
          assert.strictEqual(err, undefined);
          assert.strictEqual(stats.uploaded, 3);
          assert.strictEqual(_upload.pendingMocks().length, 0);
          done();
        });
      });

      it('should NOT transfer a Swift file if its MD5 etag does not match the content (error with its status)', function(done) {
        const _logs = captureLogs();
        nock(urlSwift).get('/invoices/corrupted.pdf').reply(200, _fileContent, { etag: '0123456789abcdef0123456789abcdef' });
        storage.syncFiles([{ key: 'corrupted.pdf' }], [], [], [], { mode: helper.MODES.UNI }, function(err, stats) {
          _logs.restore();
          assert.strictEqual(err instanceof Error, true);
          assert.strictEqual(stats.failed, 1);
          const _failure = _logs.filter('transfer_failed')[0];
          assert.strictEqual(_failure.error, 'Swift downloadFile Error | Integrity check error: file md5 is not valid');
          assert.strictEqual(_failure.status, 200);
          done();
        });
      });

      it('should NOT transfer an S3 file if its MD5 etag does not match the content', function(done) {
        const nockS3Download = nock(urlS3)
          .defaultReplyHeaders({ etag: `"${_fileMD5}"` })
          .get('/invoices/corrupted.pdf')
          .reply(200, () => _fileContent);

        storage.syncFiles([], [], [{ key: 'corrupted.pdf' }], [], { mode: helper.MODES.BI }, function(err) {
          assert.strictEqual(err instanceof Error, true);
          assert.strictEqual(err.toString().includes('upload-from-target-to-source | 1 operation(s) failed'), true);
          assert.strictEqual(nockS3Download.pendingMocks().length, 0);
          done();
        });
      });

      describe('MD5 of the body computed once (download check reused by the upload)', function() {
        const crypto = require('crypto');
        /** The real MD5 of the content (the one above is a wrong etag) */
        const _fileMD5 = crypto.createHash('md5').update(_fileContent).digest('hex');
        let _createHash = null;
        let _md5Calls = 0;
        beforeEach(function() {
          _md5Calls = 0;
          _createHash = crypto.createHash;
          crypto.createHash = function (algorithm, ...args) {
            _md5Calls += algorithm === 'md5' ? 1 : 0;
            return _createHash.call(this, algorithm, ...args);
          };
        });
        afterEach(function() {
          crypto.createHash = _createHash;
          nock.cleanAll();
        });

        it('should upload to S3 with the "Content-MD5" of the Swift body, hashed once, never from the listed (opaque) etag', function(done) {
          nock(urlSwift).get('/invoices/a.pdf').reply(200, _fileContent, { etag: _fileMD5 });
          let _contentMD5 = null;
          /** The etag of the PUT response is given: without it, the recorded token is the MD5 of the body */
          const _upload = nock(urlS3).put('/invoices/a.pdf').reply(function () {
            _contentMD5 = this.req.headers['content-md5'];
            return [200, '', { etag: `"${_fileMD5}"` }];
          });
          storage.syncFiles([{ key: 'a.pdf', md5: 'opaque-sse-kms-etag-0123456789abcdef' }], [], [], [], { mode: helper.MODES.UNI }, function(err, stats) {
            assert.strictEqual(err, undefined);
            assert.strictEqual(stats.uploaded, 1);
            assert.strictEqual(_upload.pendingMocks().length, 0);
            assert.strictEqual(_contentMD5, Buffer.from(_fileMD5, 'hex').toString('base64'));
            assert.strictEqual(_md5Calls, 1);
            done();
          });
        });

        it('should upload to Swift with the "ETag" of the S3 body, hashed once, even if the S3 etag cannot be checked (multipart)', function(done) {
          nock(urlS3).get('/invoices/b.pdf').reply(200, _fileContent, { etag: `"${_fileMD5}"` });
          nock(urlS3).get('/invoices/c.pdf').reply(200, _fileContent, { etag: '"b62e2a390d253298e9f061541ec39fc6-2"' });
          const _etags = {};
          const _upload = nock(urlSwift).put(/\/invoices\/(b|c)\.pdf/).times(2).reply(function (uri) {
            _etags[uri.split('/').pop()] = this.req.headers.etag;
            return [201, '', { etag: _fileMD5 }];
          });
          storage.syncFiles([], [], [{ key: 'b.pdf' }, { key: 'c.pdf' }], [], { mode: helper.MODES.BI }, function(err, stats) {
            assert.strictEqual(err, undefined);
            assert.strictEqual(stats.uploaded, 2);
            assert.strictEqual(_upload.pendingMocks().length, 0);
            assert.deepStrictEqual(_etags, { 'b.pdf': _fileMD5, 'c.pdf': _fileMD5 });
            assert.strictEqual(_md5Calls, 2);
            done();
          });
        });

        it('should hash the body of a Swift large object at upload: its etag is not checked at download', function(done) {
          nock(urlSwift).get('/invoices/slo.pdf').reply(200, _fileContent, { etag: '"0123456789abcdef0123456789abcdef"', 'x-static-large-object': 'True' });
          let _contentMD5 = null;
          nock(urlS3).put('/invoices/slo.pdf').reply(function () {
            _contentMD5 = this.req.headers['content-md5'];
            return [200, '', { etag: `"${_fileMD5}"` }];
          });
          storage.syncFiles([{ key: 'slo.pdf' }], [], [], [], { mode: helper.MODES.UNI }, function(err) {
            assert.strictEqual(err, undefined);
            assert.strictEqual(_contentMD5, Buffer.from(_fileMD5, 'hex').toString('base64'));
            assert.strictEqual(_md5Calls, 1);
            done();
          });
        });
      });
    });

    it('should never return the credentials of a refused S3 connection (SignatureDoesNotMatch)', function(done) {
      helper.loadConfig(path.join(__dirname, 'config.test-s3-s3.json'), function(err, config) {
        assert.strictEqual(err, null);
        nock(urlS3).get('/invoices').query({ 'list-type': '2', 'max-keys': '1' }).reply(403, '<?xml version="1.0" encoding="UTF-8"?><Error><Code>SignatureDoesNotMatch</Code><Message>The request signature we calculated does not match the signature you provided.</Message><AWSAccessKeyId>AKIASECRETID</AWSAccessKeyId><StringToSign>AWS4-HMAC-SHA256 secretstring</StringToSign><SignatureProvided>secretsignature</SignatureProvided></Error>', { 'content-type': 'application/xml' });
        storage.connection(config, 'source', function(err) {
          assert.strictEqual(err, '[S3 source] Storage error | Status 403 | Code: SignatureDoesNotMatch | Message: The request signature we calculated does not match the signature you provided.');
          done();
        });
      });
    });

    it('should check an S3 connection with a listing of one key of the bucket: no ListAllMyBuckets permission needed, clear errors (403, 404)', function(done) {
      helper.loadConfig(path.join(__dirname, 'config.test-s3-s3.json'), function(err, config) {
        assert.strictEqual(err, null);
        const _query = { 'list-type': '2', 'max-keys': '1' };
        nock(urlS3).get('/invoices').query(_query).reply(403, '<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>', { 'content-type': 'application/xml' });
        nock(urlS3).get('/invoices').query(_query).reply(404, '<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchBucket</Code><Message>The specified bucket does not exist</Message></Error>', { 'content-type': 'application/xml' });
        /** Credentials scoped to the bucket: ListBuckets (GET /) would be refused, it is never requested */
        const _listBuckets = nock(urlS3).get('/').reply(403, '<Error><Code>AccessDenied</Code></Error>', { 'content-type': 'application/xml' });
        const _listing = nock(urlS3).get('/invoices').query(_query).reply(200, '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>invoices</Name><KeyCount>1</KeyCount><MaxKeys>1</MaxKeys><IsTruncated>true</IsTruncated><Contents><Key>a.pdf</Key></Contents></ListBucketResult>', { 'content-type': 'application/xml' });
        storage.connection(config, 'source', function(err) {
          assert.strictEqual(err, '[S3 source] Storage error | Status 403 | Code: AccessDenied | Message: Access Denied');
          storage.connection(config, 'source', function(err) {
            assert.strictEqual(err, '[S3 source] Storage error | Status 404 | Code: NoSuchBucket | Message: The specified bucket does not exist');
            storage.connection(config, 'source', function(err) {
              assert.strictEqual(err, undefined);
              assert.strictEqual(_listing.pendingMocks().length, 0);
              assert.strictEqual(_listBuckets.pendingMocks().length, 1);
              nock.cleanAll();
              done();
            });
          });
        });
      });
    });

    describe('S3 connection check retried like a listing page', function() {
      const _query = { 'list-type': '2', 'max-keys': '1' };
      const _ok = '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>invoices</Name><KeyCount>0</KeyCount><MaxKeys>1</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>';
      let _logs = null;
      beforeEach(function() {
        nock.cleanAll();
        _logs = captureLogs();
      });
      afterEach(function() {
        _logs.restore();
        nock.cleanAll();
      });

      /** Connect the source after the `failures` answers, then a 200 if `recover` */
      function check (failures, recover, overrides, callback) {
        for (const _failure of failures) {
          _failure(nock(urlS3).get('/invoices').query(_query));
        }
        const _success = recover ? nock(urlS3).get('/invoices').query(_query).reply(200, _ok, { 'content-type': 'application/xml' }) : null;
        helper.loadConfig(path.join(__dirname, 'config.test-s3-s3.json'), function(err, config) {
          assert.strictEqual(err, null);
          storage.connection({ ...config, ...overrides }, 'source', (err) => callback(err, _logs.filter('listing_retry'), _success));
        });
      }

      const _transient = {
        '500'          : (scope) => scope.reply(500, '<?xml version="1.0" encoding="UTF-8"?><Error><Code>InternalError</Code></Error>', { 'content-type': 'application/xml' }),
        'HTML page'    : (scope) => scope.reply(200, '<html><body>Bad gateway</body></html>', { 'content-type': 'text/html' })
      };
      for (const [name, failure] of Object.entries(_transient)) {
        it(`should connect after a ${name}, logged by listing_retry with op=connect`, function(done) {
          check([failure], true, {}, (err, retries, success) => {
            assert.strictEqual(err, undefined);
            assert.strictEqual(success.isDone(), true);
            assert.strictEqual(retries.length >= 1, true);
            assert.deepStrictEqual(retries.map((line) => [line.op, line.side, line.level]), retries.map(() => ['connect', 'source', 'warn']));
            assert.strictEqual(_logs.filter('storage_connected').length, 1);
            done();
          });
        });
      }

      it('should connect after socket resets, logged by listing_retry with op=connect', function(done) {
        /** Real local HTTP, nock deactivated: the sockets of the first two requests are reset (the second one is the transport retry of rock-req) */
        let _requests = 0;
        const _server = require('http').createServer((req, res) => {
          if (++_requests <= 2) {
            return req.socket.destroy();
          }
          res.writeHead(200, { 'content-type': 'application/xml' });
          res.end(_ok);
        });
        nock.restore();
        _server.listen(0, '127.0.0.1', () => {
          helper.loadConfig(path.join(__dirname, 'config.test-s3-s3.json'), function(err, config) {
            assert.strictEqual(err, null);
            const _config = { ...config, source: { ...config.source, url: `http://127.0.0.1:${_server.address().port}` } };
            storage.connection(_config, 'source', (err) => {
              _server.close();
              nock.activate();
              assert.strictEqual(err, undefined);
              assert.strictEqual(_requests, 3);
              assert.deepStrictEqual(_logs.filter('listing_retry').map((line) => [line.op, line.side]), [['connect', 'source']]);
              assert.strictEqual(_logs.filter('storage_connected').length, 1);
              done();
            });
          });
        });
      });

      it('should fail with the same error when the 503 lasts longer than the retries (listRetry)', function(done) {
        const _503 = (scope) => scope.times(20).reply(503, '<?xml version="1.0" encoding="UTF-8"?><Error><Code>SlowDown</Code><Message>Please reduce your request rate.</Message></Error>', { 'content-type': 'application/xml' });
        check([_503], false, { listRetry: 2 }, (err, retries) => {
          /** The message of a connection without retry: a 503 makes the single storage unavailable. tiny-storage-client 4.1 adds why (a throttle) after the 4.0 message */
          assert.strictEqual(err, '[S3 source] Error: Error: All S3 storages are not available | Throttled by the storage (slow down)');
          assert.strictEqual(retries.length, 2);
          assert.strictEqual(_logs.filter('storage_connected').length, 0);
          done();
        });
      });

      for (const [status, code] of [[403, 'AccessDenied'], [404, 'NoSuchBucket'], [403, 'SignatureDoesNotMatch']]) {
        it(`should fail at once on a ${status} ${code}, without retry`, function(done) {
          const _error = (scope) => scope.reply(status, `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>refused</Message></Error>`, { 'content-type': 'application/xml' });
          check([_error], true, {}, (err, retries, success) => {
            assert.strictEqual(err, `[S3 source] Storage error | Status ${status} | Code: ${code} | Message: refused`);
            assert.strictEqual(retries.length, 0);
            assert.strictEqual(success.isDone(), false);
            done();
          });
        });
      }
    });

    it('should skip a file deleted after the listing (404 on download), without retrying it nor failing the synchronisation', function(done) {
      /** Download from the target (S3): the file was deleted after the listing, not requested again */
      const nockS3Download = nock(urlS3)
        .get('/invoices/missing-file.txt')
        .reply(404);
      const _object = { key: 'missing-file.txt' };

      storage.syncFiles([], [], [_object], [], { mode: helper.MODES.BI, retry: 1 }, function(err, stats) {
        assert.strictEqual(err, undefined);
        assert.deepStrictEqual(stats, { uploaded: 0, uploaded_bytes: 0, deleted: 0, skipped: 1, failed: 0 });
        /** Not copied: its cache is kept, the next run plans it again */
        assert.strictEqual(_object.copied, undefined);
        assert.strictEqual(nockS3Download.pendingMocks().length, 0);
        done();
      });
    });

    it('should bulkDeletes objects on the source storage (S3) (delete-files-source queue)', function(done) {
      const nockAuthS3GRA = nock(urlS3)
        .defaultReplyHeaders({ 'content-type': 'application/xml' })
        .get('/invoices').query({ 'list-type': '2', 'max-keys': '1' })
        .reply(200, () => {
          return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListBucketResult><Name>invoices</Name><KeyCount>0</KeyCount><MaxKeys>1</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>";
        });

      const nockBulkDeleteSourceS3 = nock(urlS3)
        .post('/invoices/')
        .query((actualQueryObject) => {
          assert.strictEqual(actualQueryObject.delete !== undefined, true);
          return true;
        })
        .reply(200, (uri, body) => {
          assert.strictEqual(body, "<Delete><Object><Key>old1.txt</Key></Object><Object><Key>old2.txt</Key></Object><Quiet>false</Quiet></Delete>");
          return deleteResultFromRequest(body);
        });

      /** Connect an S3-S3 configuration: the source must be an S3 storage to test the S3 bulk delete */
      helper.loadConfig(path.join(__dirname, 'config.test-s3-s3.json'), function(err, config) {
        assert.strictEqual(err, null);
        storage.connection(config, 'source', function(err) {
          assert.strictEqual(err, undefined);
          const _filesToDeleteSource = [
            { key: 'old1.txt' },
            { key: 'old2.txt' }
          ];
          storage.syncFiles([], [], [], _filesToDeleteSource, { mode: helper.MODES.BI }, function(err) {
            assert.strictEqual(err, undefined);
            assert.strictEqual(nockAuthS3GRA.pendingMocks().length, 0);
            assert.strictEqual(nockBulkDeleteSourceS3.pendingMocks().length, 0);
            done();
          });
        });
      });
    });
  });

  describe('fetchListFiles', function() {

    describe('Source: S3 / Target: S3', function() {

      beforeEach(function (done) {

        const nockAuthS3GRA = nock(urlS3)
          .defaultReplyHeaders({ 'content-type': 'application/xml' })
          .get('/invoices').query({ 'list-type': '2', 'max-keys': '1' })
          .reply(200, () => {
            return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListBucketResult><Name>invoices</Name><KeyCount>0</KeyCount><MaxKeys>1</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>";
          });
        const nockAuthS3SBG = nock(urlS3SBG)
          .defaultReplyHeaders({ 'content-type': 'application/xml' })
          .get('/invoices').query({ 'list-type': '2', 'max-keys': '1' })
          .reply(200, () => {
            return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListBucketResult><Name>invoices</Name><KeyCount>0</KeyCount><MaxKeys>1</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>";
          });

        helper.loadConfig(path.join(__dirname, 'config.test-s3-s3.json'), function(err, config) {
          assert.strictEqual(err, null);
          _config = config;
          storage.connection(_config, 'source', function(err) {
            assert.strictEqual(err, undefined);
            storage.connection(_config, 'target', function(err) {
              assert.strictEqual(err, undefined);
              assert.strictEqual(nockAuthS3SBG.pendingMocks().length, 0);
              assert.strictEqual(nockAuthS3GRA.pendingMocks().length, 0);
              done();
            });
          });
        });
      });

      it('should return the list of files from S3/S3 as Maps (paginate automatically) and should removes quotes from etag', function(done) {

        const nockListFilesS3 = nock(urlS3)
          .defaultReplyHeaders({ 'content-type': 'application/xml' })
          .get('/invoices')
          .query({ 'list-type' : '2' })
          .reply(200, () => {
            return fs.readFileSync(path.join(__dirname, "assets", "listFiles.s3.paginate.xml"));
          })
          .get('/invoices')
          .query({ 'list-type' : '2', "start-after": "s3-2-paginate-document-5.pdf" })
          .reply(200, () => {
            return fs.readFileSync(path.join(__dirname, "assets", "listFiles.s3.xml"));
          });

        const nockListFilesS3SBG = nock(urlS3SBG)
          .defaultReplyHeaders({ 'content-type': 'application/xml' })
          .get('/invoices')
          .query({ 'list-type' : '2' })
          .reply(200, () => {
            return fs.readFileSync(path.join(__dirname, "assets", "listFiles.s3.xml"));
          });

        storage.fetchListFiles(files, function(err) {
          assert.strictEqual(err, undefined);
          assert.strictEqual(nockListFilesS3.pendingMocks().length, 0);
          assert.strictEqual(nockListFilesS3SBG.pendingMocks().length, 0);
          assert.strictEqual(files.target.size, 5);
          assert.strictEqual(files.source.size, 10);
          assert.strictEqual(files.cache.size, 0);
          for (const [key, value] of files.source) {
            assert.strictEqual(value.key.startsWith('s3-'), true);
            assert.strictEqual(key, value.key);
            assert.strictEqual(value.lastmodified > 0, true);
            assert.strictEqual(value.md5.length > 0, true);
            assert.strictEqual(value.md5.includes("\""), false);
            assert.strictEqual(value.md5.includes("&#34;"), false);
            assert.strictEqual(value.bytes > 0, true);
            /** Deleted S3 attributes */
            assert.strictEqual(value?.etag, undefined);
            assert.strictEqual(value?.storageclass, undefined);
            assert.strictEqual(value?.size, undefined);
            /** Only the fields used by the sync are kept in memory */
            assert.deepStrictEqual(Object.keys(value), ['key', 'md5', 'lastmodified', 'bytes', 'cachedEtag', 'cachedBytes']);
            /** Check ETAG value, should not include \" or &#34; */
            if (value.key === "s3-3-document-5.pdf") {
              assert.strictEqual(value.md5, "dd58d4bd19ea3e5277844c066ba57b39");
            }
            if (value.key === "s3-3-document-4.pdf") {
              assert.strictEqual(value.md5, "fde6d729123cee4db6bfa3606306bc8e");
            }
          }
          done();
        });
      });

      /**
       * An incomplete listing read as complete makes files disappear: with "delete", they are deleted
       * from the other storage. The listing must fail instead.
       */
      describe('Invalid S3 listing', function() {
        afterEach(function() {
          nock.cleanAll();
        });

        const _s3Page = (keys, { isTruncated = 'false', keyCount = keys.length, etag = '"7ad22b1297611d62ef4a4704c97afa6b"', size = '<Size>61396</Size>' } = {}) => {
          return '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>invoices</Name><Prefix></Prefix>'
            + (keyCount === null ? '' : `<KeyCount>${keyCount}</KeyCount>`) + '<MaxKeys>1000</MaxKeys>'
            + (isTruncated === null ? '' : `<IsTruncated>${isTruncated}</IsTruncated>`)
            + keys.map((key) => `<Contents><Key>${key}</Key><LastModified>2023-03-07T17:03:54.000Z</LastModified>${etag === null ? '' : `<ETag>${etag}</ETag>`}${size}<StorageClass>STANDARD</StorageClass></Contents>`).join('')
            + '</ListBucketResult>';
        };

        /** The target is valid, the source returns the pages given as arguments (each page is retried on error) */
        function mockListings (sourcePages) {
          const _nockSource = nock(urlS3).defaultReplyHeaders({ 'content-type': 'application/xml' });
          for (const _page of sourcePages) {
            _nockSource.get('/invoices').query(_page.query).reply(200, _page.body).persist();
          }
          nock(urlS3SBG)
            .defaultReplyHeaders({ 'content-type': 'application/xml' })
            .get('/invoices')
            .query({ 'list-type' : '2' })
            .reply(200, () => fs.readFileSync(path.join(__dirname, "assets", "listFiles.s3.xml")));
          return _nockSource;
        }

        function assertListingError (expectedMessage, done) {
          storage.fetchListFiles(files, function(err) {
            assert.strictEqual(typeof err, 'string');
            assert.strictEqual(err.includes(expectedMessage), true, err);
            nock.cleanAll();
            done();
          });
        }

        it('should return an error if "IsTruncated" is missing (the page may not be the last one)', function(done) {
          mockListings([{ query: { 'list-type' : '2' }, body: _s3Page(['file-1.pdf', 'file-2.pdf'], { isTruncated: null }) }]);
          assertListingError('Invalid listing: "IsTruncated" not found | Bucket: invoices', done);
        });

        it('should return an error if the number of files read is different from "KeyCount"', function(done) {
          mockListings([{ query: { 'list-type' : '2' }, body: _s3Page(['file-1.pdf', 'file-2.pdf'], { keyCount: 1000 }) }]);
          assertListingError('Invalid listing: 2 file(s) read but "KeyCount" is 1000 | Bucket: invoices', done);
        });

        it('should accept a page without "KeyCount" (optional for some providers)', function(done) {
          mockListings([{ query: { 'list-type' : '2' }, body: _s3Page(['file-1.pdf', 'file-2.pdf'], { keyCount: null }) }]);
          storage.fetchListFiles(files, function(err) {
            assert.strictEqual(err, undefined);
            assert.strictEqual(files.source.size, 2);
            nock.cleanAll();
            done();
          });
        });

        it('should return an error if a truncated page does not list any file', function(done) {
          mockListings([{ query: { 'list-type' : '2' }, body: _s3Page([], { isTruncated: 'true' }) }]);
          assertListingError('Invalid listing: the page is truncated but does not list any new file | Bucket: invoices', done);
        });

        it('should return an error if the next page restarts after the same file (infinite loop)', function(done) {
          mockListings([
            { query: { 'list-type' : '2' }, body: _s3Page(['file-1.pdf', 'file-2.pdf'], { isTruncated: 'true' }) },
            { query: { 'list-type' : '2', 'start-after': 'file-2.pdf' }, body: _s3Page(['file-2.pdf'], { isTruncated: 'true' }) }
          ]);
          assertListingError('Invalid listing: the page is truncated but does not list any new file | Bucket: invoices', done);
        });

        it('should request a failed page again, without listing the previous pages again', function(done) {
          const _requests = { page1: 0, page2: 0 };
          const _nockSource = nock(urlS3)
            .defaultReplyHeaders({ 'content-type': 'application/xml' })
            .get('/invoices')
            .query({ 'list-type' : '2' })
            .reply(200, () => {
              _requests.page1++;
              return _s3Page(['file-1.pdf', 'file-2.pdf'], { isTruncated: 'true' });
            })
            .get('/invoices')
            .query({ 'list-type' : '2', 'start-after': 'file-2.pdf' })
            .times(2)
            .reply(500, () => {
              _requests.page2++;
              return '';
            })
            .get('/invoices')
            .query({ 'list-type' : '2', 'start-after': 'file-2.pdf' })
            .reply(200, () => {
              _requests.page2++;
              /** Cut before the end */
              return _s3Page(['file-3.pdf']).slice(0, 200);
            })
            .get('/invoices')
            .query({ 'list-type' : '2', 'start-after': 'file-2.pdf' })
            .reply(200, () => {
              _requests.page2++;
              return _s3Page(['file-3.pdf']);
            });
          mockListings([]);

          storage.fetchListFiles(files, function(err) {
            assert.strictEqual(err, undefined);
            assert.deepStrictEqual([...files.source.keys()], ['file-1.pdf', 'file-2.pdf', 'file-3.pdf']);
            assert.deepStrictEqual(_requests, { page1: 1, page2: 4 });
            assert.strictEqual(_nockSource.pendingMocks().length, 0);
            nock.cleanAll();
            done();
          });
        });

        it('should return an error if a page still fails after 5 retries', function(done) {
          let _requests = 0;
          nock(urlS3)
            .get('/invoices')
            .query({ 'list-type' : '2' })
            .reply(500, () => {
              _requests++;
              return '';
            })
            .persist();
          mockListings([]);

          storage.fetchListFiles(files, function(err) {
            assert.strictEqual(typeof err, 'string');
            assert.strictEqual(err.includes('All S3 storages are not available'), true, err);
            assert.strictEqual(_requests, 6);
            nock.cleanAll();
            done();
          });
        });

        it('should not request a page again if the error is permanent (access denied, bucket not found)', function(done) {
          let _requests = 0;
          nock(urlS3)
            .defaultReplyHeaders({ 'content-type': 'application/xml' })
            .get('/invoices')
            .query({ 'list-type' : '2' })
            .reply(403, () => {
              _requests++;
              return '<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>';
            })
            .persist();
          mockListings([]);

          storage.fetchListFiles(files, function(err) {
            assert.strictEqual(typeof err, 'string');
            assert.strictEqual(err.includes('Status: 403 | Body: AccessDenied | Bucket: invoices'), true, err);
            assert.strictEqual(_requests, 1);
            nock.cleanAll();
            done();
          });
        });

        it('should not request a page again on a redirect (301 wrong region or endpoint: permanent)', function(done) {
          let _requests = 0;
          nock(urlS3)
            .defaultReplyHeaders({ 'content-type': 'application/xml' })
            .get('/invoices')
            .query({ 'list-type' : '2' })
            .reply(301, () => {
              _requests++;
              return '<?xml version="1.0" encoding="UTF-8"?><Error><Code>PermanentRedirect</Code><Endpoint>s3.eu-west-1.amazonaws.com</Endpoint></Error>';
            })
            .persist();
          mockListings([]);

          storage.fetchListFiles(files, function(err) {
            assert.strictEqual(typeof err, 'string');
            assert.strictEqual(err.includes('Status: 301 | Body: '), true, err);
            assert.strictEqual(_requests, 1);
            nock.cleanAll();
            done();
          });
        });

        it('should not modify the queries given as options (the pagination marker must not leak into the next listing)', function(done) {
          const _options = { s3: { queries: { 'max-keys': 2 } } };
          const _nockSource = nock(urlS3)
            .defaultReplyHeaders({ 'content-type': 'application/xml' })
            .get('/invoices')
            .query({ 'list-type' : '2', 'max-keys': '2' })
            .reply(200, _s3Page(['file-1.pdf', 'file-2.pdf'], { isTruncated: 'true' }))
            .get('/invoices')
            .query({ 'list-type' : '2', 'max-keys': '2', 'start-after': 'file-2.pdf' })
            .reply(200, _s3Page(['file-3.pdf']));
          const _nockTarget = nock(urlS3SBG)
            .defaultReplyHeaders({ 'content-type': 'application/xml' })
            .get('/invoices')
            .query({ 'list-type' : '2', 'max-keys': '2' })
            .reply(200, _s3Page([]));

          storage.fetchListFiles(files, _options, function(err) {
            assert.strictEqual(err, undefined);
            assert.strictEqual(files.source.size, 3);
            assert.deepStrictEqual(_options, { s3: { queries: { 'max-keys': 2 } } });
            assert.strictEqual(_nockSource.pendingMocks().length, 0);
            assert.strictEqual(_nockTarget.pendingMocks().length, 0);
            done();
          });
        });

        it('should return an error if a file has no ETag', function(done) {
          mockListings([{ query: { 'list-type' : '2' }, body: _s3Page(['file-1.pdf'], { etag: null }) }]);
          assertListingError('Invalid listing: a file without a valid "ETag" was returned by the source storage', done);
        });

        it('should return an error if a file has no valid size (part of the token recorded in the cache)', function(done) {
          mockListings([{ query: { 'list-type' : '2' }, body: _s3Page(['file-1.pdf'], { size: '<Size>unknown</Size>' }) }]);
          assertListingError('Invalid listing: a file without a valid "Size" was returned by the source storage', done);
        });
      });

      it('should keep the S3 keys as written, even if they look like numbers or booleans', function(done) {
        const _page = (keys, isTruncated) => '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>invoices</Name>'
          + `<KeyCount>${keys.length}</KeyCount><MaxKeys>2</MaxKeys><IsTruncated>${isTruncated}</IsTruncated>`
          + keys.map((key) => `<Contents><Key>${key}</Key><LastModified>2023-03-07T17:03:54.000Z</LastModified><ETag>"7ad22b1297611d62ef4a4704c97afa6b"</ETag><Size>61396</Size></Contents>`).join('')
          + '</ListBucketResult>';

        const _nockSource = nock(urlS3)
          .defaultReplyHeaders({ 'content-type': 'application/xml' })
          .get('/invoices')
          .query({ 'list-type' : '2' })
          .reply(200, _page(['0001', '12345678901234567890'], 'true'))
          .get('/invoices')
          /** The next page must start after the exact key, not after "12345678901234567000" */
          .query({ 'list-type' : '2', 'start-after': '12345678901234567890' })
          .reply(200, _page(['1e3', 'true'], 'false'));
        const _nockTarget = nock(urlS3SBG)
          .defaultReplyHeaders({ 'content-type': 'application/xml' })
          .get('/invoices')
          .query({ 'list-type' : '2' })
          .reply(200, _page(['0001', '1e3'], 'false'));

        storage.fetchListFiles(files, function(err) {
          assert.strictEqual(err, undefined);
          assert.deepStrictEqual([...files.source.keys()], ['0001', '12345678901234567890', '1e3', 'true']);
          assert.deepStrictEqual([...files.target.keys()], ['0001', '1e3']);
          assert.strictEqual(files.source.get('0001').key, '0001');
          assert.strictEqual(_nockSource.pendingMocks().length, 0);
          assert.strictEqual(_nockTarget.pendingMocks().length, 0);
          done();
        });
      });

      it('should decode the keys and ETags escaped differently by each provider into the same files', function(done) {
        const _page = (contents) => '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>invoices</Name>'
          + `<KeyCount>${contents.length}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>`
          + contents.map(([key, etag]) => `<Contents><Key>${key}</Key><LastModified>2023-03-07T17:03:54.000Z</LastModified><ETag>${etag}</ETag><Size>61396</Size></Contents>`).join('')
          + '</ListBucketResult>';

        /** AWS style: named entities */
        const _nockSource = nock(urlS3)
          .defaultReplyHeaders({ 'content-type': 'application/xml' })
          .get('/invoices')
          .query({ 'list-type' : '2' })
          .reply(200, _page([
            ['R&amp;D &lt;2024&gt;.pdf', '&quot;7ad22b1297611d62ef4a4704c97afa6b&quot;'],
            ['l&apos;offre &quot;v2&quot;.pdf', '&quot;7ad22b1297611d62ef4a4704c97afa6b-2&quot;']
          ]));
        /** OVH style: character references */
        const _nockTarget = nock(urlS3SBG)
          .defaultReplyHeaders({ 'content-type': 'application/xml' })
          .get('/invoices')
          .query({ 'list-type' : '2' })
          .reply(200, _page([
            ['R&amp;D &lt;2024&gt;.pdf', '&#34;7ad22b1297611d62ef4a4704c97afa6b&#34;'],
            ['l&#39;offre &#34;v2&#34;.pdf', '&#34;7ad22b1297611d62ef4a4704c97afa6b-2&#34;']
          ]));

        storage.fetchListFiles(files, function(err) {
          assert.strictEqual(err, undefined);
          const _expectedFiles = [
            ['R&D <2024>.pdf', '7ad22b1297611d62ef4a4704c97afa6b'],
            ['l\'offre "v2".pdf', '7ad22b1297611d62ef4a4704c97afa6b-2']
          ];
          for (const _files of [files.source, files.target]) {
            assert.deepStrictEqual([..._files.values()].map((file) => [file.key, file.md5]), _expectedFiles);
          }
          assert.strictEqual(_nockSource.pendingMocks().length, 0);
          assert.strictEqual(_nockTarget.pendingMocks().length, 0);
          done();
        });
      });

      describe('Listing page by page', function() {
        afterEach(function() {
          nock.cleanAll();
        });

        const _escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
        const _s3Page = (page, isTruncated) => '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>invoices</Name>'
          + `<KeyCount>${page.length}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>${isTruncated}</IsTruncated>`
          + page.map((object) => `<Contents><Key>${_escape(object.key)}</Key><LastModified>${object.lastModified}Z</LastModified><ETag>&quot;${object.hash}&quot;</ETag><Size>${object.bytes}</Size><StorageClass>STANDARD</StorageClass></Contents>`).join('')
          + '</ListBucketResult>';
        const _emptyTarget = () => nock(urlS3SBG).defaultReplyHeaders({ 'content-type': 'application/xml' }).get('/invoices').query({ 'list-type': '2' }).reply(200, _s3Page([], false));

        it('should build the same Map as before (order and contents), on random listings with unicode keys and retried pages', function(done) {
          this.timeout(20000);
          let _seed = 1;
          const _next = () => {
            if (_seed > 30) {
              return done();
            }
            const { pages, failures } = randomListing(_seed++);
            const _nockSource = nock(urlS3).defaultReplyHeaders({ 'content-type': 'application/xml' });
            for (let i = 0; i < pages.length; i++) {
              const _query = i === 0 ? { 'list-type': '2' } : { 'list-type': '2', 'start-after': pages[i - 1][pages[i - 1].length - 1].key };
              for (let f = 0; f < failures[i]; f++) {
                _nockSource.get('/invoices').query(_query).reply(503, '<Error><Code>SlowDown</Code></Error>');
              }
              _nockSource.get('/invoices').query(_query).reply(200, _s3Page(pages[i], i < pages.length - 1));
            }
            _emptyTarget();
            const _files = { source: new Map(), target: new Map() };
            storage.fetchListFiles(_files, function(err, stats) {
              try {
                assert.strictEqual(err, undefined);
                assert.deepStrictEqual([..._files.source.entries()], [...expectedListing(pages).entries()]);
                assert.strictEqual(stats.source.objects, pages.flat().length);
                assert.strictEqual(stats.source.bytes, pages.flat().reduce((sum, object) => sum + object.bytes, 0));
                assert.strictEqual(_nockSource.pendingMocks().length, 0);
              } catch (error) {
                return done(new Error(`seed ${_seed - 1}: ${error.message}`));
              }
              return _next();
            });
          };
          _next();
        });

        it('should fail the whole listing on an invalid file of a later page, and leave the Map of the side empty', function(done) {
          const _page1 = [{ key: 'a.pdf', hash: '7ad22b1297611d62ef4a4704c97afa6b', lastModified: '2023-03-07T17:03:54.000', bytes: 1 }];
          nock(urlS3).defaultReplyHeaders({ 'content-type': 'application/xml' })
            .get('/invoices').query({ 'list-type': '2' }).reply(200, _s3Page(_page1, true))
            .get('/invoices').query({ 'list-type': '2', 'start-after': 'a.pdf' }).reply(200, _s3Page([{ ..._page1[0], key: 'b.pdf', bytes: 'unknown' }], false));
          _emptyTarget();
          const _files = { source: new Map(), target: new Map() };
          storage.fetchListFiles(_files, function(err) {
            assert.strictEqual(err.startsWith('List files error | Invalid listing: a file without a valid "Size" was returned by the source storage'), true, err);
            assert.strictEqual(_files.source.size, 0);
            done();
          });
        });
      });
    });

    describe('Source: SWIFT / Target: SWIFT', function() {
      
      beforeEach(function (done) {
        const nockAuthSwift = nock(urlAuthSwift)
          .post('/auth/tokens')
          .reply(200, connectionResultSuccessV3, { "X-Subject-Token": tokenAuthSwift });

        const nockAuthSwiftSBG = nock(urlAuthSwift)
          .post('/auth/tokens')
          .reply(200, connectionResultSuccessV3SBG, { "X-Subject-Token": tokenAuthSwift });

        helper.loadConfig(path.join(__dirname, 'config.test-swift-swift.json'), function(err, config) {
          assert.strictEqual(err, null);
          
          const _config = config;          
          storage.connection(_config, 'target', function(err) {
            assert.strictEqual(err, undefined);
            assert.strictEqual(nockAuthSwift.pendingMocks().length, 0);
            storage.connection(_config, 'source', function(err) {
              assert.strictEqual(err, undefined);
              assert.strictEqual(nockAuthSwiftSBG.pendingMocks().length, 0);
              done();
            });
          });
        });
      });

      it('should build the same Map as before (order and contents), on random listings with unicode keys and retried pages', function(done) {
        this.timeout(20000);
        let _seed = 1;
        const _next = () => {
          if (_seed > 30) {
            return done();
          }
          const { pages, failures } = randomListing(_seed++);
          /** Only an empty page ends a Swift listing */
          const _pages = pages[pages.length - 1].length > 0 ? [...pages, []] : pages;
          const _nockSource = nock(urlSwiftSBG).defaultReplyHeaders({ 'content-type': 'application/json' });
          for (let i = 0; i < _pages.length; i++) {
            const _query = i === 0 ? { limit: '10000' } : { limit: '10000', marker: _pages[i - 1][_pages[i - 1].length - 1].key };
            for (let f = 0; f < (failures[i] ?? 0); f++) {
              _nockSource.get('/invoices').query(_query).reply(503, 'Service Unavailable');
            }
            _nockSource.get('/invoices').query(_query).reply(200, JSON.stringify(_pages[i].map((object) => ({ name: object.key, hash: object.hash, last_modified: object.lastModified, bytes: object.bytes, content_type: 'application/pdf' }))));
          }
          nock(urlSwift).get('/invoices').query({ limit: '10000' }).reply(204);
          const _files = { source: new Map(), target: new Map() };
          storage.fetchListFiles(_files, function(err, stats) {
            try {
              assert.strictEqual(err, undefined);
              assert.deepStrictEqual([..._files.source.entries()], [...expectedListing(pages).entries()]);
              assert.strictEqual(stats.source.objects, pages.flat().length);
              assert.strictEqual(_nockSource.pendingMocks().length, 0);
            } catch (error) {
              return done(new Error(`seed ${_seed - 1}: ${error.message}`));
            }
            return _next();
          });
        };
        _next();
      });

      it('should return the list of files from SWIFT/SWIFT (paginate automatically)', function(done) {
        
        const nockListFilesSwift = nock(urlSwift)
          .defaultReplyHeaders({ 'content-type': 'application/json' })
          .get('/invoices')
          .query({ 'limit' : '15' })
          .reply(200, () => {
            return fs.readFileSync(path.join(__dirname, 'assets', 'listFiles.swift.json'));
          })
          .get('/invoices')
          .query({ 'limit' : '15', 'marker': 'swift-4-608cdb' })
          .reply(200, () => {
            return fs.readFileSync(path.join(__dirname, 'assets', 'listFiles.swift.paginate.json'));
          })
          /** The listing ends on an empty page */
          .get('/invoices')
          .query({ 'limit' : '15', 'marker': 'swift-4-161913' })
          .reply(200, '[]', { 'content-type': 'application/json' });

        const nockListFilesSwiftSBG = nock(urlSwiftSBG)
          .defaultReplyHeaders({ 'content-type': 'application/json' })
          .get('/invoices')
          .query({ 'limit' : '15' })
          .reply(200, () => {
            return fs.readFileSync(path.join(__dirname, 'assets', 'listFiles.swift.paginate.json'));
          })
          /** The listing ends on an empty page */
          .get('/invoices')
          .query({ 'limit' : '15', 'marker': 'swift-4-161913' })
          .reply(200, '[]', { 'content-type': 'application/json' });

        storage.fetchListFiles(files, { swift: { queries: { limit: 15 } } }, function(err) {
          assert.strictEqual(err, undefined);
          assert.strictEqual(nockListFilesSwiftSBG.pendingMocks().length, 0);
          assert.strictEqual(nockListFilesSwift.pendingMocks().length, 0);
          assert.strictEqual(files.source.size, 8);
          assert.strictEqual(files.target.size, 23);
          assert.strictEqual(files.cache.size, 0);
          for (const [key, value] of files.target) {
            assert.strictEqual(value.key.startsWith('swift-'), true);
            assert.strictEqual(key, value.key);
            assert.strictEqual(value.lastmodified > 0, true);
            assert.strictEqual(value.md5.length > 0, true);
            assert.strictEqual(value.bytes > 0, true);
            /** Deleted SWIFT attributes */
            assert.strictEqual(value?.content_type, undefined);
            assert.strictEqual(value?.last_modified, undefined);
            assert.strictEqual(value?.hash, undefined);
            assert.strictEqual(value?.name, undefined);
            assert.deepStrictEqual(Object.keys(value), ['key', 'md5', 'lastmodified', 'bytes', 'cachedEtag', 'cachedBytes']);
          }
          done();
        });
      });

      describe('Swift listing capped below the requested limit', function() {
        afterEach(function() {
          nock.cleanAll();
        });
        const _page = (from, count) => JSON.stringify(Array.from({ length: count }, (_, i) => ({ name: 'obj-' + String(from + i).padStart(5, '0'), hash: '7ad22b1297611d62ef4a4704c97afa6b', bytes: 10, last_modified: '2023-03-07T17:03:54.000000' })));
        const _json = (count) => ({ 'content-type': 'application/json', 'x-container-object-count': String(count) });

        it('should keep listing until an empty page (server capping the pages at 1000)', function(done) {
          nock(urlSwiftSBG).get('/invoices').query({ limit: '10000' }).reply(204, '', { 'x-container-object-count': '0' });
          const _target = nock(urlSwift)
            .get('/invoices').query({ limit: '10000' }).reply(200, _page(0, 1000), _json(2500))
            .get('/invoices').query({ limit: '10000', marker: 'obj-00999' }).reply(200, _page(1000, 1000), _json(2500))
            .get('/invoices').query({ limit: '10000', marker: 'obj-01999' }).reply(200, _page(2000, 500), _json(2500))
            .get('/invoices').query({ limit: '10000', marker: 'obj-02499' }).reply(200, '[]', _json(2500));
          storage.fetchListFiles(files, function(err) {
            assert.strictEqual(err, undefined);
            assert.strictEqual(_target.pendingMocks().length, 0);
            assert.strictEqual(files.target.size, 2500);
            assert.strictEqual(files.source.size, 0);
            done();
          });
        });

        it('should stop on an empty page when the count is stale', function(done) {
          nock(urlSwiftSBG).get('/invoices').query({ limit: '10000' }).reply(204, '');
          const _target = nock(urlSwift)
            .get('/invoices').query({ limit: '10000' }).reply(200, _page(0, 1000), _json(1500))
            .get('/invoices').query({ limit: '10000', marker: 'obj-00999' }).reply(200, _page(1000, 200), _json(1500))
            .get('/invoices').query({ limit: '10000', marker: 'obj-01199' }).reply(200, '[]', _json(1500));
          storage.fetchListFiles(files, function(err) {
            assert.strictEqual(err, undefined);
            assert.strictEqual(_target.pendingMocks().length, 0);
            assert.strictEqual(files.target.size, 1200);
            done();
          });
        });

        it('should not end the listing on a short page when the count is stale-low or absent (one more page until an empty one)', function(done) {
          nock(urlSwiftSBG).get('/invoices').query({ limit: '10000' }).reply(204, '');
          const _target = nock(urlSwift)
            .get('/invoices').query({ limit: '10000' }).reply(200, _page(0, 1000), _json(1000))
            .get('/invoices').query({ limit: '10000', marker: 'obj-00999' }).reply(200, _page(1000, 1000), { 'content-type': 'application/json' })
            .get('/invoices').query({ limit: '10000', marker: 'obj-01999' }).reply(200, '[]', _json(2000));
          storage.fetchListFiles(files, function(err) {
            assert.strictEqual(err, undefined);
            assert.strictEqual(_target.pendingMocks().length, 0);
            assert.strictEqual(files.target.size, 2000, 'no object of the second page is missing');
            done();
          });
        });

        it('should return an error if the next page restarts after the same object (infinite loop)', function(done) {
          nock(urlSwiftSBG).get('/invoices').query({ limit: '10000' }).reply(204, '');
          nock(urlSwift).get('/invoices').query(true).reply(200, _page(0, 1000), _json(5000)).persist();
          storage.fetchListFiles(files, function(err) {
            assert.strictEqual(typeof err, 'string');
            assert.strictEqual(err.includes('Invalid listing: the page does not list any new file | Container: invoices'), true, err);
            nock.cleanAll();
            done();
          });
        });
      });

      describe('Invalid SWIFT listing', function() {
        afterEach(function() {
          nock.cleanAll();
        });

        function mockSourceListing () {
          nock(urlSwiftSBG)
            .defaultReplyHeaders({ 'content-type': 'application/json' })
            .get('/invoices')
            .query({ 'limit' : '15' })
            .reply(200, () => fs.readFileSync(path.join(__dirname, 'assets', 'listFiles.swift.paginate.json')))
            .get('/invoices')
            .query({ 'limit' : '15', 'marker': 'swift-4-161913' })
            .reply(200, '[]', { 'content-type': 'application/json' });
        }

        it('should return an error if the listing is not a JSON list (HTML error page with a status 200)', function(done) {
          mockSourceListing();
          let _requests = 0;
          nock(urlSwift)
            .defaultReplyHeaders({ 'content-type': 'text/html' })
            .get('/invoices')
            .query({ 'limit' : '15' })
            .reply(200, () => {
              _requests++;
              return '<html><body>Service Unavailable</body></html>';
            })
            .persist();

          storage.fetchListFiles(files, { swift: { queries: { limit: 15 } } }, function(err) {
            assert.strictEqual(typeof err, 'string');
            assert.strictEqual(err.includes('Invalid listing: a JSON list is expected | Status: 200 | Container: invoices'), true, err);
            /** The page is requested again 5 times before failing */
            assert.strictEqual(_requests, 6);
            nock.cleanAll();
            done();
          });
        });

        it('should request a failed page again (HTML error page with a status 200)', function(done) {
          mockSourceListing();
          const _nockTarget = nock(urlSwift)
            .get('/invoices')
            .query({ 'limit' : '15' })
            .reply(200, '<html><body>Service Unavailable</body></html>', { 'content-type': 'text/html' })
            .get('/invoices')
            .query({ 'limit' : '15' })
            .reply(200, () => fs.readFileSync(path.join(__dirname, 'assets', 'listFiles.swift.paginate.json')), { 'content-type': 'application/json' })
            .get('/invoices')
            .query({ 'limit' : '15', 'marker': 'swift-4-161913' })
            .reply(200, '[]', { 'content-type': 'application/json' });

          storage.fetchListFiles(files, { swift: { queries: { limit: 15 } } }, function(err) {
            assert.strictEqual(err, undefined);
            assert.strictEqual(files.target.size, 8);
            assert.strictEqual(files.source.size, 8);
            assert.strictEqual(_nockTarget.pendingMocks().length, 0);
            done();
          });
        });

        it('should return an error if a file has no hash', function(done) {
          mockSourceListing();
          nock(urlSwift)
            .defaultReplyHeaders({ 'content-type': 'application/json' })
            .get('/invoices')
            .query({ 'limit' : '15' })
            .reply(200, JSON.stringify([{ name: 'file-1.pdf', bytes: 10, last_modified: '2023-03-07T17:03:54.000000' }]))
            .get('/invoices')
            .query({ 'limit' : '15', 'marker': 'file-1.pdf' })
            .reply(200, '[]', { 'content-type': 'application/json' });

          storage.fetchListFiles(files, { swift: { queries: { limit: 15 } } }, function(err) {
            assert.strictEqual(typeof err, 'string');
            assert.strictEqual(err.includes('Invalid listing: a file without a valid "hash" was returned by the target storage'), true, err);
            nock.cleanAll();
            done();
          });
        });

        it('should return an error if a file name is not a string', function(done) {
          mockSourceListing();
          nock(urlSwift)
            .defaultReplyHeaders({ 'content-type': 'application/json' })
            .get('/invoices')
            .query({ 'limit' : '15' })
            .reply(200, JSON.stringify([{ name: 1, hash: '7ad22b1297611d62ef4a4704c97afa6b', bytes: 10, last_modified: '2023-03-07T17:03:54.000000' }]))
            .get('/invoices')
            .query({ 'limit' : '15', 'marker': '1' })
            .reply(200, '[]', { 'content-type': 'application/json' });

          storage.fetchListFiles(files, { swift: { queries: { limit: 15 } } }, function(err) {
            assert.strictEqual(typeof err, 'string');
            assert.strictEqual(err.includes('Invalid listing: a file without a valid "name" was returned by the target storage'), true, err);
            nock.cleanAll();
            done();
          });
        });

        it('should not request a page again on a redirect (301: permanent)', function(done) {
          let _requests = 0;
          mockSourceListing();
          nock(urlSwift)
            .get('/invoices')
            .query({ 'limit' : '15' })
            .reply(301, () => {
              _requests++;
              return '';
            })
            .persist();

          storage.fetchListFiles(files, { swift: { queries: { limit: 15 } } }, function(err) {
            assert.strictEqual(typeof err, 'string');
            assert.strictEqual(err.includes('Invalid listing: a JSON list is expected | Status: 301 | Container: invoices'), true, err);
            assert.strictEqual(_requests, 1);
            nock.cleanAll();
            done();
          });
        });

        it('should return an empty list for an empty container (status 204)', function(done) {
          mockSourceListing();
          nock(urlSwift)
            .get('/invoices')
            .query({ 'limit' : '15' })
            .reply(204);

          storage.fetchListFiles(files, { swift: { queries: { limit: 15 } } }, function(err) {
            assert.strictEqual(err, undefined);
            assert.strictEqual(files.target.size, 0);
            assert.strictEqual(files.source.size, 8);
            nock.cleanAll();
            done();
          });
        });
      });
    });

    describe('Source: S3 / Target: SWIFT', function() {
      beforeEach(function (done) {
        const nockAuthSwift = nock(urlAuthSwift)
          .post('/auth/tokens')
          .reply(200, connectionResultSuccessV3, { "X-Subject-Token": tokenAuthSwift });

        const nockAuthS3 = nock(urlS3)
          .defaultReplyHeaders({ 'content-type': 'application/xml' })
          .get('/invoices').query({ 'list-type': '2', 'max-keys': '1' })
          .reply(200, () => {
            return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListBucketResult><Name>invoices</Name><KeyCount>0</KeyCount><MaxKeys>1</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>";
          });

        helper.loadConfig(path.join(__dirname, 'config.test-s3-swift.json'), function(err, config) {
          assert.strictEqual(err, null);
          _config = config;
          storage.connection(_config, 'source', function(err) {
            assert.strictEqual(err, undefined);
            storage.connection(_config, 'target', function(err) {
              assert.strictEqual(err, undefined);
              assert.strictEqual(nockAuthSwift.pendingMocks().length, 0);
              assert.strictEqual(nockAuthS3.pendingMocks().length, 0);
              done();
            });
          });
        });
      });
      it('should return the list of files from S3/SWIFT as Maps and should paginate automatically', function(done) {
        const nockListFilesS3 = nock(urlS3)
          .defaultReplyHeaders({ 'content-type': 'application/xml' })
          .get('/invoices')
          .query({ 'list-type' : '2' })
          .reply(200, () => {
            return fs.readFileSync(path.join(__dirname, "assets", "listFiles.s3.paginate.xml"));
          })
          .get('/invoices')
          .query({ 'list-type' : '2', "start-after": "s3-2-paginate-document-5.pdf" })
          .reply(200, () => {
            return fs.readFileSync(path.join(__dirname, "assets", "listFiles.s3.xml"));
          });


        const nockListFilesSwift = nock(urlSwift)
          .defaultReplyHeaders({ 'content-type': 'application/json' })
          .get('/invoices')
          .query({ 'limit' : '15' })
          .reply(200, () => {
            return fs.readFileSync(path.join(__dirname, 'assets', 'listFiles.swift.json'));
          })
          .get('/invoices')
          .query({ 'limit' : '15', 'marker': 'swift-4-608cdb' })
          .reply(200, () => {
            return fs.readFileSync(path.join(__dirname, 'assets', 'listFiles.swift.paginate.json'));
          })
          /** The listing ends on an empty page */
          .get('/invoices')
          .query({ 'limit' : '15', 'marker': 'swift-4-161913' })
          .reply(200, '[]', { 'content-type': 'application/json' });

        storage.fetchListFiles(files, { swift: { queries: { limit: 15 } } }, function(err) {
          assert.strictEqual(err, undefined);
          assert.strictEqual(nockListFilesS3.pendingMocks().length, 0);
          assert.strictEqual(nockListFilesSwift.pendingMocks().length, 0);
          assert.strictEqual(files.source.size, 10);
          assert.strictEqual(files.target.size, 23);
          assert.strictEqual(files.cache.size, 0);
          for (const [key, value] of files.source) {
            if (value.key === 's3-3-document-5.pdf') {
              assert.strictEqual(value.lastmodified, 1677741535000); // 2023-03-02T07:18:55.000Z
            }
            assert.strictEqual(value.key.startsWith('s3-'), true);
            assert.strictEqual(key, value.key);
            assert.strictEqual(value.lastmodified > 0, true);
            assert.strictEqual(value.md5.length > 0, true);
            assert.strictEqual(value.bytes > 0, true);
            /** Deleted S3 attributes */
            assert.strictEqual(value?.etag, undefined);
            assert.strictEqual(value?.storageclass, undefined);
            assert.strictEqual(value?.size, undefined);
          }
          for (const [key, value] of files.target) {
            /** Check if the Z IS ADDED at the end of the date */
            if (value.key === 'swift-4-608cdb') {
              assert.strictEqual(value.lastmodified, 1626875695057); // 2021-07-21T13:54:55.057450Z: milliseconds kept
            }
            assert.strictEqual(value.key.startsWith('swift-'), true);
            assert.strictEqual(key, value.key);
            assert.strictEqual(value.lastmodified > 0, true);
            assert.strictEqual(value.md5.length > 0, true);
            assert.strictEqual(value.bytes > 0, true);
            /** Deleted SWIFT attributes */
            assert.strictEqual(value?.content_type, undefined);
            assert.strictEqual(value?.last_modified, undefined);
            assert.strictEqual(value?.hash, undefined);
            assert.strictEqual(value?.name, undefined);
          }
          done();
        });
      });
    });

    describe('Source: SWIFT / Target: S3', function() {

      it('should return empty map if S3/SWIFT are empty', function (done) {
        const nockListFilesS3 = nock(urlS3)
          .defaultReplyHeaders({ 'content-type': 'application/xml' })
          .get('/invoices')
          .query({ 'list-type' : '2' })
          .reply(200, () => {
            return fs.readFileSync(path.join(__dirname, "assets", "listFiles.s3.empty.xml"));
          });

        const nockListFilesSwift = nock(urlSwift)
          .defaultReplyHeaders({ 'content-type': 'application/json' })
          .get('/invoices')
          .query({ limit : 10000 })
          .reply(200, () => {
            return fs.readFileSync(path.join(__dirname, 'assets', 'listFiles.swift.empty.json'));
          });

        storage.fetchListFiles(files, function(err) {
          assert.strictEqual(err, undefined);
          assert.strictEqual(nockListFilesS3.pendingMocks().length, 0);
          assert.strictEqual(nockListFilesSwift.pendingMocks().length, 0);
          assert.strictEqual(files.source.size, 0);
          assert.strictEqual(files.target.size, 0);
          assert.strictEqual(files.cache.size, 0);
          done();
        });
      });

      it('should return an error if one of the list is returning an Error', function (done) {
        const nockListFilesS3 = nock(urlS3)
          .defaultReplyHeaders({ 'content-type': 'application/xml' })
          .get('/invoices')
          .query({ 'list-type' : '2' })
          .reply(500, 'Storage - Something went wrong')
          /** The page is requested again 5 times */
          .persist();

        const nockListFilesSwift = nock(urlSwift)
          .defaultReplyHeaders({ 'content-type': 'application/json' })
          .get('/invoices')
          .query({ limit : 10000 })
          .reply(200, () => {
            return fs.readFileSync(path.join(__dirname, 'assets', 'listFiles.swift.empty.json'));
          });

        storage.fetchListFiles(files, function(err) {
          console.log(err.toString());
          assert.strictEqual(err.toString(), 'List files error | Error: All S3 storages are not available');
          assert.strictEqual(nockListFilesS3.pendingMocks().length, 0);
          assert.strictEqual(nockListFilesSwift.pendingMocks().length, 0);
          assert.strictEqual(files.source.size, 0);
          assert.strictEqual(files.target.size, 0);
          assert.strictEqual(files.cache.size, 0);
          nock.cleanAll();
          done();
        });
      });

      it('should return the list of files from S3 and SWIFT as Maps', function(done) {

        const nockListFilesS3 = nock(urlS3)
          .defaultReplyHeaders({ 'content-type': 'application/xml' })
          .get('/invoices')
          .query({ 'list-type' : '2' })
          .reply(200, () => {
            return fs.readFileSync(path.join(__dirname, "assets", "listFiles.s3.xml"));
          });

        const nockListFilesSwift = nock(urlSwift)
          .defaultReplyHeaders({ 'content-type': 'application/json' })
          .get('/invoices')
          .query({ limit : 10000 })
          .reply(200, () => {
            return fs.readFileSync(path.join(__dirname, 'assets', 'listFiles.swift.json'));
          })
          .get('/invoices')
          .query({ limit : 10000, marker: 'swift-4-608cdb' })
          .reply(200, '[]', { 'content-type': 'application/json' });

        storage.fetchListFiles(files, function(err) {
          assert.strictEqual(err, undefined);
          assert.strictEqual(nockListFilesS3.pendingMocks().length, 0);
          assert.strictEqual(nockListFilesSwift.pendingMocks().length, 0);
          assert.strictEqual(files.target.size, 5);
          for (const [key, value] of files.target) {
            if (value.key === 's3-3-document-5.pdf') {
              assert.strictEqual(value.lastmodified, 1677741535000); // 2023-03-02T07:18:55.000Z
            }
            assert.strictEqual(value.key.startsWith('s3-'), true);
            assert.strictEqual(key, value.key);
            assert.strictEqual(value.lastmodified > 0, true);
            assert.strictEqual(value.md5.length > 0, true);
            assert.strictEqual(value.bytes > 0, true);
            /** Deleted S3 attributes */
            assert.strictEqual(value?.etag, undefined);
            assert.strictEqual(value?.storageclass, undefined);
            assert.strictEqual(value?.size, undefined);
          }
          assert.strictEqual(files.source.size, 15);
          for (const [key, value] of files.source) {
            /** Check if the Z IS ADDED at the end of the date */
            if (value.key === 'swift-4-608cdb') {
              assert.strictEqual(value.lastmodified, 1626875695057); // 2021-07-21T13:54:55.057450Z: milliseconds kept
            }
            assert.strictEqual(value.key.startsWith('swift-'), true);
            assert.strictEqual(key, value.key);
            assert.strictEqual(value.lastmodified > 0, true);
            assert.strictEqual(value.md5.length > 0, true);
            assert.strictEqual(value.bytes > 0, true);
            /** Deleted SWIFT attributes */
            assert.strictEqual(value?.content_type, undefined);
            assert.strictEqual(value?.last_modified, undefined);
            assert.strictEqual(value?.hash, undefined);
            assert.strictEqual(value?.name, undefined);
          }
          assert.strictEqual(files.cache.size, 0);
          done();
        });
      });

      it('should return the list of files from Swift/S3 as Maps and should paginate automatically', function(done) {

        const nockListFilesS3 = nock(urlS3)
          .defaultReplyHeaders({ 'content-type': 'application/xml' })
          .get('/invoices')
          .query({ 'list-type' : '2' })
          .reply(200, () => {
            return fs.readFileSync(path.join(__dirname, "assets", "listFiles.s3.paginate.xml"));
          })
          .get('/invoices')
          .query({ 'list-type' : '2', "start-after": "s3-2-paginate-document-5.pdf" })
          .reply(200, () => {
            return fs.readFileSync(path.join(__dirname, "assets", "listFiles.s3.xml"));
          });


        const nockListFilesSwift = nock(urlSwift)
          .defaultReplyHeaders({ 'content-type': 'application/json' })
          .get('/invoices')
          .query({ 'limit' : '15' })
          .reply(200, () => {
            return fs.readFileSync(path.join(__dirname, 'assets', 'listFiles.swift.json'));
          })
          .get('/invoices')
          .query({ 'limit' : '15', 'marker': 'swift-4-608cdb' })
          .reply(200, () => {
            return fs.readFileSync(path.join(__dirname, 'assets', 'listFiles.swift.paginate.json'));
          })
          /** The listing ends on an empty page */
          .get('/invoices')
          .query({ 'limit' : '15', 'marker': 'swift-4-161913' })
          .reply(200, '[]', { 'content-type': 'application/json' });

        storage.fetchListFiles(files, { swift: { queries: { limit: 15 } } }, function(err) {
          assert.strictEqual(err, undefined);
          assert.strictEqual(nockListFilesS3.pendingMocks().length, 0);
          assert.strictEqual(nockListFilesSwift.pendingMocks().length, 0);
          assert.strictEqual(files.target.size, 10);
          assert.strictEqual(files.source.size, 23);
          done();
        });
      });
    });

  });

});

describe('convertHeaders', function() {

  it('should convert swift headers to s3 headers', function () {
    const swiftHeaders = {
      'x-object-meta-name': 'custom name',
      'x-object-meta-custom-2': 'custom attribute not supported',
    };
    const _s3Headers = {
      'x-amz-meta-name': 'custom%20name',
      'x-amz-meta-custom-2': 'custom%20attribute%20not%20supported',
    };
    assert.strictEqual(JSON.stringify(storage.convertHeaders(swiftHeaders, 'swift', 's3')), JSON.stringify(_s3Headers));
  });

  it('should convert swift headers to s3 headers THEN should convert s3 headers to swift', function () {
    const swiftHeaders = {
      'content-length': '31078',
      'x-object-meta-name': 'RÃ©capitulatif des quantitÃ©s sa',
      'x-object-meta-desc': 'RÃ©capitulatif des quantitÃ©s saisies par Ã©lÃ©ment de repas dans chaque trame de menu par site',
      'last-modified': 'Thu, 23 Feb 2023 01:14:34 GMT',
      'accept-ranges': 'bytes',
      etag: '84f955aea2728719fdeca60fbcb98494',
      'x-timestamp': '1677114873.57139',
      'content-type': 'application/vnd.oasis.opendocument.spreadsheet',
      'x-trans-id': 'txf38b8c7f1a5945b2b93c8-0064520f5f',
      'x-openstack-request-id': 'txf38b8c7f1a5945b2b93c8-0064520f5f',
      date: 'Wed, 03 May 2023 07:38:07 GMT',
      'x-iplb-request-id': '25A903A8:1DC8_5762BBC9:01BB_64520F5E_267D4F42:133BB',
      'x-iplb-instance': '42085'
    };
    /** The raw UTF-8 metadata of Swift is read as latin1 by Node ("Ã©"): decoded back, then encoded once ("é" = %C3%A9) */
    const _s3Headers = {
      'x-amz-meta-name': 'R%C3%A9capitulatif%20des%20quantit%C3%A9s%20sa',
      'x-amz-meta-desc': 'R%C3%A9capitulatif%20des%20quantit%C3%A9s%20saisies%20par%20%C3%A9l%C3%A9ment%20de%20repas%20dans%20chaque%20trame%20de%20menu%20par%20site',
      'content-type': 'application/vnd.oasis.opendocument.spreadsheet'
    };
    const _expectedSwiftHeader = {
      "x-object-meta-name":"R%C3%A9capitulatif%20des%20quantit%C3%A9s%20sa",
      "x-object-meta-desc":"R%C3%A9capitulatif%20des%20quantit%C3%A9s%20saisies%20par%20%C3%A9l%C3%A9ment%20de%20repas%20dans%20chaque%20trame%20de%20menu%20par%20site",
      "content-type":"application/vnd.oasis.opendocument.spreadsheet"
    };
    assert.strictEqual(JSON.stringify(storage.convertHeaders(swiftHeaders, 'swift', 's3')), JSON.stringify(_s3Headers));
    assert.strictEqual(JSON.stringify(storage.convertHeaders(_s3Headers, 's3', 'swift')), JSON.stringify(_expectedSwiftHeader));
  });

  it('should decode a raw UTF-8 metadata read as latin1, and never change a value which is not valid UTF-8', function () {
    const _raw = (text) => Buffer.from(text, 'utf8').toString('latin1');
    assert.deepStrictEqual(storage.convertHeaders({
      'x-object-meta-a': _raw('Récapitulatif 日本'),
      'x-object-meta-b': 'caf\u00e9',
      'x-object-meta-c': _raw('Ã©'),
      'x-object-meta-d': 'plain ascii',
      'x-object-meta-e': 'R%C3%A9sum%C3%A9',
      'x-object-meta-f': '中文',
      'content-disposition': _raw('attachment; filename="é.pdf"')
    }, 'swift', 's3'), {
      'x-amz-meta-a': encodeURIComponent('Récapitulatif 日本'),
      'x-amz-meta-b': 'caf%C3%A9',
      'x-amz-meta-c': encodeURIComponent('Ã©'),
      'x-amz-meta-d': 'plain%20ascii',
      'x-amz-meta-e': 'R%C3%A9sum%C3%A9',
      'x-amz-meta-f': encodeURIComponent('中文'),
      'content-disposition': _raw('attachment; filename="é.pdf"')
    });
  });

  it('should not convert s3 to s3 headers', function(done) {
    const _s3Headers = {
      'x-amz-meta-name': 'R%C3%83%C2%A9capitulatif%20des%20quantit%C3%83%C2%A9s%20sa',
      'x-amz-meta-desc': 'R%C3%83%C2%A9capitulatif%20des%20quantit%C3%83%C2%A9s%20saisies%20par%20%C3%83%C2%A9l%C3%83%C2%A9ment%20de%20repas%20dans%20chaque%20trame%20de%20menu%20par%20site',
      'content-type': 'application/vnd.oasis.opendocument.spreadsheet'
    };
    assert.strictEqual(JSON.stringify(storage.convertHeaders(_s3Headers, 's3', 's3')), JSON.stringify(_s3Headers));
    done();
  });

  it('should not convert swift to swift headers', function(done) {
    const _swiftHeaders = {
      "x-object-meta-name":"R%C3%83%C2%A9capitulatif%20des%20quantit%C3%83%C2%A9s%20sa",
      "x-object-meta-desc":"R%C3%83%C2%A9capitulatif%20des%20quantit%C3%83%C2%A9s%20saisies%20par%20%C3%83%C2%A9l%C3%83%C2%A9ment%20de%20repas%20dans%20chaque%20trame%20de%20menu%20par%20site",
      "content-type":"application/vnd.oasis.opendocument.spreadsheet"
    };
    assert.strictEqual(JSON.stringify(storage.convertHeaders(_swiftHeaders, 'swift', 'swift')), JSON.stringify(_swiftHeaders));
    done();
  });

  it('should copy the standard headers of the object, and never the encryption, version, etag or date headers', function () {
    const _standard = {
      'content-type'       : 'text/plain',
      'content-encoding'   : 'gzip',
      'content-disposition': 'attachment; filename="a.txt"',
      'content-language'   : 'fr',
      'cache-control'      : 'max-age=60',
      'expires'            : 'Thu, 01 Jan 2099 00:00:00 GMT'
    };
    const _ignored = {
      'x-amz-server-side-encryption'               : 'aws:kms',
      'x-amz-server-side-encryption-aws-kms-key-id': 'key',
      'x-amz-version-id'                           : 'v1',
      'etag'                                       : '"abc"',
      'last-modified'                              : 'Thu, 23 Feb 2023 01:14:34 GMT',
      'content-length'                             : '10',
      'x-timestamp'                                : '1677114873.57139'
    };
    assert.deepStrictEqual(storage.convertHeaders({ ..._standard, ..._ignored, 'x-amz-meta-a': 'b' }, 's3', 's3'), { ..._standard, 'x-amz-meta-a': 'b' });
    assert.deepStrictEqual(storage.convertHeaders({ ..._standard, ..._ignored, 'x-amz-meta-a': 'b' }, 's3', 'swift'), { ..._standard, 'x-object-meta-a': 'b' });
    assert.deepStrictEqual(storage.convertHeaders({ ..._standard, ..._ignored, 'x-object-meta-a': 'b' }, 'swift', 's3'), { ..._standard, 'x-amz-meta-a': 'b' });
  });

  it('should encode the non ASCII characters of a value already encoded or holding a "%": a header value must be ASCII', function () {
    const _raw = (text) => Buffer.from(text, 'utf8').toString('latin1');
    const _headers = storage.convertHeaders({ 'x-amz-meta-note': _raw('50% €'), 'x-amz-meta-off': '50% off', 'x-amz-meta-enc': 'R%C3%A9sum%C3%A9' }, 's3', 'swift');
    assert.deepStrictEqual(_headers, { 'x-object-meta-note': '50% %E2%82%AC', 'x-object-meta-off': '50% off', 'x-object-meta-enc': 'R%C3%A9sum%C3%A9' });
    assert.deepStrictEqual(storage.convertHeaders({ 'x-object-meta-note': _raw('Réduction — 50%') }, 'swift', 's3'), { 'x-amz-meta-note': 'R%C3%A9duction %E2%80%94 50%' });
    for (const [_name, _value] of Object.entries(_headers)) {
      require('http').validateHeaderValue(_name, _value);
    }
    /** Stable: copied again, the value is unchanged */
    assert.deepStrictEqual(storage.convertHeaders(_headers, 'swift', 's3'), { 'x-amz-meta-note': '50% %E2%82%AC', 'x-amz-meta-off': '50% off', 'x-amz-meta-enc': 'R%C3%A9sum%C3%A9' });
  });

  it('should only convert the headers starting with the metadata prefix', function () {
    assert.deepStrictEqual(storage.convertHeaders({ 'x-custom-x-amz-meta-a': 'b', 'x-amz-meta-x-amz-meta-c': 'd' }, 's3', 'swift'), { 'x-object-meta-x-amz-meta-c': 'd' });
  });

  it('should not throw an error if the encoded metadata is not correct', function (done) {
    const _s3Headers = {
      'x-amz-meta-name': 'R%C3%83%C2%A9capitulatif%20des%20quantit%C',
    };
    const _swiftHeaders = {
      'x-object-meta-name': 'R%C3%83%C2%A9capitulatif%20des%20quantit%C',
    };
    assert.strictEqual(JSON.stringify(storage.convertHeaders(_s3Headers, 's3', 'swift')), JSON.stringify(_swiftHeaders));
    done();
  });

});

const connectionResultSuccessV3 = {
  "token": {
    "catalog": [
      {
        "endpoints": [
          {
            "region_id": "GRA",
            "url": urlSwift,
            "region": "GRA",
            "interface": "admin",
            "id": "1368e887740b4cd395191fccd32aebc5"
          }
        ],
        "type": "object-store",
        "id": "9afff7a684eb4830b08366fce2b94c57",
        "name": "swift"
      }
    ]
  }
};

const connectionResultSuccessV3SBG = {
  "token": {
    "catalog": [
      {
        "endpoints": [
          {
            "region_id": "SBG",
            "url": urlSwiftSBG,
            "region": "SBG",
            "interface": "admin",
            "id": "1368e887740b4cd395191fccd32aebc5"
          }
        ],
        "type": "object-store",
        "id": "9afff7a684eb4830b08366fce2b94c57",
        "name": "swift"
      }
    ]
  }
};