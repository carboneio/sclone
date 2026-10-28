const assert = require('assert');
const storage = require('../storage');
const nock = require('nock');
const path = require('path');
const fs = require('fs');
const helper = require('../helper');

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

describe("storage", function() {

  beforeEach(function(done) {
    const nockAuthSwift = nock(urlAuthSwift)
      .post('/auth/tokens')
      .reply(200, connectionResultSuccessV3, { "X-Subject-Token": tokenAuthSwift });

    const nockAuthS3 = nock(urlS3)
      .defaultReplyHeaders({ 'content-type': 'application/xml' })
      .get('/')
      .reply(200, () => {
        return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListAllMyBucketsResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Owner><ID>89123456:user-feiowjfOEIJW</ID><DisplayName>12345678:user-feiowjfOEIJW</DisplayName></Owner><Buckets><Bucket><Name>invoices</Name><CreationDate>2023-02-27T11:46:24.000Z</CreationDate></Bucket></Buckets></ListAllMyBucketsResult>";
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
          return '';
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
          return '';
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
          return '';
        })
        .post('/invoices/')
        .query((actualQueryObject) => {
          assert.strictEqual(actualQueryObject.delete !== undefined, true);
          return true;
        })
        .reply(200, (uri, body) => {
          assert.strictEqual(body.split("files").length - 1, 1000);
          return '';
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

        storage.syncFiles([{ key: 'file.pdf' }], [], [], [], { mode: helper.MODES.UNI }, function(err) {
          assert.strictEqual(err instanceof Error, true);
          assert.strictEqual(err.toString().includes('upload-from-source-to-target | 1 operation(s) failed'), true, err.toString());
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

    describe('integrityCheck', function() {
      const _fileContent = Buffer.from('Hello1234');
      const _fileMD5 = '43d5d2b9e7e4c4e1c1fbb7a2bc4a7c4a';

      beforeEach(function(done) {
        const nockAuthS3 = nock(urlS3)
          .defaultReplyHeaders({ 'content-type': 'application/xml' })
          .get('/')
          .reply(200, "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListAllMyBucketsResult><Buckets><Bucket><Name>invoices</Name></Bucket></Buckets></ListAllMyBucketsResult>");
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
    });

    it('should return an error if a file transfer fails after retries (the caller must not save the cache)', function(done) {
      /** Download from the target (S3) fails on the first try and on the retry */
      const nockS3Download = nock(urlS3)
        .get('/invoices/missing-file.txt')
        .times(2)
        .reply(404);

      storage.syncFiles([], [], [{ key: 'missing-file.txt' }], [], { mode: helper.MODES.BI, retry: 1 }, function(err) {
        assert.strictEqual(err instanceof Error, true);
        assert.strictEqual(err.toString().includes('Synchronisation errors'), true);
        assert.strictEqual(err.toString().includes('upload-from-target-to-source'), true);
        assert.strictEqual(err.toString().includes('1 operation(s) failed'), true);
        assert.strictEqual(nockS3Download.pendingMocks().length, 0);
        done();
      });
    });

    it('should bulkDeletes objects on the source storage (S3) (delete-files-source queue)', function(done) {
      const nockAuthS3GRA = nock(urlS3)
        .defaultReplyHeaders({ 'content-type': 'application/xml' })
        .get('/')
        .reply(200, () => {
          return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListAllMyBucketsResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Owner><ID>89123456:user-feiowjfOEIJW</ID><DisplayName>12345678:user-feiowjfOEIJW</DisplayName></Owner><Buckets><Bucket><Name>invoices</Name><CreationDate>2023-02-27T11:46:24.000Z</CreationDate></Bucket></Buckets></ListAllMyBucketsResult>";
        });

      const nockBulkDeleteSourceS3 = nock(urlS3)
        .post('/invoices/')
        .query((actualQueryObject) => {
          assert.strictEqual(actualQueryObject.delete !== undefined, true);
          return true;
        })
        .reply(200, (uri, body) => {
          assert.strictEqual(body, "<Delete><Object><Key>old1.txt</Key></Object><Object><Key>old2.txt</Key></Object><Quiet>false</Quiet></Delete>");
          return '';
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
          .get('/')
          .reply(200, () => {
            return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListAllMyBucketsResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Owner><ID>89123456:user-feiowjfOEIJW</ID><DisplayName>12345678:user-feiowjfOEIJW</DisplayName></Owner><Buckets><Bucket><Name>invoices</Name><CreationDate>2023-02-27T11:46:24.000Z</CreationDate></Bucket></Buckets></ListAllMyBucketsResult>";
          });
        const nockAuthS3SBG = nock(urlS3SBG)
          .defaultReplyHeaders({ 'content-type': 'application/xml' })
          .get('/')
          .reply(200, () => {
            return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListAllMyBucketsResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Owner><ID>89123456:user-feiowjfOEIJW</ID><DisplayName>12345678:user-feiowjfOEIJW</DisplayName></Owner><Buckets><Bucket><Name>invoices</Name><CreationDate>2023-02-27T11:46:24.000Z</CreationDate></Bucket></Buckets></ListAllMyBucketsResult>";
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
            assert.deepStrictEqual(Object.keys(value), ['key', 'md5', 'lastmodified', 'bytes']);
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
        const _s3Page = (keys, { isTruncated = 'false', keyCount = keys.length, etag = '"7ad22b1297611d62ef4a4704c97afa6b"' } = {}) => {
          return '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>invoices</Name><Prefix></Prefix>'
            + (keyCount === null ? '' : `<KeyCount>${keyCount}</KeyCount>`) + '<MaxKeys>1000</MaxKeys>'
            + (isTruncated === null ? '' : `<IsTruncated>${isTruncated}</IsTruncated>`)
            + keys.map((key) => `<Contents><Key>${key}</Key><LastModified>2023-03-07T17:03:54.000Z</LastModified>${etag === null ? '' : `<ETag>${etag}</ETag>`}<Size>61396</Size><StorageClass>STANDARD</StorageClass></Contents>`).join('')
            + '</ListBucketResult>';
        };

        /** The target is valid, the source returns the pages given as arguments (twice: the listing is retried once) */
        function mockListings (sourcePages) {
          const _nockSource = nock(urlS3).defaultReplyHeaders({ 'content-type': 'application/xml' });
          for (let i = 0; i < 2; i++) {
            for (const _page of sourcePages) {
              _nockSource.get('/invoices').query(_page.query).reply(200, _page.body);
            }
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

        it('should return an error if a file has no ETag', function(done) {
          mockListings([{ query: { 'list-type' : '2' }, body: _s3Page(['file-1.pdf'], { etag: null }) }]);
          assertListingError('Invalid listing: a file without a valid "ETag" was returned by the source storage', done);
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
          });

        const nockListFilesSwiftSBG = nock(urlSwiftSBG)
          .defaultReplyHeaders({ 'content-type': 'application/json' })
          .get('/invoices')
          .query({ 'limit' : '15' })
          .reply(200, () => {
            return fs.readFileSync(path.join(__dirname, 'assets', 'listFiles.swift.paginate.json'));
          });

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
            assert.deepStrictEqual(Object.keys(value), ['key', 'md5', 'lastmodified', 'bytes']);
          }
          done();
        });
      });

      describe('Invalid SWIFT listing', function() {
        function mockSourceListing () {
          nock(urlSwiftSBG)
            .defaultReplyHeaders({ 'content-type': 'application/json' })
            .get('/invoices')
            .query({ 'limit' : '15' })
            .reply(200, () => fs.readFileSync(path.join(__dirname, 'assets', 'listFiles.swift.paginate.json')));
        }

        it('should return an error if the listing is not a JSON list (HTML error page with a status 200)', function(done) {
          mockSourceListing();
          nock(urlSwift)
            .defaultReplyHeaders({ 'content-type': 'text/html' })
            .get('/invoices')
            .query({ 'limit' : '15' })
            .times(2)
            .reply(200, '<html><body>Service Unavailable</body></html>');

          storage.fetchListFiles(files, { swift: { queries: { limit: 15 } } }, function(err) {
            assert.strictEqual(typeof err, 'string');
            assert.strictEqual(err.includes('Invalid listing: a JSON list is expected | Status: 200 | Container: invoices'), true, err);
            nock.cleanAll();
            done();
          });
        });

        it('should return an error if a file has no hash', function(done) {
          mockSourceListing();
          nock(urlSwift)
            .defaultReplyHeaders({ 'content-type': 'application/json' })
            .get('/invoices')
            .query({ 'limit' : '15' })
            .times(2)
            .reply(200, JSON.stringify([{ name: 'file-1.pdf', bytes: 10, last_modified: '2023-03-07T17:03:54.000000' }]));

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
            .times(2)
            .reply(200, JSON.stringify([{ name: 1, hash: '7ad22b1297611d62ef4a4704c97afa6b', bytes: 10, last_modified: '2023-03-07T17:03:54.000000' }]));

          storage.fetchListFiles(files, { swift: { queries: { limit: 15 } } }, function(err) {
            assert.strictEqual(typeof err, 'string');
            assert.strictEqual(err.includes('Invalid listing: a file without a valid "name" was returned by the target storage'), true, err);
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
          .get('/')
          .reply(200, () => {
            return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListAllMyBucketsResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Owner><ID>89123456:user-feiowjfOEIJW</ID><DisplayName>12345678:user-feiowjfOEIJW</DisplayName></Owner><Buckets><Bucket><Name>invoices</Name><CreationDate>2023-02-27T11:46:24.000Z</CreationDate></Bucket></Buckets></ListAllMyBucketsResult>";
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
          });

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
              assert.strictEqual(value.lastmodified, 1626875695000); // 2021-07-21T13:54:55.057450Z
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
          .get('/invoices')
          .query({ 'list-type' : '2' })
          .reply(500, 'Storage - Something went wrong');

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
          });

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
              assert.strictEqual(value.lastmodified, 1626875695000); // 2021-07-21T13:54:55.057450Z
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
          });

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
    const _s3Headers = {
      'x-amz-meta-name': 'R%C3%83%C2%A9capitulatif%20des%20quantit%C3%83%C2%A9s%20sa',
      'x-amz-meta-desc': 'R%C3%83%C2%A9capitulatif%20des%20quantit%C3%83%C2%A9s%20saisies%20par%20%C3%83%C2%A9l%C3%83%C2%A9ment%20de%20repas%20dans%20chaque%20trame%20de%20menu%20par%20site',
      'content-type': 'application/vnd.oasis.opendocument.spreadsheet'
    };
    const _expectedSwiftHeader = {
      "x-object-meta-name":"R%C3%83%C2%A9capitulatif%20des%20quantit%C3%83%C2%A9s%20sa",
      "x-object-meta-desc":"R%C3%83%C2%A9capitulatif%20des%20quantit%C3%83%C2%A9s%20saisies%20par%20%C3%83%C2%A9l%C3%83%C2%A9ment%20de%20repas%20dans%20chaque%20trame%20de%20menu%20par%20site",
      "content-type":"application/vnd.oasis.opendocument.spreadsheet"
    };
    assert.strictEqual(JSON.stringify(storage.convertHeaders(swiftHeaders, 'swift', 's3')), JSON.stringify(_s3Headers));
    assert.strictEqual(JSON.stringify(storage.convertHeaders(_s3Headers, 's3', 'swift')), JSON.stringify(_expectedSwiftHeader));
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