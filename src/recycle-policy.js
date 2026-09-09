(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.VoiceoverNamerRecyclePolicy = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  var GRACE_MS = 30000;

  function validRecord(record, context, samePath, destination) {
    return !!(record && record.schemaVersion === 1 && record.projectIdentity === context.identity
      && samePath(record.projectPath, context.project.path)
      && /^[0-9a-f]{32}$/.test(record.recordingId) && record.projectItemId
      && /^[0-9a-f]{64}$/.test(record.sha256) && Number.isSafeInteger(record.size) && record.size > 0
      && Number.isFinite(record.birthtimeMs) && record.birthtimeMs > 0
      && samePath(record.targetPath, destination(record)));
  }

  function referenced(record, snapshot, normalize) {
    return snapshot.ids.has(record.projectItemId) || snapshot.paths.has(normalize(record.targetPath));
  }

  // The armed set is session-local: opening a project must never sweep old unused files.
  function createPolicy(normalize) {
    var armed = new Set();
    var absentSince = new Map();
    return {
      arm: function (record) { armed.add(record.recordingId); },
      observe: function (records, snapshot, now) {
        if (!snapshot || snapshot.complete !== true) {
          absentSince.clear();
          return [];
        }
        var ready = [];
        records.forEach(function (record) {
          var id = record.recordingId;
          if (referenced(record, snapshot, normalize)) {
            armed.add(id);
            absentSince.delete(id);
          } else if (armed.has(id)) {
            if (!absentSince.has(id)) absentSince.set(id, now);
            if (now - absentSince.get(id) >= GRACE_MS) ready.push(record);
          }
        });
        return ready;
      },
      reset: function () { armed.clear(); absentSince.clear(); },
    };
  }
  return { GRACE_MS: GRACE_MS, validRecord: validRecord, referenced: referenced, createPolicy: createPolicy };
});
