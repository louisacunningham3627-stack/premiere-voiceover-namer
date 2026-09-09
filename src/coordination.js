(function (root, factory) {
  "use strict";

  var api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.VoiceoverNamerCoordination = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function createOperationQueue() {
    var tail = Promise.resolve();
    return {
      run: function (operation) {
        var release;
        var gate = new Promise(function (resolve) {
          release = resolve;
        });
        var previous = tail;
        tail = gate;
        return previous.then(operation, operation).finally(release);
      },
    };
  }

  async function reserveRecordingPlan(pending, candidate, createPlan) {
    if (!pending.plan) pending.plan = await createPlan(candidate);
    pending.plan.candidate = candidate;
    pending.plan.sourceSignature = candidate.sourceSignature;
    return pending.plan;
  }

  function createGenerationGuard() {
    var generation = 0;
    return {
      bump: function () {
        generation += 1;
        return generation;
      },
      current: function () {
        return generation;
      },
      isCurrent: function (candidate) {
        return candidate === generation;
      },
    };
  }

  function shouldHandleOperationComplete(event, successState) {
    if (!event || event.state == null) return true;
    return successState != null && event.state === successState;
  }

  function markProcessedPath(collections, sourcePath, targetPath, normalizePath) {
    var sourceKey = normalizePath(sourcePath);
    var targetKey = normalizePath(targetPath);
    collections.seenPaths.delete(sourceKey);
    collections.watchedFolderBaseline.delete(sourceKey);
    collections.seenPaths.add(targetKey);
    collections.watchedFolderBaseline.add(targetKey);
    collections.unmatchedFolderFiles.delete(sourceKey);
    collections.pendingFiles.delete(sourceKey);
    return { sourceKey: sourceKey, targetKey: targetKey };
  }

  return {
    createOperationQueue: createOperationQueue,
    reserveRecordingPlan: reserveRecordingPlan,
    createGenerationGuard: createGenerationGuard,
    shouldHandleOperationComplete: shouldHandleOperationComplete,
    markProcessedPath: markProcessedPath,
  };
});
