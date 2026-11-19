const assert = require('assert');
const logic = require('../logic');
const fs = require('fs');
const os = require('os');
const path = require('path');
const helper = require('../helper');
const { captureLogs } = require('./support/logs');

const UNI = helper.MODES.UNI;
const BI = helper.MODES.BI;
/** Plain MD5 etags (single PUT), a multipart etag and an opaque etag (OVH encrypted object after a server-side copy) */
const MD5_A = 'a'.repeat(32);
const MD5_B = 'b'.repeat(32);
const MD5_C = 'c'.repeat(32);
const MULTIPART = 'b62e2a390d253298e9f061541ec39fc6-2';
const MULTIPART_OLD = 'a55b475be5fc06d42e1baf84231253ce-2';
const OPAQUE = 'e'.repeat(64);
const OPAQUE_2 = 'f'.repeat(64);
const T0 = 1760040726000;

function file (key, md5, bytes = 10, lastmodified = T0) {
  return { key, md5, bytes, lastmodified };
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
const entryOf = (files, key) => entriesOf(files)[key];

/**
 * Run computeSync on listings and a cache. `cache` entries: key → [sourceEtag, sourceBytes, targetEtag, targetBytes]
 * @returns {Object} plan with the keys of each list, the raw plan and the files
 */
function sync (mode, deletion, { source = [], target = [], cache = {} }, files) {
  if (files === undefined) {
    files = { source: new Map(source.map((f) => [f.key, f])), target: new Map(target.map((f) => [f.key, f])) };
    for (const [key, entry] of Object.entries(cache)) {
      helper.setCacheEntry(files, key, ...entry);
    }
  }
  const _plan = logic.computeSync(files, mode, deletion);
  const _keys = (list) => list.map((f) => f.key ?? f.object.key).sort();
  return {
    uploadTarget: _keys(_plan.objectsToUploadTarget),
    deleteTarget: _keys(_plan.objectsToDeleteTarget),
    uploadSource: _keys(_plan.objectsToUploadSource),
    deleteSource: _keys(_plan.objectsToDeleteSource),
    resolve     : _plan.objectsToResolve.map((r) => r.side + ':' + r.object.key).sort(),
    plan        : _plan,
    files       : files
  };
}

/** Simulate a successful transfer of every planned operation: the PUT etag is the MD5 `putEtag` */
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
function actions (result) {
  const { uploadTarget, deleteTarget, uploadSource, deleteSource, resolve } = result;
  return { uploadTarget, deleteTarget, uploadSource, deleteSource, resolve };
}

describe("logic", function() {
  let logs = null;

  beforeEach(function() {
    logs = captureLogs();
  });

  afterEach(function() {
    logs.restore();
  });

  describe("etags", function() {
    it('should detect multipart, plain MD5 and opaque etags', function() {
      assert.strictEqual(logic.isMultipartEtag(MULTIPART), true);
      assert.strictEqual(logic.isMultipartEtag("B62E2A390D253298E9F061541EC39FC6-10000"), true);
      assert.strictEqual(logic.isMultipartEtag(MD5_A), false);
      assert.strictEqual(logic.isMultipartEtag("file-2"), false);
      assert.strictEqual(logic.isMultipartEtag(undefined), false);
      assert.strictEqual(logic.isMd5(MD5_A), true);
      assert.strictEqual(logic.isMd5(OPAQUE), false);
      assert.strictEqual(logic.isOpaqueEtag(OPAQUE), true);
      assert.strictEqual(logic.isOpaqueEtag(MD5_A), false);
      assert.strictEqual(logic.isOpaqueEtag(MULTIPART), false);
    });

    it('should compare the content of two objects without downloading them', function() {
      assert.strictEqual(logic.isSameContent(file('a', MD5_A), file('a', MD5_A.toUpperCase())), true);
      assert.strictEqual(logic.isSameContent(file('a', MD5_A), file('a', MD5_B)), false);
      assert.strictEqual(logic.isSameContent(file('a', MD5_A, 10), file('a', MD5_A, 11)), false, 'different sizes');
      assert.strictEqual(logic.isSameContent(file('a', MULTIPART), file('a', MULTIPART)), true, 'identical multipart etags');
      assert.strictEqual(logic.isSameContent(file('a', MULTIPART), file('a', MULTIPART_OLD)), false);
      assert.strictEqual(logic.isSameContent(file('a', MULTIPART, 10, T0), file('a', MD5_A, 10, T0 + 1)), false, 'multipart vs MD5: not provable');
      assert.strictEqual(logic.isSameContent(file('a', OPAQUE), file('a', MD5_A)), undefined, 'opaque etag: must be resolved');
      assert.strictEqual(logic.isSameContent(file('a', OPAQUE, 10), file('a', MD5_A, 11)), false, 'different sizes: no HEAD needed');
      assert.strictEqual(logic.isSameContent({ ...file('a', OPAQUE), resolvedMd5: MD5_A }, file('a', MD5_A)), true);
      assert.strictEqual(logic.isSameContent({ ...file('a', OPAQUE), resolvedMd5: null }, { ...file('a', OPAQUE), resolvedMd5: null }), false, 'unresolvable');
    });

    it('should consider a multipart object and its plain copy identical on the first synchronisation only, if the multipart version is not newer', function() {
      assert.strictEqual(logic.isSameContent(file('a', MULTIPART, 10, T0), file('a', MD5_A, 10, T0 + 1), true), true);
      assert.strictEqual(logic.isSameContent(file('a', MD5_A, 10, T0 + 1), file('a', MULTIPART, 10, T0), true), true);
      assert.strictEqual(logic.isSameContent(file('a', MULTIPART, 10, T0 + 2), file('a', MD5_A, 10, T0 + 1), true), false, 'multipart uploaded again after the copy');
      assert.strictEqual(logic.isSameContent(file('a', MULTIPART, 10, T0), file('a', MD5_A, 11, T0 + 1), true), false);
      assert.strictEqual(logic.isSameContent(file('a', MULTIPART, null, T0), file('a', MD5_A, null, T0 + 1), true), false, 'unknown size');
    });
  });

  describe("Unidirectional", function() {
    it('should upload the new source objects and record the identical ones on the first synchronisation', function() {
      const _result = sync(UNI, true, {
        source: [file('new', MD5_A), file('same', MD5_B), file('diff', MD5_A)],
        target: [file('same', MD5_B), file('diff', MD5_C)]
      });
      assert.deepStrictEqual(actions(_result), { ...NOTHING, uploadTarget: ['diff', 'new'] });
      assert.deepStrictEqual(Object.entries(entriesOf(_result.files)), [['same', [MD5_B, 10, MD5_B, 10]]]);
      assert.strictEqual(logs.filter('sync_plan')[0].upload_target, 1);
      assert.strictEqual(logs.filter('sync_plan')[0].update_target, 1);
    });

    it('should delete the target objects absent from the source only with "delete"', function() {
      const _input = { source: [file('a', MD5_A)], target: [file('a', MD5_A), file('old', MD5_B)], cache: { a: [MD5_A, 10, MD5_A, 10], old: [MD5_B, 10, MD5_B, 10] } };
      assert.deepStrictEqual(actions(sync(UNI, true, _input)), { ...NOTHING, deleteTarget: ['old'] });
      const _result = sync(UNI, false, _input);
      assert.deepStrictEqual(actions(_result), NOTHING);
      assert.deepStrictEqual(Object.keys(entriesOf(_result.files)), ['a'], 'the entry of a target-only object is useless');
    });

    it('should never upload or delete anything on the source', function() {
      const _result = sync(UNI, true, { source: [file('a', MD5_A), file('b', MD5_B)], target: [file('c', MD5_C), file('b', MD5_C, 10, T0 + 5000)], cache: { c: [MD5_C, 10, MD5_C, 10] } });
      assert.deepStrictEqual(_result.uploadSource, []);
      assert.deepStrictEqual(_result.deleteSource, []);
      assert.deepStrictEqual(_result.uploadTarget, ['a', 'b'], 'the source wins even if the target is newer');
    });

    it('should do nothing in the steady state, without any HEAD even for opaque etags', function() {
      const _result = sync(UNI, true, {
        source: [file('a', MD5_A), file('enc', OPAQUE), file('mp', MULTIPART)],
        target: [file('a', MD5_A), file('enc', MD5_B), file('mp', MD5_C)],
        cache : { a: [MD5_A, 10, MD5_A, 10], enc: [OPAQUE, 10, MD5_B, 10], mp: [MULTIPART, 10, MD5_C, 10] }
      });
      assert.deepStrictEqual(actions(_result), NOTHING);
      assert.strictEqual(logs.filter('sync_plan').length, 0, 'an empty plan is logged at debug level');
    });

    it('should upload a source object changed since the last synchronisation, even if the target is newer', function() {
      const _result = sync(UNI, false, { source: [file('a', MD5_B, 10, T0)], target: [file('a', MD5_A, 10, T0 + 9000)], cache: { a: [MD5_A, 10, MD5_A, 10] } });
      assert.deepStrictEqual(actions(_result), { ...NOTHING, uploadTarget: ['a'] });
    });

    it('should repair a target object edited out-of-band (the source wins)', function() {
      const _result = sync(UNI, false, { source: [file('a', MD5_A)], target: [file('a', MD5_B, 10, T0 + 9000)], cache: { a: [MD5_A, 10, MD5_A, 10] } });
      assert.deepStrictEqual(actions(_result), { ...NOTHING, uploadTarget: ['a'] });
    });

    it('should only record a target object rewritten with the same content', function() {
      const _result = sync(UNI, false, { source: [file('a', MD5_A)], target: [file('a', MD5_A, 10, T0 + 9000)], cache: { a: [MD5_A, 10, MD5_B, 10] } });
      assert.deepStrictEqual(actions(_result), NOTHING);
      assert.deepStrictEqual(entryOf(_result.files, 'a'), [MD5_A, 10, MD5_A, 10]);
    });

    it('should upload an older version restored on the source (plain and multipart)', function() {
      const _result = sync(UNI, true, {
        source: [file('plain', MD5_A, 10, T0 - 9000), file('mp', MULTIPART_OLD, 10, T0 - 9000)],
        target: [file('plain', MD5_B, 10, T0), file('mp', MD5_C, 10, T0)],
        cache : { plain: [MD5_B, 10, MD5_B, 10], mp: [MULTIPART, 10, MD5_C, 10] }
      });
      assert.deepStrictEqual(actions(_result), { ...NOTHING, uploadTarget: ['mp', 'plain'] });
    });

    it('should not upload again the plain copies of multipart source objects on the first synchronisation', function() {
      const _result = sync(UNI, true, {
        source: [file('copied', MULTIPART, 10, T0), file('reuploaded', MULTIPART, 10, T0 + 2)],
        target: [file('copied', MD5_A, 10, T0 + 1), file('reuploaded', MD5_A, 10, T0 + 1)]
      });
      assert.deepStrictEqual(actions(_result), { ...NOTHING, uploadTarget: ['reuploaded'] });
    });

    it('should resolve the opaque etags once with a HEAD, then never again (OVH encrypted source: no re-upload of the copied objects)', function() {
      const _source = [];
      const _target = [];
      for (let i = 0; i < 20; i++) {
        _source.push(file('copy' + i, OPAQUE));
        _target.push(file('copy' + i, MD5_A));
      }
      _source.push(file('resized', OPAQUE, 99));
      _target.push(file('resized', MD5_A, 10));
      const _first = sync(UNI, true, { source: _source, target: _target });
      assert.strictEqual(_first.resolve.length, 20, 'only the objects of the same size are resolved');
      assert.deepStrictEqual(_first.uploadTarget, [], 'nothing is planned before the resolution');
      assert.strictEqual(logs.filter('sync_plan').length, 0);
      /** HEAD: the real MD5 */
      _first.plan.objectsToResolve.forEach(({ object }) => { object.resolvedMd5 = MD5_A; });
      const _second = sync(UNI, true, {}, _first.files);
      assert.deepStrictEqual(actions(_second), { ...NOTHING, uploadTarget: ['resized'] });
      transferAll(_second, MD5_B);
      assert.deepStrictEqual(entryOf(_second.files, 'copy0'), [OPAQUE, 10, MD5_A, 10]);
      /** Next run: same listings, nothing to resolve, nothing to transfer */
      const _next = sync(UNI, true, { source: _source.map((f) => file(f.key, f.md5, f.bytes)), target: _target.map((f) => file(f.key, f.key === 'resized' ? MD5_B : f.md5, f.key === 'resized' ? 99 : f.bytes)), cache: entriesOf(_second.files) });
      assert.deepStrictEqual(actions(_next), NOTHING);
    });

    it('should upload an object whose opaque etag cannot be resolved', function() {
      const _first = sync(UNI, true, { source: [file('a', OPAQUE)], target: [file('a', MD5_A)] });
      assert.deepStrictEqual(_first.resolve, ['source:a']);
      _first.plan.objectsToResolve[0].object.resolvedMd5 = null;
      assert.deepStrictEqual(actions(sync(UNI, true, {}, _first.files)), { ...NOTHING, uploadTarget: ['a'] });
    });

    it('should resolve an opaque etag again only when the object changed', function() {
      const _result = sync(UNI, true, { source: [file('a', MD5_A)], target: [file('a', OPAQUE_2)], cache: { a: [MD5_A, 10, OPAQUE, 10] } });
      assert.deepStrictEqual(_result.resolve, ['target:a']);
    });
  });

  describe("Bidirectional", function() {
    it('should copy the objects present on one side only, and record the identical ones, on the first synchronisation (never delete)', function() {
      const _result = sync(BI, true, {
        source: [file('s', MD5_A), file('same', MD5_B)],
        target: [file('t', MD5_C), file('same', MD5_B)]
      });
      assert.deepStrictEqual(actions(_result), { ...NOTHING, uploadTarget: ['s'], uploadSource: ['t'] });
      assert.deepStrictEqual(entryOf(_result.files, 'same'), [MD5_B, 10, MD5_B, 10]);
      assert.strictEqual(logs.filter('sync_conflict').length, 0);
    });

    it('should keep the most recent version (ms) of an object different on both sides without cache, and log a "sync_conflict"', function() {
      const _result = sync(BI, true, {
        source: [file('newer-target', MD5_A, 10, T0), file('newer-source', MD5_A, 10, T0 + 1), file('tie', MD5_A, 10, T0)],
        target: [file('newer-target', MD5_B, 10, T0 + 400), file('newer-source', MD5_B, 10, T0), file('tie', MD5_B, 10, T0)]
      });
      assert.deepStrictEqual(actions(_result), { ...NOTHING, uploadTarget: ['newer-source', 'tie'], uploadSource: ['newer-target'] });
      const _conflicts = logs.filter('sync_conflict');
      assert.strictEqual(_conflicts.length, 3);
      assert.deepStrictEqual(_conflicts[0], {
        ..._conflicts[0], level: 'warn', key: 'newer-target', reason: 'both_new', winner: 'target',
        source_etag: MD5_A, source_bytes: 10, source_lastmodified: new Date(T0).toISOString(),
        target_etag: MD5_B, target_bytes: 10, target_lastmodified: new Date(T0 + 400).toISOString()
      });
      assert.strictEqual(logs.filter('sync_plan')[0].conflicts, 3);
    });

    it('should do nothing when no side changed', function() {
      const _result = sync(BI, true, { source: [file('a', MD5_A, 10, T0)], target: [file('a', MD5_B, 10, T0 + 5000)], cache: { a: [MD5_A, 10, MD5_B, 10] } });
      assert.deepStrictEqual(actions(_result), NOTHING);
    });

    it('should propagate the side that changed, never "the copy is newer" (source modified during the copy)', function() {
      /** The previous run copied v1 to the target; the source was modified during the copy: v2 is older than the copy */
      const _result = sync(BI, true, { source: [file('a', MD5_B, 10, T0)], target: [file('a', MD5_A, 10, T0 + 1000)], cache: { a: [MD5_A, 10, MD5_A, 10] } });
      assert.deepStrictEqual(actions(_result), { ...NOTHING, uploadTarget: ['a'] });
      assert.strictEqual(logs.filter('sync_conflict').length, 0);
    });

    it('should propagate a target modification to the source', function() {
      const _result = sync(BI, true, { source: [file('a', MD5_A, 10, T0 + 1000)], target: [file('a', MD5_B, 10, T0)], cache: { a: [MD5_A, 10, MD5_A, 10] } });
      assert.deepStrictEqual(actions(_result), { ...NOTHING, uploadSource: ['a'] });
    });

    it('should propagate an older version restored on one side', function() {
      const _result = sync(BI, true, {
        source: [file('plain', MD5_C, 10, T0 - 9000), file('mp', MULTIPART_OLD, 10, T0 - 9000)],
        target: [file('plain', MD5_A, 10, T0), file('mp', MD5_B, 10, T0)],
        cache : { plain: [MD5_A, 10, MD5_A, 10], mp: [MULTIPART, 10, MD5_B, 10] }
      });
      assert.deepStrictEqual(actions(_result), { ...NOTHING, uploadTarget: ['mp', 'plain'] });
    });

    it('should propagate a deletion with "delete", and copy the object back without', function() {
      const _input = () => ({ source: [file('t-deleted', MD5_A)], target: [file('s-deleted', MD5_B)], cache: { 's-deleted': [MD5_B, 10, MD5_B, 10], 't-deleted': [MD5_A, 10, MD5_A, 10] } });
      assert.deepStrictEqual(actions(sync(BI, true, _input())), { ...NOTHING, deleteTarget: ['s-deleted'], deleteSource: ['t-deleted'] });
      assert.deepStrictEqual(actions(sync(BI, false, _input())), { ...NOTHING, uploadSource: ['s-deleted'], uploadTarget: ['t-deleted'] });
    });

    it('should drop the entry of an object deleted on both sides', function() {
      const _result = sync(BI, true, { source: [file('a', MD5_A)], target: [file('a', MD5_A)], cache: { a: [MD5_A, 10, MD5_A, 10], gone: [MD5_B, 10, MD5_B, 10] } });
      assert.deepStrictEqual(actions(_result), NOTHING);
      assert.deepStrictEqual(Object.keys(entriesOf(_result.files)), ['a']);
    });

    it('should never delete a modified object: deleted on one side, modified on the other one, it is copied back ("sync_conflict")', function() {
      const _result = sync(BI, true, {
        source: [file('t-deleted', MD5_C, 10, T0 - 5000)],
        target: [file('s-deleted', MD5_C, 10, T0 - 5000)],
        cache : { 's-deleted': [MD5_B, 10, MD5_B, 10], 't-deleted': [MD5_A, 10, MD5_A, 10] }
      });
      assert.deepStrictEqual(actions(_result), { ...NOTHING, uploadSource: ['s-deleted'], uploadTarget: ['t-deleted'] });
      const _conflicts = logs.filter('sync_conflict');
      assert.deepStrictEqual(_conflicts.map((c) => [c.key, c.reason, c.winner, c.source_etag, c.target_etag]), [
        ['t-deleted', 'deleted_modified', 'source', MD5_C, 'deleted'],
        ['s-deleted', 'deleted_modified', 'target', 'deleted', MD5_C]
      ]);
    });

    it('should record an object modified identically on both sides, and keep the most recent one otherwise ("sync_conflict")', function() {
      const _result = sync(BI, true, {
        source: [file('same', MD5_C, 10, T0), file('diff', MD5_B, 10, T0 + 300)],
        target: [file('same', MD5_C, 10, T0 + 9), file('diff', MD5_C, 10, T0 + 700)],
        cache : { same: [MD5_A, 10, MD5_A, 10], diff: [MD5_A, 10, MD5_A, 10] }
      });
      assert.deepStrictEqual(actions(_result), { ...NOTHING, uploadSource: ['diff'] }, 'same second, the target is 400 ms newer');
      assert.deepStrictEqual(entryOf(_result.files, 'same'), [MD5_C, 10, MD5_C, 10]);
      assert.deepStrictEqual(logs.filter('sync_conflict').map((c) => [c.key, c.reason, c.winner]), [['diff', 'both_modified', 'target']]);
    });

    it('should not push back the plain copy of a multipart object (steady state)', function() {
      const _result = sync(BI, true, { source: [file('a', MULTIPART, 10, T0)], target: [file('a', MD5_A, 10, T0 + 1)], cache: { a: [MULTIPART, 10, MD5_A, 10] } });
      assert.deepStrictEqual(actions(_result), NOTHING);
    });

    it('should settle a migrated v1 cache with at most one redundant upload, never a deletion', function() {
      /** v1 entries: both sides get the md5 of the v1 cache (the md5 of the copy for a multipart source) */
      const _result = sync(BI, true, {
        source: [file('same', MD5_A), file('mp', MULTIPART, 10, T0)],
        target: [file('same', MD5_A), file('mp', MD5_B, 10, T0 + 1)],
        cache : { same: [MD5_A, 10, MD5_A, 10], mp: [MD5_B, 10, MD5_B, 10] }
      });
      assert.deepStrictEqual(actions(_result), { ...NOTHING, uploadTarget: ['mp'] });
      transferAll(_result, MD5_B);
      const _next = sync(BI, true, { source: [file('same', MD5_A), file('mp', MULTIPART, 10, T0)], target: [file('same', MD5_A), file('mp', MD5_B, 10, T0 + 99)], cache: entriesOf(_result.files) });
      assert.deepStrictEqual(actions(_next), NOTHING);
    });

    it('should not transfer an object whose etag became opaque (OVH server-side copy): resolved once with a HEAD', function() {
      const _first = sync(BI, true, { source: [file('a', MD5_A, 10, T0)], target: [file('a', OPAQUE, 10, T0 + 5000)], cache: { a: [MD5_A, 10, MD5_A, 10] } });
      assert.deepStrictEqual(_first.resolve, ['target:a']);
      _first.plan.objectsToResolve[0].object.resolvedMd5 = MD5_A;
      const _second = sync(BI, true, {}, _first.files);
      assert.deepStrictEqual(actions(_second), NOTHING);
      assert.deepStrictEqual(entryOf(_second.files, 'a'), [MD5_A, 10, OPAQUE, 10]);
      const _next = sync(BI, true, { source: [file('a', MD5_A)], target: [file('a', OPAQUE)], cache: entriesOf(_second.files) });
      assert.deepStrictEqual(actions(_next), NOTHING);
    });

    it('should log at most 100 "sync_conflict" lines, the total is in "sync_plan"', function() {
      const _keys = Array.from({ length: 120 }, (_, i) => 'k' + i);
      sync(BI, false, { source: _keys.map((k) => file(k, MD5_A)), target: _keys.map((k) => file(k, MD5_B)) });
      assert.strictEqual(logs.filter('sync_conflict').length, 100);
      assert.strictEqual(logs.filter('sync_plan')[0].conflicts, 120);
    });
  });

  describe("updateCache", function() {
    it('should record the listed token of the origin and the PUT etag of the destination after a copy', function() {
      const _result = sync(BI, true, { source: [file('s', MULTIPART, 10)], target: [file('t', OPAQUE, 20)] });
      transferAll(_result, MD5_C);
      assert.deepStrictEqual(entryOf(_result.files, 's'), [MULTIPART, 10, MD5_C, 10]);
      assert.deepStrictEqual(entryOf(_result.files, 't'), [MD5_C, 20, OPAQUE, 20]);
    });

    it('should not record the origin token of an object rewritten during the copy: it is synchronised again by the next run', function() {
      const _result = sync(UNI, true, { source: [file('a', MD5_A)], target: [] });
      _result.plan.objectsToUploadTarget[0].copied = { etag: MD5_B, bytes: 10, sourceChanged: true };
      logic.updateCache(_result.files, _result.plan);
      assert.deepStrictEqual(entryOf(_result.files, 'a'), [null, 10, MD5_B, 10]);
      const _next = sync(UNI, true, { source: [file('a', MD5_B)], target: [file('a', MD5_B)], cache: entriesOf(_result.files) });
      assert.deepStrictEqual(actions(_next), NOTHING, 'identical: recorded without transfer');
      assert.deepStrictEqual(entryOf(_next.files, 'a'), [MD5_B, 10, MD5_B, 10]);
    });

    it('should keep the previous entry of a failed operation, and remove the entry of a deleted object', function() {
      const _cache = { up: [MD5_A, 10, MD5_A, 10], del: [MD5_B, 10, MD5_B, 10], failedDel: [MD5_C, 10, MD5_C, 10] };
      const _result = sync(UNI, true, { source: [file('up', MD5_B)], target: [file('up', MD5_A), file('del', MD5_B), file('failedDel', MD5_C)], cache: _cache });
      assert.deepStrictEqual(actions(_result), { ...NOTHING, uploadTarget: ['up'], deleteTarget: ['del', 'failedDel'] });
      _result.plan.objectsToDeleteTarget.find((f) => f.key === 'del').deleted = true;
      logic.updateCache(_result.files, _result.plan);
      /** The token of a side absent from the listing is never used: not kept */
      assert.deepStrictEqual(entriesOf(_result.files), { up: [MD5_A, 10, MD5_A, 10], failedDel: [null, null, MD5_C, 10] });
    });

    it('should not delete again a re-created key after a failed run that executed deletions', function() {
      /** Run 1: the deletion of "a" succeeds, another operation fails */
      const _run1 = sync(BI, true, { source: [file('b', MD5_B)], target: [file('a', MD5_A)], cache: { a: [MD5_A, 10, MD5_A, 10] } });
      assert.deepStrictEqual(actions(_run1), { ...NOTHING, deleteTarget: ['a'], uploadTarget: ['b'] });
      _run1.plan.objectsToDeleteTarget[0].deleted = true;
      logic.updateCache(_run1.files, _run1.plan);
      /** Run 2: "a" is created again on the source */
      const _run2 = sync(BI, true, { source: [file('a', MD5_C), file('b', MD5_B)], target: [], cache: entriesOf(_run1.files) });
      assert.deepStrictEqual(actions(_run2), { ...NOTHING, uploadTarget: ['a', 'b'] });
    });
  });
});

describe("helper cache", function() {
  const _dir = path.join(os.tmpdir(), `sclone-cache-test-${process.pid}`);
  const _cachePath = path.join(_dir, 'test.cache.json');
  const _config = {
    mode  : BI,
    source: { name: 's3', url: 's3.gra.test', region: 'gra', bucket: 'invoices', accessKeyId: 'key-id', secretAccessKey: 'secret' },
    target: { name: 'swift', authUrl: 'https://auth.test/v3', region: 'SBG', bucket: 'invoices', username: 'user', tenantName: 'project', password: 'secret' }
  };
  const _sha = (text) => require('crypto').createHash('sha256').update(text).digest('hex').slice(0, 12);
  const _header = helper.cacheHeader(_config);
  let logs = null;

  beforeEach(function() {
    fs.rmSync(_dir, { recursive: true, force: true });
    fs.mkdirSync(_dir, { recursive: true });
    logs = captureLogs();
  });

  afterEach(function() {
    logs.restore();
    fs.rmSync(_dir, { recursive: true, force: true });
  });

  it('should identify the pair of storages and their accounts, without credentials', function() {
    assert.deepStrictEqual(_header, { version: 2, mode: BI, source: `s3:s3.gra.test:gra/invoices@${_sha('key-id')}`, target: `swift:auth.test/v3:SBG/invoices@${_sha('user\nproject')}` });
    assert.strictEqual(JSON.stringify(_header).includes('secret'), false);
    assert.strictEqual(JSON.stringify(_header).includes('key-id'), false);
    /** The same bucket of another account is another storage. Never the secret: a new secret key keeps the cache */
    assert.notStrictEqual(helper.cacheHeader({ ..._config, source: { ..._config.source, accessKeyId: 'other-key-id' } }).source, _header.source);
    assert.notStrictEqual(helper.cacheHeader({ ..._config, target: { ..._config.target, tenantName: 'other-project' } }).target, _header.target);
    assert.notStrictEqual(helper.cacheHeader({ ..._config, target: { ..._config.target, username: 'other-user' } }).target, _header.target);
    assert.strictEqual(helper.cacheHeader({ ..._config, source: { ..._config.source, secretAccessKey: 'new-secret' } }).source, _header.source);
    assert.strictEqual(helper.defaultCacheFilename({ ..._config, source: { ..._config.source, accessKeyId: 'other-key-id' } }) !== helper.defaultCacheFilename(_config), true);
    /** The S3 client adds the protocol on connection: same identity */
    assert.strictEqual(helper.cacheHeader({ ..._config, source: { ..._config.source, url: 'https://s3.gra.test/' } }).source, _header.source);
    assert.notStrictEqual(helper.cacheHeader({ ..._config, source: { ..._config.source, url: 'http://s3.gra.test' } }).source, _header.source);
  });

  it('should derive a distinct default cache file name for each pair', function() {
    const _name = helper.defaultCacheFilename(_config);
    assert.match(_name, /^sclone-bidirectional-[0-9a-f]{12}\.cache\.json$/);
    assert.strictEqual(helper.defaultCacheFilename({ ..._config }), _name);
    assert.notStrictEqual(helper.defaultCacheFilename({ ..._config, target: { ..._config.target, bucket: 'other' } }), _name);
    assert.notStrictEqual(helper.defaultCacheFilename({ ..._config, mode: UNI }), _name);
  });

  /** Listings holding the given keys on both sides: the loaded cache keeps the listed keys only */
  const listed = (keys) => ({ source: new Map(keys.map((k) => [k, file(k, MD5_A)])), target: new Map(keys.map((k) => [k, file(k, MD5_B)])) });
  const line = (...items) => JSON.stringify(items) + '\n';

  it('should save the cache atomically (one line per object) and load it back', function(done) {
    const _cache = { a: [MD5_A, 10, MD5_A, 10], 'b"\n': [null, 3, OPAQUE, 3], __proto__: [MD5_B, 1, MD5_B, 1] };
    const _files = listed(['a', 'b"\n', '__proto__']);
    _files.target.set('t-only', file('t-only', MD5_C));
    _files.source.set('no-cache', file('no-cache', MD5_C));
    for (const key of ['a', 'b"\n', '__proto__']) {
      helper.setCacheEntry(_files, key, ..._cache[key]);
    }
    helper.setCacheEntry(_files, 't-only', null, null, MD5_C, 10);
    helper.saveCache(_cachePath, _header, _files, function(err, entries) {
      assert.strictEqual(err, undefined);
      assert.strictEqual(entries, 4);
      assert.deepStrictEqual(fs.readdirSync(_dir), ['test.cache.json'], 'no temporary file left');
      assert.strictEqual(fs.readFileSync(_cachePath, 'utf8'), JSON.stringify(_header) + '\n' + line('a', MD5_A, 10, MD5_A, 10) + line('b"\n', null, 3, OPAQUE, 3) + line('__proto__', MD5_B, 1, MD5_B, 1) + line('t-only', null, null, MD5_C, 10));
      const _loaded = listed(['a', 'b"\n', '__proto__', 'no-cache']);
      _loaded.target.set('t-only', file('t-only', MD5_C));
      helper.loadCache(_cachePath, _header, _loaded, function(warning, migrated, entries) {
        assert.strictEqual(warning, undefined);
        assert.strictEqual(migrated, false);
        assert.strictEqual(entries, 4);
        assert.deepStrictEqual(entriesOf(_loaded), entriesOf(_files));
        done();
      });
    });
  });

  it('should save and load a cache of several chunks (multi-byte keys across the chunks), keeping only the listed keys', function(done) {
    const _key = (i) => `clé-${i}-` + 'é'.repeat(40);
    const _files = { source: new Map(), target: new Map() };
    for (let i = 0; i < 20000; i++) {
      _files.source.set(_key(i), { ...file(_key(i), MD5_A, i), cachedEtag: MD5_A, cachedBytes: i });
      _files.target.set(_key(i), { ...file(_key(i), MD5_B, i), cachedEtag: MD5_B, cachedBytes: i });
    }
    helper.saveCache(_cachePath, _header, _files, function(err, entries) {
      assert.strictEqual(err, undefined);
      assert.strictEqual(entries, 20000);
      assert.strictEqual(fs.statSync(_cachePath).size > 3 * 1024 * 1024, true, 'several chunks of 1 MB');
      const _loaded = { source: new Map(), target: new Map() };
      for (let i = 0; i < 20000; i++) {
        (i % 2 === 0 ? _loaded.source : _loaded.target).set(_key(i), file(_key(i), MD5_C, i));
      }
      helper.loadCache(_cachePath, _header, _loaded, function(warning, migrated, entries) {
        assert.strictEqual(warning, undefined);
        assert.strictEqual(entries, 20000);
        const _entries = entriesOf(_loaded);
        assert.deepStrictEqual(_entries[_key(0)], [MD5_A, 0, null, null]);
        assert.deepStrictEqual(_entries[_key(19999)], [null, null, MD5_B, 19999]);
        assert.strictEqual(Object.keys(_entries).length, 20000);
        done();
      });
    });
  });

  it('should ignore an empty cache file', function(done) {
    fs.writeFileSync(_cachePath, '');
    const _files = listed(['a']);
    helper.loadCache(_cachePath, _header, _files, function(warning) {
      assert.strictEqual(typeof warning, 'string');
      done();
    });
  });

  it('should keep the previous cache if it cannot be written', function(done) {
    fs.writeFileSync(_cachePath, 'previous');
    const _rename = fs.rename;
    fs.rename = (from, to, callback) => callback(new Error('EIO'));
    const _files = listed(['a']);
    helper.setCacheEntry(_files, 'a', MD5_A, 1, MD5_A, 1);
    helper.saveCache(_cachePath, _header, _files, function(err) {
      fs.rename = _rename;
      assert.strictEqual(err, 'Save cache error | Error: EIO');
      assert.strictEqual(fs.readFileSync(_cachePath, 'utf8'), 'previous');
      assert.deepStrictEqual(fs.readdirSync(_dir), ['test.cache.json'], 'temporary file removed');
      done();
    });
  });

  it('should start without cache if the file does not exist', function(done) {
    const _files = listed(['a']);
    helper.loadCache(_cachePath, _header, _files, function(warning) {
      assert.strictEqual(warning, undefined);
      assert.deepStrictEqual(entriesOf(_files), {});
      done();
    });
  });

  for (const [_name, _content] of [
    ['corrupted', '{"version":2,'],
    ['truncated', JSON.stringify(_header) + '\n' + line('a', MD5_A, 1, MD5_A, 1) + '["b"'],
    ['with a corrupted line', JSON.stringify(_header) + '\n' + line('a', MD5_A, 1, MD5_A, 1) + '["b",\n'],
    ['written for another pair', JSON.stringify({ ..._header, target: 'swift:auth.test/v3:SBG/other' }) + '\n' + line('a', MD5_A, 1, MD5_A, 1)],
    ['written for another mode', JSON.stringify({ ..._header, mode: UNI }) + '\n' + line('a', MD5_A, 1, MD5_A, 1)],
    ['of an unknown version', JSON.stringify({ ..._header, version: 3 }) + '\n' + line('a', MD5_A, 1, MD5_A, 1)],
    ['with an invalid entry', JSON.stringify(_header) + '\n' + line('a', MD5_A, 1, MD5_A, 1) + line('b', MD5_A, '1', MD5_A, 1)],
    ['with an entry of another length', JSON.stringify(_header) + '\n' + line('a', MD5_A, 1, MD5_A, 1) + line('b', MD5_A, 1)]
  ]) {
    it(`should ignore the whole cache ${_name} (first synchronisation, nothing deleted)`, function(done) {
      fs.writeFileSync(_cachePath, _content);
      const _files = listed(['a', 'b']);
      helper.loadCache(_cachePath, _header, _files, function(warning) {
        assert.strictEqual(typeof warning, 'string');
        assert.deepStrictEqual(entriesOf(_files), {}, 'the entries loaded before the error are removed');
        done();
      });
    });
  }

  it('should migrate a v1 bidirectional cache for the keys listed on one side only: both sides get the cached md5', function(done) {
    fs.writeFileSync(_cachePath, JSON.stringify([['a', { key: 'a', md5: MD5_A, lastmodified: T0, bytes: 10 }], ['b', { key: 'b', md5: MULTIPART, lastmodified: T0 }], ['gone', { key: 'gone', md5: MD5_C, bytes: 1 }], ['both', { key: 'both', md5: MD5_A, bytes: 10 }]]));
    const _files = listed(['both']);
    _files.source.set('a', file('a', MD5_A));
    _files.target.set('b', file('b', MULTIPART));
    helper.loadCache(_cachePath, _header, _files, function(warning, migrated) {
      assert.strictEqual(warning, undefined);
      assert.strictEqual(migrated, true);
      /** "both" is listed on both sides: compared as on a first synchronisation */
      assert.deepStrictEqual(entriesOf(_files), { a: [MD5_A, 10, null, null], b: [null, null, MULTIPART, null] });
      const _uni = listed(['a', 'b']);
      helper.loadCache(_cachePath, { ..._header, mode: UNI }, _uni, function(warning) {
        assert.strictEqual(typeof warning, 'string', 'a v1 cache was written by the bidirectional mode');
        assert.deepStrictEqual(entriesOf(_uni), {});
        done();
      });
    });
  });

  it('should not upload a plain copy back over its multipart original after a v1 migration (the v1 token is the multipart etag)', function(done) {
    /** sclone 1.3 copied a multipart source to the target and cached the source object (multipart etag) */
    fs.writeFileSync(_cachePath, JSON.stringify([['k', { key: 'k', md5: MULTIPART, lastmodified: T0, bytes: 10 }]]));
    const _files = { source: new Map([['k', file('k', MULTIPART, 10, T0)]]), target: new Map([['k', file('k', MD5_A, 10, T0 + 1000)]]) };
    helper.loadCache(_cachePath, _header, _files, function(warning, migrated) {
      assert.strictEqual(warning, undefined);
      assert.strictEqual(migrated, true);
      const _run = sync(BI, true, {}, _files);
      assert.deepStrictEqual([_run.uploadSource, _run.uploadTarget, _run.deleteSource, _run.deleteTarget], [[], [], [], []]);
      assert.deepStrictEqual(entryOf(_files, 'k'), [MULTIPART, 10, MD5_A, 10], 'recorded as identical');
      done();
    });
  });

  it('should remove the temporary cache files older than an hour left by a crash, and keep the others', function(done) {
    const _old = new Date(Date.now() - 2 * 3600000);
    for (const name of ['test.cache.json.123.tmp', 'test.cache.json.456.tmp', 'other.cache.json.789.tmp']) {
      fs.writeFileSync(path.join(_dir, name), 'x');
      fs.utimesSync(path.join(_dir, name), _old, _old);
    }
    fs.writeFileSync(path.join(_dir, 'test.cache.json.999.tmp'), 'recent');
    helper.loadCache(_cachePath, _header, listed([]), function() {
      setTimeout(() => {
        assert.deepStrictEqual(fs.readdirSync(_dir).sort(), ['other.cache.json.789.tmp', 'test.cache.json.999.tmp']);
        done();
      }, 100);
    });
  });

  describe("lock", function() {
    const _lockPath = path.join(_dir, 'test.cache.json.lock');

    const _old = () => new Date(Date.now() - 11 * 60000);
    const _ago = (ms) => new Date(Date.now() - ms);

    it('should create the lock exclusively and release it', function() {
      const _release = helper.acquireLock(_lockPath);
      const _lock = JSON.parse(fs.readFileSync(_lockPath, 'utf8'));
      assert.strictEqual(_lock.pid, process.pid);
      assert.strictEqual(_lock.hostname, os.hostname());
      assert.strictEqual(typeof _lock.start, 'number');
      assert.throws(() => helper.acquireLock(_lockPath), (err) => err.code === 'locked', 'held by this process');
      _release();
      assert.strictEqual(fs.existsSync(_lockPath), false);
    });

    it('should refresh the lock every 30 seconds while it is held', function() {
      const _clock = require('sinon').useFakeTimers({ now: Date.now(), toFake: ['setInterval', 'clearInterval', 'Date'] });
      try {
        const _release = helper.acquireLock(_lockPath);
        fs.utimesSync(_lockPath, _old(), _old());
        _clock.tick(30000);
        assert.strictEqual(Date.now() - fs.statSync(_lockPath).mtimeMs < 1000, true, 'refreshed');
        _release();
      } finally {
        _clock.restore();
      }
    });

    it('should take over the lock of another host not refreshed for 10 minutes, and refuse it while refreshed', function() {
      fs.writeFileSync(_lockPath, JSON.stringify({ pid: 1, hostname: 'other-host', start: T0 }));
      assert.throws(() => helper.acquireLock(_lockPath), (err) => err.code === 'locked' && err.message.includes('host: other-host'));
      fs.utimesSync(_lockPath, _old(), _old());
      const _release = helper.acquireLock(_lockPath);
      assert.strictEqual(JSON.parse(fs.readFileSync(_lockPath, 'utf8')).pid, process.pid);
      assert.deepStrictEqual(logs.filter('lock_stale').map((l) => [l.pid, l.hostname]), [[1, 'other-host']]);
      _release();
    });

    it('should take over a lock of this host with our pid written before this process started (PID 1 in a container)', function() {
      fs.writeFileSync(_lockPath, JSON.stringify({ pid: process.pid, hostname: os.hostname(), start: Date.now() - process.uptime() * 1000 - 5000 }));
      const _release = helper.acquireLock(_lockPath);
      assert.strictEqual(logs.filter('lock_stale').length, 1);
      _release();
    });

    it('should never remove a lock taken over by another process between its reading and its removal', function() {
      fs.writeFileSync(_lockPath, JSON.stringify({ pid: 2 ** 22 + 12345, start: T0 }));
      fs.utimesSync(_lockPath, _ago(91000), _ago(91000));
      const _fresh = JSON.stringify({ pid: 1, hostname: 'other-host', start: Date.now() });
      const _rename = fs.renameSync;
      fs.renameSync = (from, to) => {
        fs.renameSync = _rename;
        /** Another process removed the stale lock and created its own */
        fs.rmSync(_lockPath);
        fs.writeFileSync(_lockPath, _fresh);
        return _rename(from, to);
      };
      try {
        assert.throws(() => helper.acquireLock(_lockPath), (err) => err.code === 'locked' && err.holder.hostname === 'other-host');
      } finally {
        fs.renameSync = _rename;
      }
      assert.strictEqual(fs.readFileSync(_lockPath, 'utf8'), _fresh, 'the lock of the other process is put back');
      assert.deepStrictEqual(fs.readdirSync(_dir), ['test.cache.json.lock'], 'no file left');
    });

    it('should derive the lock from the pair of storages only: every configuration of the same pair excludes the others', function() {
      const _lock = helper.lockPath({ ..._config, cacheFilename: _cachePath });
      assert.match(path.basename(_lock), /^sclone-[0-9a-f]{12}\.lock$/);
      assert.strictEqual(path.dirname(_lock), _dir, 'next to the cache');
      assert.strictEqual(helper.lockPath({ ..._config, mode: UNI, cacheFilename: path.join(_dir, 'other.cache.json') }), _lock);
      assert.strictEqual(helper.lockPath({ ..._config, source: _config.target, target: _config.source, cacheFilename: _cachePath }), _lock, 'swapped');
      assert.notStrictEqual(helper.lockPath({ ..._config, target: { ..._config.target, bucket: 'other' }, cacheFilename: _cachePath }), _lock);
    });

    it('should refuse a lock held by another living process', function() {
      fs.writeFileSync(_lockPath, JSON.stringify({ pid: process.ppid, start: T0 }));
      assert.throws(() => helper.acquireLock(_lockPath), (err) => err.code === 'locked' && err.holder.pid === process.ppid && err.message.includes(`pid: ${process.ppid}`));
      assert.strictEqual(JSON.parse(fs.readFileSync(_lockPath, 'utf8')).pid, process.ppid, 'the lock is not modified');
    });

    it('should refuse a lock being written (unreadable and recent)', function() {
      fs.writeFileSync(_lockPath, '');
      assert.throws(() => helper.acquireLock(_lockPath), (err) => err.code === 'locked');
    });

    it('should take over the lock of a stopped process, once not refreshed for 3 refreshes (90 s)', function() {
      fs.writeFileSync(_lockPath, JSON.stringify({ pid: 2 ** 22 + 12345, start: T0 }));
      fs.utimesSync(_lockPath, _ago(91000), _ago(91000));
      const _release = helper.acquireLock(_lockPath);
      assert.strictEqual(JSON.parse(fs.readFileSync(_lockPath, 'utf8')).pid, process.pid);
      assert.deepStrictEqual(logs.filter('lock_stale').map((l) => [l.level, l.pid]), [['warn', 2 ** 22 + 12345]]);
      _release();
    });

    it('should refuse a recent lock of this host whose pid cannot be checked (another PID namespace with the same hostname)', function() {
      fs.writeFileSync(_lockPath, JSON.stringify({ pid: 2 ** 22 + 12345, hostname: os.hostname(), start: T0 }));
      fs.utimesSync(_lockPath, _ago(80000), _ago(80000));
      assert.throws(() => helper.acquireLock(_lockPath), (err) => err.code === 'locked');
    });

    it('should tell when the lock is no longer held (taken over by another process after a race)', function() {
      const _release = helper.acquireLock(_lockPath);
      assert.strictEqual(_release.isHeld(), true);
      fs.writeFileSync(_lockPath, JSON.stringify({ pid: process.ppid, start: T0 }));
      assert.strictEqual(_release.isHeld(), false);
      _release();
    });

    it('should not remove a lock taken over by another process', function() {
      const _release = helper.acquireLock(_lockPath);
      fs.writeFileSync(_lockPath, JSON.stringify({ pid: process.ppid, start: T0 }));
      _release();
      assert.strictEqual(fs.existsSync(_lockPath), true);
    });
  });
});

beforeEach(function(done) {
  /** The logs folder is gitignored: it does not exist on a fresh clone (CI) */
  fs.mkdirSync(path.join(__dirname, '..', 'logs'), { recursive: true });
  const _files = fs.readdirSync(path.join(__dirname, '..', 'logs'));
  for (let i = 0; i < _files.length; i++) {
    if (_files[i].includes('.json') === true) {
      fs.rmSync(path.join(__dirname, '..', 'logs', _files[i]));
    }
  }
  done();
});

describe('syncLogGenerate', function() {
  it('should generate a sync log', function() {
    logic.syncLogGenerate({ test: true });
    const _files = fs.readdirSync(path.join(__dirname, '..', 'logs'));
    for (let i = 0; i < _files.length; i++) {
      if (_files[i].startsWith('sync-') === true) {
        const _file = fs.readFileSync(path.join(__dirname, '..', 'logs', _files[i]));
        assert.strictEqual(_file.toString(), '{"test":true}');
        fs.rmSync(path.join(__dirname, '..', 'logs', _files[i]));
      }
    }

  });
});

describe('syncLogClean', function() {
  this.timeout(30000);
  it('should clean old logs', function (done) {
    logic.syncLogGenerate({ test1: true });
    setTimeout(function() {
      logic.syncLogGenerate({ test2: true });
      logic.syncLogClean(500);
      setTimeout(function() {
      const _files = fs.readdirSync(path.join(__dirname, '..', 'logs'));
      assert.strictEqual(_files.length, 1);
      const _file = fs.readFileSync(path.join(__dirname, '..', 'logs', _files[0]));
      assert.strictEqual(_file.toString(), '{"test2":true}');
      fs.rmSync(path.join(__dirname, '..', 'logs', _files[0]));
      done();
      }, 1000);
    }, 1000);
  });
});
describe("helper.loadConfig", function() {
  const _configPath = path.join(require('os').tmpdir(), `sclone-invalid-config-${process.pid}.json`);

  afterEach(function() {
    fs.rmSync(_configPath, { force: true });
  });

  it('should never quote the content of an invalid config.json: it can contain credentials', function(done) {
    fs.writeFileSync(_configPath, '{\n  "source": {\n    "secretAccessKey": "s3cr3t" "bucket": "invoices"\n  }\n}');
    helper.loadConfig(_configPath, function(err) {
      assert.strictEqual(err instanceof Error, true);
      assert.strictEqual(err.message.includes('s3cr3t'), false, err.message);
      assert.strictEqual(err.message.includes('secretAccessKey'), false, err.message);
      assert.strictEqual(err.message, `config.json is not valid JSON | ${_configPath} | SyntaxError at line 3 column 33`);
      done();
    });
  });

  it('should never quote the content of an invalid config.json without position', function(done) {
    fs.writeFileSync(_configPath, '{"secretAccessKey": s3cr3t}');
    helper.loadConfig(_configPath, function(err) {
      assert.strictEqual(err.message.startsWith(`config.json is not valid JSON | ${_configPath} | SyntaxError`), true, err.message);
      assert.strictEqual(/s3cr3t|secretAccessKey/.test(err.message), false, err.message);
      done();
    });
  });
});
