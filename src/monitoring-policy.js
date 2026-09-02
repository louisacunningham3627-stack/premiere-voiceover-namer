(function (root, factory) {
  "use strict";

  var api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.VoiceoverNamerMonitoringPolicy = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var CAPTURE_MARKERS = [
    "adobe premiere pro captured and generated",
    "adobe premiere pro captured audio",
  ];

  function normalizePath(nativePath) {
    var text = String(nativePath || "").replace(/\\/g, "/").replace(/\/+$/g, "");
    if (/^[a-z]:\//i.test(text) || text.indexOf("//") === 0) text = text.toLowerCase();
    return text;
  }

  function pathInside(nativePath, directory) {
    var path = normalizePath(nativePath);
    var root = normalizePath(directory);
    return !!root && (path === root || path.indexOf(root + "/") === 0);
  }

  function splitNativePath(nativePath) {
    var text = String(nativePath || "");
    var slash = Math.max(text.lastIndexOf("\\"), text.lastIndexOf("/"));
    return {
      dir: slash >= 0 ? text.slice(0, slash) : "",
      base: slash >= 0 ? text.slice(slash + 1) : text,
    };
  }

  function captureFolderFromMediaPath(nativePath) {
    return splitNativePath(nativePath).dir;
  }

  function isNativeDefaultRecordingName(nativePath) {
    var fileName = splitNativePath(nativePath).base;
    return /^(?:audio|音频|音訊|音軌|オーディオ|오디오|аудио)\s*\d+(?:_\d+)?\.wav$/i.test(fileName);
  }

  function buildProjectIdentity(projectPath, projectGuid, normalize) {
    var pathNormalizer = typeof normalize === "function" ? normalize : normalizePath;
    var path = pathNormalizer(projectPath || "");
    var guid = String(projectGuid || "");
    if (path) return path + "|" + guid;
    return guid || "unsaved-project";
  }

  function isAbsoluteNativePath(nativePath) {
    var value = String(nativePath || "").trim();
    return /^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value) || /^\//.test(value);
  }

  function hasCaptureMarker(nativePath) {
    var normalized = normalizePath(nativePath);
    return CAPTURE_MARKERS.some(function (marker) {
      return normalized.split("/").indexOf(marker) >= 0;
    });
  }

  function isTrustedCapturePath(options) {
    var values = options || {};
    var mediaPath = String(values.mediaPath || "");
    if (!/\.wav$/i.test(splitNativePath(mediaPath).base)) return false;

    var inside = typeof values.isPathInside === "function" ? values.isPathInside : pathInside;
    if (values.learnedFolder && inside(mediaPath, values.learnedFolder)) return true;

    var scratchPath = String(values.scratchPath || "").trim();
    if (isAbsoluteNativePath(scratchPath) && inside(mediaPath, scratchPath)) return true;

    if (!hasCaptureMarker(mediaPath)) return false;

    var projectPath = String(values.projectPath || "");
    var projectDirectory = splitNativePath(projectPath).dir;
    if (projectDirectory && inside(mediaPath, projectDirectory)) return true;

    // My Documents and other symbolic scratch-disk values do not reveal an
    // absolute root. Adobe's own capture folder marker is the remaining proof.
    return !isAbsoluteNativePath(scratchPath);
  }

  function numericTimestamp(value) {
    var number = Number(value || 0);
    if (number > 0) return number;
    if (value instanceof Date) return value.getTime();
    return 0;
  }

  function fileOriginTimestamp(stat) {
    if (!stat) return 0;
    return numericTimestamp(stat.birthtimeMs)
      || numericTimestamp(stat.birthtime)
      || numericTimestamp(stat.ctimeMs)
      || numericTimestamp(stat.ctime)
      || numericTimestamp(stat.mtimeMs)
      || numericTimestamp(stat.mtime);
  }

  function isFreshFile(stat, armedAt, toleranceMs) {
    var timestamp = fileOriginTimestamp(stat);
    var threshold = Number(armedAt || 0) - Math.max(0, Number(toleranceMs || 0));
    return timestamp > 0 && timestamp >= threshold;
  }

  function statSignature(stat) {
    var modified = numericTimestamp(stat && stat.mtimeMs) || numericTimestamp(stat && stat.mtime);
    return String(Number(stat && stat.size || 0)) + "@" + String(modified);
  }

  function observeFileStability(previous, stat, now) {
    var observedAt = Number(now == null ? Date.now() : now);
    var prior = previous && typeof previous === "object" ? previous : {};
    var next = Object.assign({}, prior);
    var signature = statSignature(stat);
    var changed = signature !== String(prior.signature || "");

    next.firstSeenAt = Number(prior.firstSeenAt || observedAt);
    next.lastChangedAt = changed ? observedAt : Number(prior.lastChangedAt || observedAt);
    next.signature = signature;
    next.stablePolls = changed ? 1 : Number(prior.stablePolls || 0) + 1;
    return next;
  }

  function isFileStable(observation, now, options) {
    var values = options || {};
    var requiredPolls = Math.max(1, Number(values.requiredPolls || 2));
    var quietMs = Math.max(0, Number(values.quietMs || 0));
    var observedAt = Number(now == null ? Date.now() : now);
    if (!observation || Number(observation.stablePolls || 0) < requiredPolls) return false;
    return observedAt - Number(observation.lastChangedAt || observedAt) >= quietMs;
  }

  function errorCode(error) {
    var current = error;
    for (var depth = 0; current && depth < 4; depth += 1) {
      var code = String(current.code || "").toUpperCase();
      if (code) return code;
      current = current.cause;
    }
    return "";
  }

  function failureDisposition(error) {
    var code = errorCode(error);
    if (code === "VOICEOVER_NAMER_CANCELLED") return "cancel";
    if (["EBUSY", "EACCES", "EPERM", "ENOENT", "VOICEOVER_NAMER_NOT_READY"].indexOf(code) >= 0) {
      return "retry-file";
    }
    if (code === "VOICEOVER_NAMER_AMBIGUOUS") return "retry-context";
    return "retry-operation";
  }

  function retryDelayMs(failureCount, isLock) {
    var failures = Math.max(1, Number(failureCount || 1));
    if (isLock) return Math.min(5000, 500 * Math.pow(2, Math.min(failures - 1, 4)));
    return failures < 3 ? 3000 : failures < 8 ? 10000 : 30000;
  }

  return {
    CAPTURE_MARKERS: CAPTURE_MARKERS.slice(),
    captureFolderFromMediaPath: captureFolderFromMediaPath,
    isNativeDefaultRecordingName: isNativeDefaultRecordingName,
    buildProjectIdentity: buildProjectIdentity,
    isAbsoluteNativePath: isAbsoluteNativePath,
    hasCaptureMarker: hasCaptureMarker,
    isTrustedCapturePath: isTrustedCapturePath,
    fileOriginTimestamp: fileOriginTimestamp,
    isFreshFile: isFreshFile,
    statSignature: statSignature,
    observeFileStability: observeFileStability,
    isFileStable: isFileStable,
    failureDisposition: failureDisposition,
    retryDelayMs: retryDelayMs,
  };
});
