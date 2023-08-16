const assert = require('assert');
const storage = require('../storage');
const nock = require('nock')
const path = require('path')
const fs = require('fs')
const helper = require('../helper');

const files = {
  target        : new Map(),
  source        : new Map(),
  cache         : new Map(),
}
const urlS3 = 'https://s3.gra.first.cloud.test';
const urlS3SBG = 'https://s3.sbg.first.cloud.test';

const urlAuthSwift   = 'https://auth.cloud.ovh.net/v3';
const urlSwift = 'https://storage.gra.cloud.ovh.net/v1/AUTH_ce3e510224d740a685cb0ae7bdb8ebc3';
const urlSwiftSBG = 'https://storage.sbg.cloud.ovh.net/v1/AUTH_ce3e510224d740a685cb0ae7bdb8ebc3';
const tokenAuthSwift = 'gAAAAABe8JlEGYPUwwOyjqgUBl11gSjDOw5VTtUZ5n8SWxghRGwakDkP_lelLfRctzyhbIFUXjsdPaGmV2xicL-9333lJUnL3M4JYlYCYMWsX3IhnLPYboyti835VdhAHQ7K_d0OC4OYvM04bvL3w_uSbkxPmL27uO0ISUgQdB_mHxoYlol8xYI'


let _config = {}

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

    helper.loadConfig('config.test-swift-s3.json', function(err, config) {
      assert.strictEqual(err, null);
      _config = config;
      storage.connection(_config, 'source', function(err) {
        assert.strictEqual(err, undefined);
          storage.connection(_config, 'target', function(err) {
          assert.strictEqual(err, undefined);
          assert.strictEqual(nockAuthSwift.pendingMocks().length, 0);
          assert.strictEqual(nockAuthS3.pendingMocks().length, 0);
          files.source = new Map()
          files.target = new Map()
          files.cache = new Map()
          return done();
        })
      })
    })

  })

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
      ]
      storage.syncFiles([], _filestoDeleteTarget, [], [], helper.MODES.BI, function(err) {
        assert.strictEqual(err, undefined);
        assert.strictEqual(nockBulkDeleteS3.pendingMocks().length, 0);
        done();
      })
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

      const _filestoDeleteS3 = []

      for (let i = 0; i < 2000; i++) {
        _filestoDeleteS3.push({ key: `files${i}.txt` })
      }
      storage.syncFiles([], _filestoDeleteS3, [], [], helper.MODES.BI, function(err) {
        assert.strictEqual(err, undefined);
        assert.strictEqual(nockBulkDeleteS3.pendingMocks().length, 0);
        done();
      })
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
        })
        .get('/invoices/1!file.txt')
        .reply(200, () => {
          return _fileContent;
        });

      const _filesToUploadS3 = [];

      _filesToUploadS3.push({ key: `1!file.txt` })

      storage.syncFiles(_filesToUploadS3, [], [], [], helper.MODES.BI, function(err) {
        assert.strictEqual(err, undefined);
        assert.strictEqual(nockS3Upload.pendingMocks().length, 0);
        assert.strictEqual(nockSwiftDownload.pendingMocks().length, 0);
        done();
      })
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

      _filesToUploadSwift.push({ key: `1-file.txt` })

      storage.syncFiles([], [], _filesToUploadSwift, [], helper.MODES.BI, function(err) {
        assert.strictEqual(err, undefined);
        assert.strictEqual(nockS3Download.pendingMocks().length, 0);
        assert.strictEqual(nockSwiftUpload.pendingMocks().length, 0);
        done();
      })
    });
  })

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

        helper.loadConfig('config.test-s3-s3.json', function(err, config) {
          assert.strictEqual(err, null);
          _config = config;
          storage.connection(_config, 'source', function(err) {
            assert.strictEqual(err, undefined);
            storage.connection(_config, 'target', function(err) {
              assert.strictEqual(err, undefined);
              assert.strictEqual(nockAuthS3SBG.pendingMocks().length, 0);
              assert.strictEqual(nockAuthS3GRA.pendingMocks().length, 0);
              done();
            })
          })
        })
      })

      it('should return the list of files from S3/S3 as Maps (paginate automatically)', function(done) {

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
            assert.strictEqual(value.bytes > 0, true);
            /** Deleted S3 attributes */
            assert.strictEqual(value?.etag, undefined);
            assert.strictEqual(value?.storageclass, undefined);
            assert.strictEqual(value?.size, undefined);
          }
          done();
        })
      })
    })

    describe('Source: SWIFT / Target: SWIFT', function() {
      
      beforeEach(function (done) {
        const nockAuthSwift = nock(urlAuthSwift)
          .post('/auth/tokens')
          .reply(200, connectionResultSuccessV3, { "X-Subject-Token": tokenAuthSwift });

        const nockAuthSwiftSBG = nock(urlAuthSwift)
          .post('/auth/tokens')
          .reply(200, connectionResultSuccessV3SBG, { "X-Subject-Token": tokenAuthSwift });

        helper.loadConfig('config.test-swift-swift.json', function(err, config) {
          assert.strictEqual(err, null);
          
          const _config = config;          
          storage.connection(_config, 'target', function(err) {
            assert.strictEqual(err, undefined);
            assert.strictEqual(nockAuthSwift.pendingMocks().length, 0);
            storage.connection(_config, 'source', function(err) {
              assert.strictEqual(err, undefined);
              assert.strictEqual(nockAuthSwiftSBG.pendingMocks().length, 0);
              done();
            })
          })
        })
      })

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

        const nockListFilesSwiftSBG = nock(urlSwiftSBG)
          .defaultReplyHeaders({ 'content-type': 'application/json' })
          .get('/invoices')
          .query({ 'limit' : '15' })
          .reply(200, () => {
            return fs.readFileSync(path.join(__dirname, 'assets', 'listFiles.swift.paginate.json'));
          })

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
          }
          done();
        });
      })
    })

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

        helper.loadConfig('config.test-s3-swift.json', function(err, config) {
          assert.strictEqual(err, null);
          _config = config;
          storage.connection(_config, 'source', function(err) {
            assert.strictEqual(err, undefined);
            storage.connection(_config, 'target', function(err) {
              assert.strictEqual(err, undefined);
              assert.strictEqual(nockAuthSwift.pendingMocks().length, 0);
              assert.strictEqual(nockAuthS3.pendingMocks().length, 0);
              done();
            })
          })
        })
      })
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
        })
      })
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
      })

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

        storage.fetchListFiles(files, { swift: { queries: { limit: 15 } } }, function(err) {
          assert.strictEqual(err, undefined);
          assert.strictEqual(nockListFilesS3.pendingMocks().length, 0);
          assert.strictEqual(nockListFilesSwift.pendingMocks().length, 0);
          assert.strictEqual(files.target.size, 10);
          assert.strictEqual(files.source.size, 23);
          done();
        })
      })
    })

  })

});

describe('convertHeaders', function() {

  it('should convert swift headers to s3 headers', function () {
    const swiftHeaders = {
      'x-object-meta-name': 'custom name',
      'x-object-meta-custom-2': 'custom attribute not supported',
    }
    const _s3Headers = {
      'x-amz-meta-name': 'custom%20name',
      'x-amz-meta-custom-2': 'custom%20attribute%20not%20supported',
    }
    assert.strictEqual(JSON.stringify(storage.convertHeaders(swiftHeaders, 'swift', 's3')), JSON.stringify(_s3Headers))
  })

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
    }
    const _s3Headers = {
      'x-amz-meta-name': 'R%C3%83%C2%A9capitulatif%20des%20quantit%C3%83%C2%A9s%20sa',
      'x-amz-meta-desc': 'R%C3%83%C2%A9capitulatif%20des%20quantit%C3%83%C2%A9s%20saisies%20par%20%C3%83%C2%A9l%C3%83%C2%A9ment%20de%20repas%20dans%20chaque%20trame%20de%20menu%20par%20site',
      'content-type': 'application/vnd.oasis.opendocument.spreadsheet'
    }
    const _expectedSwiftHeader = {
      "x-object-meta-name":"R%C3%83%C2%A9capitulatif%20des%20quantit%C3%83%C2%A9s%20sa",
      "x-object-meta-desc":"R%C3%83%C2%A9capitulatif%20des%20quantit%C3%83%C2%A9s%20saisies%20par%20%C3%83%C2%A9l%C3%83%C2%A9ment%20de%20repas%20dans%20chaque%20trame%20de%20menu%20par%20site",
      "content-type":"application/vnd.oasis.opendocument.spreadsheet"
    }
    assert.strictEqual(JSON.stringify(storage.convertHeaders(swiftHeaders, 'swift', 's3')), JSON.stringify(_s3Headers))
    assert.strictEqual(JSON.stringify(storage.convertHeaders(_s3Headers, 's3', 'swift')), JSON.stringify(_expectedSwiftHeader))
  })

  it('should not convert s3 to s3 headers', function(done) {
    const _s3Headers = {
      'x-amz-meta-name': 'R%C3%83%C2%A9capitulatif%20des%20quantit%C3%83%C2%A9s%20sa',
      'x-amz-meta-desc': 'R%C3%83%C2%A9capitulatif%20des%20quantit%C3%83%C2%A9s%20saisies%20par%20%C3%83%C2%A9l%C3%83%C2%A9ment%20de%20repas%20dans%20chaque%20trame%20de%20menu%20par%20site',
      'content-type': 'application/vnd.oasis.opendocument.spreadsheet'
    }
    assert.strictEqual(JSON.stringify(storage.convertHeaders(_s3Headers, 's3', 's3')), JSON.stringify(_s3Headers))
    done()
  })

  it('should not convert swift to swift headers', function(done) {
    const _swiftHeaders = {
      "x-object-meta-name":"R%C3%83%C2%A9capitulatif%20des%20quantit%C3%83%C2%A9s%20sa",
      "x-object-meta-desc":"R%C3%83%C2%A9capitulatif%20des%20quantit%C3%83%C2%A9s%20saisies%20par%20%C3%83%C2%A9l%C3%83%C2%A9ment%20de%20repas%20dans%20chaque%20trame%20de%20menu%20par%20site",
      "content-type":"application/vnd.oasis.opendocument.spreadsheet"
    }
    assert.strictEqual(JSON.stringify(storage.convertHeaders(_swiftHeaders, 'swift', 'swift')), JSON.stringify(_swiftHeaders))
    done()
  });

  it('should not throw an error if the encoded metadata is not correct', function (done) {
    const _s3Headers = {
      'x-amz-meta-name': 'R%C3%83%C2%A9capitulatif%20des%20quantit%C',
    }
    const _swiftHeaders = {
      'x-object-meta-name': 'R%C3%83%C2%A9capitulatif%20des%20quantit%C',
    }
    assert.strictEqual(JSON.stringify(storage.convertHeaders(_s3Headers, 's3', 'swift')), JSON.stringify(_swiftHeaders))
    done();
  })

})

let connectionResultSuccessV3 = {
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
}

let connectionResultSuccessV3SBG = {
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
}