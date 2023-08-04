const assert = require('assert');
const logic = require('../logic');
const fs = require('fs');
const path = require('path')
const helper = require('../helper')

const files = {
  target        : new Map(),
  source        : new Map(),
  cache         : new Map()
}

describe("logic", function() {

  beforeEach(function(done) {
    files.target = new Map()
    files.source = new Map()
    files.cache = new Map()
    return done();
  })

  describe("Unidirectional sync", function() {
    it('should upload source objects to the target storage without cache (fist sync) (delete:true)', function() {
      for (let i = 0; i < 10; i++) {
        files.source.set('file' + i, { id : i, key: i+ "-value.txt" } )
      }
      let { objectsToDeleteTarget, objectsToUploadTarget, objectsToUploadSource, objectsToDeleteSource } = logic.computeSync(files, helper.MODES.UNI, true);
      assert.strictEqual(objectsToDeleteTarget.length, 0);
      assert.strictEqual(objectsToUploadTarget.length, 10);
      assert.strictEqual(objectsToUploadSource.length, 0);
      assert.strictEqual(objectsToDeleteSource.length, 0);
      assert.strictEqual(files.source.size, 10);
      assert.strictEqual(files.target.size, 10);
      assert.strictEqual(files.cache.size, 10);
      /** Verify values */
      assert.strictEqual(objectsToUploadTarget[0]?.id, 0);
      assert.strictEqual(objectsToUploadTarget[objectsToUploadTarget.length - 1]?.id, 9);
    })
    it('should upload source objects to the target storage without cache (first sync) (delete:false)', function() {
      for (let i = 0; i < 10; i++) {
        files.source.set('file' + i, { id : i, key: i+ "-value.txt" } )
      }
      let { objectsToDeleteTarget, objectsToUploadTarget, objectsToUploadSource, objectsToDeleteSource } = logic.computeSync(files, helper.MODES.UNI, false);
      assert.strictEqual(objectsToDeleteTarget.length, 0);
      assert.strictEqual(objectsToUploadTarget.length, 10);
      assert.strictEqual(objectsToUploadSource.length, 0);
      assert.strictEqual(objectsToDeleteSource.length, 0);
      assert.strictEqual(files.source.size, 10);
      assert.strictEqual(files.target.size, 10);
      assert.strictEqual(files.cache.size, 10);
      /** Verify values */
      assert.strictEqual(objectsToUploadTarget[0]?.id, 0);
      assert.strictEqual(objectsToUploadTarget[objectsToUploadTarget.length - 1]?.id, 9);
    })
    it('should update a source object into the target storage (delete:true)', function() {
      files.source.set('file1', { md5: "111fewfweoijfoiwej", key: "file.txt", lastmodified: 1685107819 } ) // newest version// newest version
      files.target.set('file1', { md5: "222ewjfoiewjfoiwej", key: "file.txt", lastmodified: 1685107765 } )

      let { objectsToDeleteTarget, objectsToUploadTarget, objectsToUploadSource, objectsToDeleteSource } = logic.computeSync(files, helper.MODES.UNI, true);

      assert.strictEqual(objectsToDeleteSource.length, 0);
      assert.strictEqual(objectsToDeleteTarget.length, 0);
      assert.strictEqual(objectsToUploadTarget.length, 1);
      assert.strictEqual(objectsToUploadSource.length, 0);
      assert.strictEqual(files.source.size, 1);
      assert.strictEqual(files.target.size, 1);
      assert.strictEqual(files.cache.size, 1);
      /** Verify values */
      assert.strictEqual(objectsToUploadTarget[0]?.md5, "111fewfweoijfoiwej");
      assert.strictEqual(objectsToUploadTarget[0]?.key, "file.txt");
      assert.strictEqual(objectsToUploadTarget[0]?.lastmodified, 1685107819);
    })
    it('should update a source object into the target storage (delete:false)', function() {
      files.source.set('file1', { md5: "111fewfweoijfoiwej", key: "file.txt", lastmodified: 1685107819 } ) // newest version
      files.target.set('file1', { md5: "222ewjfoiewjfoiwej", key: "file.txt", lastmodified: 1685107765 } )

      let { objectsToDeleteTarget, objectsToUploadTarget, objectsToUploadSource, objectsToDeleteSource } = logic.computeSync(files, helper.MODES.UNI, false);

      assert.strictEqual(objectsToDeleteSource.length, 0);
      assert.strictEqual(objectsToDeleteTarget.length, 0);
      assert.strictEqual(objectsToUploadTarget.length, 1);
      assert.strictEqual(objectsToUploadSource.length, 0);
      assert.strictEqual(files.source.size, 1);
      assert.strictEqual(files.target.size, 1);
      assert.strictEqual(files.cache.size, 1);
      /** Verify values */
      assert.strictEqual(objectsToUploadTarget[0]?.md5, "111fewfweoijfoiwej");
      assert.strictEqual(objectsToUploadTarget[0]?.key, "file.txt");
      assert.strictEqual(objectsToUploadTarget[0]?.lastmodified, 1685107819);
    })
    it('should update a source object into the target storage EVEN if it is not the latest version (delete:false)', function() {
      files.source.set('file1', { md5: "111fewfweoijfoiwej", key: "file.txt", lastmodified: 1685107765 } )
      files.target.set('file1', { md5: "222ewjfoiewjfoiwej", key: "file.txt", lastmodified:  1685107819 } ) // newest version

      let { objectsToDeleteTarget, objectsToUploadTarget, objectsToUploadSource, objectsToDeleteSource } = logic.computeSync(files, helper.MODES.UNI, false);

      assert.strictEqual(objectsToDeleteSource.length, 0);
      assert.strictEqual(objectsToDeleteTarget.length, 0);
      assert.strictEqual(objectsToUploadTarget.length, 1);
      assert.strictEqual(objectsToUploadSource.length, 0);
      assert.strictEqual(files.source.size, 1);
      assert.strictEqual(files.target.size, 1);
      assert.strictEqual(files.cache.size, 1);
      /** Verify values */
      assert.strictEqual(objectsToUploadTarget[0]?.md5, "111fewfweoijfoiwej");
      assert.strictEqual(objectsToUploadTarget[0]?.key, "file.txt");
      assert.strictEqual(objectsToUploadTarget[0]?.lastmodified, 1685107765);
    })
    it('should delete a target object if it does not exist on the source storage (delete:true)', function() {
      for (let i = 0; i < 10; i++) {
        files.target.set('file' + i, { id : i, key: i+ "-value.txt" } )
      }
      let { objectsToDeleteTarget, objectsToUploadTarget, objectsToUploadSource, objectsToDeleteSource } = logic.computeSync(files, helper.MODES.UNI, true);
      assert.strictEqual(objectsToDeleteTarget.length, 10);
      assert.strictEqual(objectsToUploadTarget.length, 0);
      assert.strictEqual(objectsToUploadSource.length, 0);
      assert.strictEqual(objectsToDeleteSource.length, 0);
      assert.strictEqual(files.source.size, 0);
      assert.strictEqual(files.target.size, 0);
      assert.strictEqual(files.cache.size, 0);
    })
    it('should NOT delete a target object if it does not exist on the source storage with deletion option at false (delete:false)', function() {
      for (let i = 0; i < 10; i++) {
        files.target.set('file' + i, { id : i, key: i+ "-value.txt" } )
      }
      let { objectsToDeleteTarget, objectsToUploadTarget, objectsToUploadSource, objectsToDeleteSource } = logic.computeSync(files, helper.MODES.UNI, false);
      assert.strictEqual(objectsToDeleteTarget.length, 0);
      assert.strictEqual(objectsToUploadTarget.length, 0);
      assert.strictEqual(objectsToUploadSource.length, 0);
      assert.strictEqual(objectsToDeleteSource.length, 0);
      assert.strictEqual(files.source.size, 0);
      assert.strictEqual(files.target.size, 10);
      assert.strictEqual(files.cache.size, 0);
    })
    it('should not add/update/delete on the source storage (delete: true)', function() {
      for (let i = 0; i < 5; i++) {
        files.target.set('file' + i, { id : i, key: i+ "-value.txt" } )
      }
      files.source.set('file' + 1, { id : 1, key: 1+ "-value.txt" } )
      files.source.set('file' + 2, { id : 2, key: 2+ "-value.txt" } )
      files.source.set('file' + 6, { id : 6, key: 6+ "-value.txt" } )

      let { objectsToDeleteTarget, objectsToUploadTarget, objectsToUploadSource, objectsToDeleteSource } = logic.computeSync(files, helper.MODES.UNI, true);
      assert.strictEqual(objectsToDeleteTarget.length, 3);
      assert.strictEqual(objectsToUploadTarget.length, 1);
      assert.strictEqual(objectsToUploadSource.length, 0);
      assert.strictEqual(objectsToDeleteSource.length, 0);
      assert.strictEqual(files.source.size, 3);
      assert.strictEqual(files.target.size, 3);
      assert.strictEqual(files.cache.size, 1); // cache isn't used for uni-directional sync
    })
    it('should not add/update/delete on the source storage (delete: false)', function() {
      for (let i = 0; i < 5; i++) {
        files.target.set('file' + i, { id : i, key: i+ "-value.txt" } )
      }
      files.source.set('file' + 1, { id : 1, key: 1+ "-value.txt" } )
      files.source.set('file' + 2, { id : 2, key: 2+ "-value.txt" } )
      files.source.set('file' + 6, { id : 6, key: 6+ "-value.txt" } )

      let { objectsToDeleteTarget, objectsToUploadTarget, objectsToUploadSource, objectsToDeleteSource } = logic.computeSync(files, helper.MODES.UNI, false);
      assert.strictEqual(objectsToDeleteTarget.length, 0);
      assert.strictEqual(objectsToUploadTarget.length, 1);
      assert.strictEqual(objectsToUploadSource.length, 0);
      assert.strictEqual(objectsToDeleteSource.length, 0);
      assert.strictEqual(files.source.size, 3);
      assert.strictEqual(files.target.size, 6);
      assert.strictEqual(files.cache.size, 1); // cache isn't used for uni-directional sync
    })
  });

  describe("Bidirectional sync", function() {
    it("Si un object target existe pas dans la source et qu'il existe dans le cache, alors on supprime dans la target et le cache (Delete: true)", function(){
      for (let i = 0; i < 10; i++) {
        files.target.set('file' + i, { id : i, key: i+ "-value.txt" } )
        files.cache.set('file' + i, { id : i, key: i+ "-value.txt"} )
      }
      let { objectsToDeleteTarget, objectsToUploadTarget, objectsToUploadSource, objectsToDeleteSource } = logic.computeSync(files, helper.MODES.BI, true);
      assert.strictEqual(objectsToDeleteTarget.length, 10);
      assert.strictEqual(objectsToUploadTarget.length, 0);
      assert.strictEqual(objectsToUploadSource.length, 0);
      assert.strictEqual(objectsToDeleteSource.length, 0);
      assert.strictEqual(files.source.size, 0);
      assert.strictEqual(files.target.size, 0);
      assert.strictEqual(files.cache.size, 0);
      /** Verify values */
      assert.strictEqual(objectsToDeleteTarget[0]?.key, '0-value.txt');
      assert.strictEqual(objectsToDeleteTarget[0]?.id, 0);
    });

    it("Si un object target existe pas dans la source et qu'il existe dans le cache, alors on supprime PAS dans la target et on ajoute à la source (Delete: false)", function(){
      for (let i = 0; i < 10; i++) {
        files.target.set('file' + i, { id : i, key: i+ "-value.txt" } )
        files.cache.set('file' + i, { id : i, key: i+ "-value.txt"} )
      }
      let { objectsToDeleteTarget, objectsToUploadTarget, objectsToUploadSource, objectsToDeleteSource } = logic.computeSync(files, helper.MODES.BI, false);
      assert.strictEqual(objectsToDeleteTarget.length, 0);
      assert.strictEqual(objectsToUploadTarget.length, 0);
      assert.strictEqual(objectsToUploadSource.length, 10);
      assert.strictEqual(objectsToDeleteSource.length, 0);
      assert.strictEqual(files.source.size, 10);
      assert.strictEqual(files.target.size, 10);
      assert.strictEqual(files.cache.size, 10);
    });

    it("Si pas de cache (premier lancement), ajouter les fichiers manquants à la source et target (Delete: true)", function(){
      for (let i = 0; i < 10; i++) {
        files.target.set('file' + i, { id : i} )
      }
      files.source.set('file1', { id : 1} )
      files.source.set('file2', { id : 2} )
      files.source.set('file11', { id : 11} )
      files.source.set('file12', { id : 12} )
      let { objectsToDeleteTarget, objectsToUploadTarget, objectsToUploadSource, objectsToDeleteSource } = logic.computeSync(files, helper.MODES.BI, true);
      assert.strictEqual(objectsToDeleteTarget.length, 0);
      assert.strictEqual(objectsToUploadTarget.length, 2);
      assert.strictEqual(objectsToUploadSource.length, 8);
      assert.strictEqual(objectsToDeleteSource.length, 0);
      assert.strictEqual(files.source.size, 12);
      assert.strictEqual(files.target.size, 12);
      assert.strictEqual(files.cache.size, 10); // Normal, the cache doesn't matter for the first run
      /** Verify values */
      assert.strictEqual(objectsToUploadSource[0].id, 0);
      assert.strictEqual(objectsToUploadSource[objectsToUploadSource.length-1].id, 9);
      assert.strictEqual(objectsToUploadTarget[0].id, 11);
      assert.strictEqual(objectsToUploadTarget[1].id, 12);
    });

    it("Si pas de cache (premier lancement), ajouter les fichiers manquants à la source et target (Delete: false)", function(){
      for (let i = 0; i < 10; i++) {
        files.target.set('file' + i, { id : i} )
      }
      files.source.set('file1', { id : 1} )
      files.source.set('file2', { id : 1} )
      let { objectsToDeleteTarget, objectsToUploadTarget, objectsToUploadSource, objectsToDeleteSource } = logic.computeSync(files, helper.MODES.BI, false);
      assert.strictEqual(objectsToDeleteTarget.length, 0);
      assert.strictEqual(objectsToUploadTarget.length, 0);
      assert.strictEqual(objectsToUploadSource.length, 8);
      assert.strictEqual(objectsToDeleteSource.length, 0);
      assert.strictEqual(files.source.size, 10);
      assert.strictEqual(files.target.size, 10);
      assert.strictEqual(files.cache.size, 8); // Normal, the cache doesn't matter for the first run
      /** Verify values */
      assert.strictEqual(objectsToUploadSource[0].id, 0);
      assert.strictEqual(objectsToUploadSource[1].id, 3);
    });

    it("si un object target existe pas dans la source, et qu'il n'existe pas dans le cache, alors on ajoute dans la source et le cache (delete: true)", function(){
      for (let i = 0; i < 10; i++) {
        files.target.set('file' + i, { id : i} )
      }
      files.source.set('file11', { id : 11} )
      files.cache.set('file11', { id : 11} )

      let { objectsToDeleteTarget, objectsToUploadTarget, objectsToUploadSource, objectsToDeleteSource } = logic.computeSync(files, helper.MODES.BI, true);
      assert.strictEqual(objectsToDeleteTarget.length, 0);
      assert.strictEqual(objectsToUploadTarget.length, 0);
      assert.strictEqual(objectsToUploadSource.length, 10);
      assert.strictEqual(objectsToDeleteSource.length, 1);
      assert.strictEqual(files.source.size, 10);
      assert.strictEqual(files.target.size, 10);
      assert.strictEqual(files.cache.size, 10);
      /** Verify values */
      assert.strictEqual(objectsToDeleteSource[0].id, 11);
      assert.strictEqual(objectsToUploadSource[0].id, 0);
      assert.strictEqual(objectsToUploadSource[objectsToUploadSource.length - 1].id, 9);
    });

    it("si un object target existe pas dans la source, et qu'il n'existe pas dans le cache, alors on ajoute dans la source et le cache (delete: false)", function(){
      for (let i = 0; i < 10; i++) {
        files.target.set('file' + i, { id : i} )
      }
      files.source.set('file11', { id : 11} )
      files.cache.set('file11', { id : 11} )

      let { objectsToDeleteTarget, objectsToUploadTarget, objectsToUploadSource, objectsToDeleteSource } = logic.computeSync(files, helper.MODES.BI, false);
      assert.strictEqual(objectsToDeleteTarget.length, 0);
      assert.strictEqual(objectsToUploadTarget.length, 1);
      assert.strictEqual(objectsToUploadSource.length, 10);
      assert.strictEqual(objectsToDeleteSource.length, 0);
      assert.strictEqual(files.source.size, 11);
      assert.strictEqual(files.target.size, 11);
      assert.strictEqual(files.cache.size, 11);
      /** Verify values */
      assert.strictEqual(objectsToUploadSource[0].id, 0);
      assert.strictEqual(objectsToUploadSource[objectsToUploadSource.length - 1].id, 9);
    });

    it("Si un object source existe pas dans le target, et qu'il n'existe pas dans le cache, on ajoute dans target et le cache (delete: true)", function() {
      for (let i = 0; i < 10; i++) {
        files.source.set('file' + i, { id : i} )
      }
      files.target.set('file11', { id : 11} )
      files.cache.set('file12', { id : 12} )

      let { objectsToDeleteTarget, objectsToUploadTarget, objectsToUploadSource, objectsToDeleteSource } = logic.computeSync(files, helper.MODES.BI, true);
      assert.strictEqual(objectsToDeleteTarget.length, 0);
      assert.strictEqual(objectsToUploadTarget.length, 10);
      assert.strictEqual(objectsToUploadSource.length, 1);
      assert.strictEqual(objectsToDeleteSource.length, 0);
      assert.strictEqual(files.source.size, 11);
      assert.strictEqual(files.target.size, 11);
      assert.strictEqual(files.cache.size, 12);
      /** Verify values */
      assert.strictEqual(objectsToUploadSource[0].id, 11);
      assert.strictEqual(objectsToUploadTarget[0].id, 0);
      assert.strictEqual(objectsToUploadTarget[objectsToUploadTarget.length - 1].id, 9);
    });

    it("Si un object source existe pas dans le target, et qu'il n'existe pas dans le cache, on ajoute dans target et le cache (delete: false)", function() {
      for (let i = 0; i < 10; i++) {
        files.source.set('file' + i, { id : i} )
      }
      files.target.set('file11', { id : 11} )
      files.cache.set('file12', { id : 12} )

      let { objectsToDeleteTarget, objectsToUploadTarget, objectsToUploadSource, objectsToDeleteSource } = logic.computeSync(files, helper.MODES.BI, false);
      assert.strictEqual(objectsToDeleteTarget.length, 0);
      assert.strictEqual(objectsToUploadTarget.length, 10);
      assert.strictEqual(objectsToUploadSource.length, 1);
      assert.strictEqual(objectsToDeleteSource.length, 0);
      assert.strictEqual(files.source.size, 11);
      assert.strictEqual(files.target.size, 11);
      assert.strictEqual(files.cache.size, 12);
      /** Verify values */
      assert.strictEqual(objectsToUploadSource[0].id, 11);
      assert.strictEqual(objectsToUploadTarget[0].id, 0);
      assert.strictEqual(objectsToUploadTarget[objectsToUploadTarget.length - 1].id, 9);
    });

    it("Si un object source n'existe pas dans le target, et qu'il existe dans le cache, on supprime de la source (delete: true)", function() {
      for (let i = 0; i < 10; i++) {
        files.source.set('file' + i, { id : i } )
        files.cache.set('file' + i, { id : i } )
      }
      files.target.set('file12', { id : 12} )

      let { objectsToDeleteTarget, objectsToUploadTarget, objectsToUploadSource, objectsToDeleteSource } = logic.computeSync(files, helper.MODES.BI, true);
      assert.strictEqual(objectsToDeleteTarget.length, 0);
      assert.strictEqual(objectsToUploadTarget.length, 0);
      assert.strictEqual(objectsToUploadSource.length, 1);
      assert.strictEqual(objectsToDeleteSource.length, 10);
      assert.strictEqual(files.source.size, 1);
      assert.strictEqual(files.target.size, 1);
      assert.strictEqual(files.cache.size, 1);
      /** Verify values */
      assert.strictEqual(objectsToUploadSource[0].id, 12);
      assert.strictEqual(objectsToDeleteSource[0].id, 0);
      assert.strictEqual(objectsToDeleteSource[objectsToDeleteSource.length - 1].id, 9);
    });

    it("Si un object source n'existe pas dans le target, et qu'il existe dans le cache, on supprime PAS de la source et on ajoute au target (delete: false)", function() {
      for (let i = 0; i < 10; i++) {
        files.source.set('file' + i, { id : i } )
        files.cache.set('file' + i, { id : i } )
      }
      files.target.set('file12', { id : 12} )

      let { objectsToDeleteTarget, objectsToUploadTarget, objectsToUploadSource, objectsToDeleteSource } = logic.computeSync(files, helper.MODES.BI, false);
      assert.strictEqual(objectsToDeleteTarget.length, 0);
      assert.strictEqual(objectsToUploadTarget.length, 10);
      assert.strictEqual(objectsToUploadSource.length, 1);
      assert.strictEqual(objectsToDeleteSource.length, 0);
      assert.strictEqual(files.source.size, 11);
      assert.strictEqual(files.target.size, 11);
      assert.strictEqual(files.cache.size, 11);
      /** Verify values */
      assert.strictEqual(objectsToUploadSource[0].id, 12);
    });

    it('mixed sync with cache (delete: true)', function() {
      for (let i = 0; i < 10; i++) {
        files.source.set('file' + i, { id : i, key: i+'-file.txt', md5: i + "adbc"} )
        files.cache.set('file' + i, { id : i, key: i+'-file.txt', md5: i + "adbc"} )
      }
      files.cache.set('file11', { id : 11, key: 11+'-file.txt', md5: 11 + "adbc"} )
      files.target.set('file11', { id : 11, key: 11+'-file.txt', md5: 11 + "adbc"} )
      files.target.set('file14', { id : 14, key: 14+'-file.txt', md5: 14 + "adbc"} )
      files.source.set('file12', { id : 12, key: 12+'-file.txt', md5: 12 + "adbc"} )
      files.source.set('file13', { id : 13, key: 13+'-file.txt', md5: 13 + "adbc"} )

      /** Files already exists but un-changed */
      files.source.set('file15', { id : 15, key: 15+'-file.txt', md5: 15 + "adbc", lastmodified: 1685107819 } )
      files.target.set('file15', { id : 15, key: 15+'-file.txt', md5: 15 + "adbc", lastmodified: 1685107819 } )
      files.cache.set('file15', { id : 15, key: 15+'-file.txt', md5: 15 + "adbc", lastmodified: 1685107819 } )
      /** Files already exists but the content changed and uploaded from the target */
      files.source.set('file16', { id : 16, key: 16+'-file.txt', md5: 16 + "adbc", lastmodified: 1685107819 })
      files.target.set('file16', { id : 16, key: 16+'-file.txt', md5: 16 + "ZZZZ", lastmodified: 1685109308 }) // newest version
      files.cache.set('file16', { id : 16, key: 16+'-file.txt', md5: 16 + "adbc", lastmodified: 1685107819} )
      /** Files already exists but the content changed and uploaded from the source */
      files.source.set('file17', { id : 17, key: 17+'-file.txt', md5: 17 + "WWWW", lastmodified: 1785109308 }) // newest version
      files.target.set('file17', { id : 17, key: 17+'-file.txt', md5: 17 + "adbc", lastmodified: 1785107819 })
      files.cache.set('file17', { id : 17, key: 17+'-file.txt', md5: 17 + "adbc", lastmodified: 1785107819} )


      let { objectsToDeleteTarget, objectsToUploadTarget, objectsToUploadSource, objectsToDeleteSource } = logic.computeSync(files, helper.MODES.BI, true);
      assert.strictEqual(objectsToDeleteTarget.length, 1);
      assert.strictEqual(objectsToUploadTarget.length, 3);
      assert.strictEqual(objectsToUploadSource.length, 2);
      assert.strictEqual(objectsToDeleteSource.length, 10);

      assert.strictEqual(files.source.size, 6);
      assert.strictEqual(files.target.size, 6);
      assert.strictEqual(files.cache.size, 6);
      /** Verify values of non existing files to upload/delete */
      assert.strictEqual(objectsToUploadSource[0].id, 14);
      assert.strictEqual(objectsToUploadTarget[0].id, 12);
      assert.strictEqual(objectsToUploadTarget[1].id, 13);
      assert.strictEqual(objectsToDeleteTarget[0].id, 11);
      assert.strictEqual(objectsToDeleteTarget[0]?.key, "11-file.txt");
      assert.strictEqual(objectsToDeleteSource[0].id, 0)
      assert.strictEqual(objectsToDeleteSource[objectsToDeleteSource.length - 1].id, 9)
      /** Verify values of updated existing files */
      assert.strictEqual(objectsToUploadTarget[objectsToUploadTarget.length - 1].id, 17);
      assert.strictEqual(objectsToUploadTarget[objectsToUploadTarget.length - 1].md5, "17WWWW");
      assert.strictEqual(objectsToUploadTarget[objectsToUploadTarget.length - 1].lastmodified, 1785109308);
      const _17 = files.target.get('file17')
      assert.strictEqual(_17.md5, "17WWWW");
      assert.strictEqual(_17.lastmodified, 1785109308);

      assert.strictEqual(objectsToUploadSource[objectsToUploadSource.length - 1].id, 16);
      assert.strictEqual(objectsToUploadSource[objectsToUploadSource.length - 1].md5, "16ZZZZ");
      assert.strictEqual(objectsToUploadSource[objectsToUploadSource.length - 1].lastmodified, 1685109308);
      const _16 = files.target.get('file16')
      assert.strictEqual(_16.md5, "16ZZZZ");
      assert.strictEqual(_16.lastmodified, 1685109308);
    });

    it('mixed sync with cache (delete: false)', function() {
      for (let i = 0; i < 10; i++) {
        files.source.set('file' + i, { id : i, key: i+'-file.txt', md5: i + "adbc"} )
        files.cache.set('file' + i, { id : i, key: i+'-file.txt', md5: i + "adbc"} )
      }
      files.cache.set('file11', { id : 11, key: 11+'-file.txt', md5: 11 + "adbc"} )
      files.target.set('file11', { id : 11, key: 11+'-file.txt', md5: 11 + "adbc"} )
      files.target.set('file14', { id : 14, key: 14+'-file.txt', md5: 14 + "adbc"} )
      files.source.set('file12', { id : 12, key: 12+'-file.txt', md5: 12 + "adbc"} )
      files.source.set('file13', { id : 13, key: 13+'-file.txt', md5: 13 + "adbc"} )

      /** Files already exists but un-changed */
      files.source.set('file15', { id : 15, key: 15+'-file.txt', md5: 15 + "adbc", lastmodified: 1685107819 } )
      files.target.set('file15', { id : 15, key: 15+'-file.txt', md5: 15 + "adbc", lastmodified: 1685107819 } )
      files.cache.set('file15', { id : 15, key: 15+'-file.txt', md5: 15 + "adbc", lastmodified: 1685107819 } )
      /** Files already exists but the content changed and uploaded from the target */
      files.source.set('file16', { id : 16, key: 16+'-file.txt', md5: 16 + "adbc", lastmodified: 1685107819 })
      files.target.set('file16', { id : 16, key: 16+'-file.txt', md5: 16 + "ZZZZ", lastmodified: 1685109308 }) // newest version
      files.cache.set('file16', { id : 16, key: 16+'-file.txt', md5: 16 + "adbc", lastmodified: 1685107819} )
      /** Files already exists but the content changed and uploaded from the source */
      files.source.set('file17', { id : 17, key: 17+'-file.txt', md5: 17 + "WWWW", lastmodified: 1785109308 }) // newest version
      files.target.set('file17', { id : 17, key: 17+'-file.txt', md5: 17 + "adbc", lastmodified: 1785107819 })
      files.cache.set('file17', { id : 17, key: 17+'-file.txt', md5: 17 + "adbc", lastmodified: 1785107819} )


      let { objectsToDeleteTarget, objectsToUploadTarget, objectsToUploadSource, objectsToDeleteSource } = logic.computeSync(files, helper.MODES.BI, false);
      assert.strictEqual(objectsToDeleteTarget.length, 0);
      assert.strictEqual(objectsToUploadTarget.length, 13);
      assert.strictEqual(objectsToUploadSource.length, 3);
      assert.strictEqual(objectsToDeleteSource.length, 0);

      assert.strictEqual(files.source.size, 17);
      assert.strictEqual(files.target.size, 17);
      assert.strictEqual(files.cache.size, 17);
      /** Verify values of non existing files to upload/delete */
      assert.strictEqual(objectsToUploadSource[0].id, 11);
      assert.strictEqual(objectsToUploadTarget[0].id, 0);
      assert.strictEqual(objectsToUploadTarget[1].id, 1);
      /** Verify values of updated existing files */
      assert.strictEqual(objectsToUploadTarget[objectsToUploadTarget.length - 1].id, 17);
      assert.strictEqual(objectsToUploadTarget[objectsToUploadTarget.length - 1].md5, "17WWWW");
      assert.strictEqual(objectsToUploadTarget[objectsToUploadTarget.length - 1].lastmodified, 1785109308);
      const _17 = files.target.get('file17')
      assert.strictEqual(_17.md5, "17WWWW");
      assert.strictEqual(_17.lastmodified, 1785109308);

      assert.strictEqual(objectsToUploadSource[objectsToUploadSource.length - 1].id, 16);
      assert.strictEqual(objectsToUploadSource[objectsToUploadSource.length - 1].md5, "16ZZZZ");
      assert.strictEqual(objectsToUploadSource[objectsToUploadSource.length - 1].lastmodified, 1685109308);
      const _16 = files.target.get('file16')
      assert.strictEqual(_16.md5, "16ZZZZ");
      assert.strictEqual(_16.lastmodified, 1685109308);
    });

    it("Si un object target EXISTE dans la source mais que le MD5 est different, on prend le plus récent des deux (delete: true)", function(){
      files.source.set('file1', { md5: "111fewfweoijfoiwej", key: "file.txt", lastmodified: 1685107765 } )
      files.cache.set('file1', { md5: "111fewfweoijfoiwej", key: "file.txt", lastmodified: 1685107765 } )
      files.target.set('file1', { md5: "222ewjfoiewjfoiwej", key: "file.txt", lastmodified: 1685107819 } ) // newest version

      let { objectsToDeleteTarget, objectsToUploadTarget, objectsToUploadSource, objectsToDeleteSource } = logic.computeSync(files, helper.MODES.BI, true);
      assert.strictEqual(objectsToDeleteTarget.length, 0);
      assert.strictEqual(objectsToDeleteSource.length, 0);
      assert.strictEqual(objectsToUploadTarget.length, 0);
      assert.strictEqual(objectsToUploadSource.length, 1);
      assert.strictEqual(files.source.size, 1);
      assert.strictEqual(files.target.size, 1);
      assert.strictEqual(files.cache.size, 1);
      /** Verify values */
      assert.strictEqual(objectsToUploadSource[0]?.md5, "222ewjfoiewjfoiwej");
      assert.strictEqual(objectsToUploadSource[0]?.key, "file.txt");
      assert.strictEqual(objectsToUploadSource[0]?.lastmodified, 1685107819);
    });

    it("Si un object target EXISTE dans la source mais que le MD5 est different, on prend le plus récent des deux (delete: false)", function(){
      files.source.set('file1', { md5: "111fewfweoijfoiwej", key: "file.txt", lastmodified: 1685107765 } )
      files.cache.set('file1', { md5: "111fewfweoijfoiwej", key: "file.txt", lastmodified: 1685107765 } )
      files.target.set('file1', { md5: "222ewjfoiewjfoiwej", key: "file.txt", lastmodified: 1685107819 } ) // newest version

      let { objectsToDeleteTarget, objectsToUploadTarget, objectsToUploadSource, objectsToDeleteSource } = logic.computeSync(files, helper.MODES.BI, false);
      assert.strictEqual(objectsToDeleteTarget.length, 0);
      assert.strictEqual(objectsToDeleteSource.length, 0);
      assert.strictEqual(objectsToUploadTarget.length, 0);
      assert.strictEqual(objectsToUploadSource.length, 1);
      assert.strictEqual(files.source.size, 1);
      assert.strictEqual(files.target.size, 1);
      assert.strictEqual(files.cache.size, 1);
      /** Verify values */
      assert.strictEqual(objectsToUploadSource[0]?.md5, "222ewjfoiewjfoiwej");
      assert.strictEqual(objectsToUploadSource[0]?.key, "file.txt");
      assert.strictEqual(objectsToUploadSource[0]?.lastmodified, 1685107819);
    });

    it("Si un object source EXISTE dans le target mais que le MD5 est different, on prend le plus récent des deux (delete: true)", function(){
      files.source.set('file1', { md5: "111fewfweoijfoiwej", key: "file.txt", lastmodified: 1685107819 } ) // newest version
      files.cache.set('file1', { md5: "222ewjfoiewjfoiwej", key: "file.txt", lastmodified: 1685107765 } )
      files.target.set('file1', { md5: "222ewjfoiewjfoiwej", key: "file.txt", lastmodified: 1685107765 } )

      let { objectsToDeleteTarget, objectsToUploadTarget, objectsToUploadSource, objectsToDeleteSource } = logic.computeSync(files, helper.MODES.BI, true);

      assert.strictEqual(objectsToDeleteSource.length, 0);
      assert.strictEqual(objectsToDeleteTarget.length, 0);
      assert.strictEqual(objectsToUploadTarget.length, 1);
      assert.strictEqual(objectsToUploadSource.length, 0);
      assert.strictEqual(files.source.size, 1);
      assert.strictEqual(files.target.size, 1);
      assert.strictEqual(files.cache.size, 1);
      /** Verify values */
      assert.strictEqual(objectsToUploadTarget[0]?.md5, "111fewfweoijfoiwej");
      assert.strictEqual(objectsToUploadTarget[0]?.key, "file.txt");
      assert.strictEqual(objectsToUploadTarget[0]?.lastmodified, 1685107819);
    });

    it("Si un object source EXISTE dans le target mais que le MD5 est different, on prend le plus récent des deux (delete: false)", function(){
      files.source.set('file1', { md5: "111fewfweoijfoiwej", key: "file.txt", lastmodified: 1685107819 } ) // newest version
      files.cache.set('file1', { md5: "222ewjfoiewjfoiwej", key: "file.txt", lastmodified: 1685107765 } )
      files.target.set('file1', { md5: "222ewjfoiewjfoiwej", key: "file.txt", lastmodified: 1685107765 } )

      let { objectsToDeleteTarget, objectsToUploadTarget, objectsToUploadSource, objectsToDeleteSource } = logic.computeSync(files, helper.MODES.BI, false);

      assert.strictEqual(objectsToDeleteSource.length, 0);
      assert.strictEqual(objectsToDeleteTarget.length, 0);
      assert.strictEqual(objectsToUploadTarget.length, 1);
      assert.strictEqual(objectsToUploadSource.length, 0);
      assert.strictEqual(files.source.size, 1);
      assert.strictEqual(files.target.size, 1);
      assert.strictEqual(files.cache.size, 1);
      /** Verify values */
      assert.strictEqual(objectsToUploadTarget[0]?.md5, "111fewfweoijfoiwej");
      assert.strictEqual(objectsToUploadTarget[0]?.key, "file.txt");
      assert.strictEqual(objectsToUploadTarget[0]?.lastmodified, 1685107819);
    });
  });

});

beforeEach(function(done) {
  const _files = fs.readdirSync(path.join(__dirname, '..', 'logs'));
  for (let i = 0; i < _files.length; i++) {
    if (_files[i].includes('.json') === true) {
      fs.rmSync(path.join(__dirname, '..', 'logs', _files[i]));
    }
  }
  done();
})

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

  })
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
      }, 1000)
    }, 1000)
  })
});