(function (root, factory) {
  "use strict";

  var api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.VoiceoverNamerState = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var SCHEMA_VERSION = 4;
  var LEGACY_SCHEMA_VERSION = 1;
  var PREVIOUS_SCHEMA_VERSION = 3;
  var MIGRATABLE_SCHEMA_VERSIONS = [1, 2, 3];
  var HISTORY_LIMIT = 200;
  var RECORDING_ID = /^[0-9a-f]{32}$/i;

  function createState(projectIdentity) {
    return {
      schemaVersion: SCHEMA_VERSION,
      projectIdentity: String(projectIdentity || ""),
      watchFolder: "",
      autoStart: false,
      history: [],
    };
  }

  function isObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function isSupportedSchema(value) {
    return [1, 2, 3, SCHEMA_VERSION].indexOf(value) >= 0;
  }

  function needsMigration(raw) {
    return isObject(raw) && MIGRATABLE_SCHEMA_VERSIONS.indexOf(raw.schemaVersion) >= 0;
  }

  function safeString(value, fallback) {
    if (typeof value === "string") return value;
    if (value == null) return fallback || "";
    return String(value);
  }

  function recordingIdFor(entry) {
    var value = safeString(entry && entry.recordingId, "").replace(/-/g, "");
    return RECORDING_ID.test(value) ? value.toLowerCase() : "";
  }

  function normalizeHistoryEntry(entry, index, sourceVersion, fallbackAt) {
    if (!isObject(entry)) return null;
    var at = safeString(entry.at, fallbackAt || new Date(0).toISOString());
    var normalized = sourceVersion < SCHEMA_VERSION ? Object.assign({}, entry) : {};
    normalized.recordingId = recordingIdFor(entry);
    normalized.sourcePath = safeString(entry.sourcePath, "");
    normalized.targetPath = safeString(entry.targetPath, "");
    normalized.at = at;
    return normalized;
  }

  function normalizeHistory(rawHistory, sourceVersion, fallbackAt) {
    if (!Array.isArray(rawHistory)) return [];
    return rawHistory
      .map(function (entry, index) {
        return normalizeHistoryEntry(entry, index, sourceVersion, fallbackAt);
      })
      .filter(function (entry) {
        return entry !== null;
      })
      .slice(-HISTORY_LIMIT);
  }

  function hydrateState(raw, projectIdentity) {
    var identity = String(projectIdentity || "");
    if (!isObject(raw) || !isSupportedSchema(raw.schemaVersion)) return createState(identity);
    if (raw.projectIdentity && String(raw.projectIdentity) !== identity) return createState(identity);

    var state = createState(identity);
    state.watchFolder = typeof raw.watchFolder === "string"
      ? raw.watchFolder
      : typeof raw.watchFolderPath === "string" ? raw.watchFolderPath : "";
    state.autoStart = raw.autoStart === true;
    state.history = normalizeHistory(raw.history, raw.schemaVersion, raw.updatedAt);
    return state;
  }

  function cloneState(state) {
    if (!isObject(state)) return createState("");
    return hydrateState(JSON.parse(JSON.stringify(state)), state.projectIdentity);
  }

  function commitRecording(state, recording) {
    var next = cloneState(state);
    var value = recording && isObject(recording) ? recording : {};
    var recordingId = safeString(value.recordingId, "").replace(/-/g, "");
    if (!RECORDING_ID.test(recordingId)) {
      throw new Error("commitRecording 必须提供合法的 32 位录音 ID");
    }
    var at = safeString(value.at, new Date().toISOString());
    var sourcePath = safeString(value.sourcePath, "");
    var targetPath = safeString(value.targetPath, "");
    next.history.push({
      recordingId: recordingId.toLowerCase(),
      sourcePath: sourcePath,
      targetPath: targetPath,
      at: at,
    });
    next.history = next.history.slice(-HISTORY_LIMIT);
    return next;
  }

  function withSettings(state, settings) {
    var next = cloneState(state);
    var values = isObject(settings) ? settings : {};
    if (Object.prototype.hasOwnProperty.call(values, "watchFolder")) {
      next.watchFolder = String(values.watchFolder || "");
    } else if (Object.prototype.hasOwnProperty.call(values, "watchFolderPath")) {
      next.watchFolder = String(values.watchFolderPath || "");
    }
    if (Object.prototype.hasOwnProperty.call(values, "autoStart")) {
      next.autoStart = values.autoStart === true;
    }
    return next;
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    LEGACY_SCHEMA_VERSION: LEGACY_SCHEMA_VERSION,
    PREVIOUS_SCHEMA_VERSION: PREVIOUS_SCHEMA_VERSION,
    MIGRATABLE_SCHEMA_VERSIONS: MIGRATABLE_SCHEMA_VERSIONS.slice(),
    HISTORY_LIMIT: HISTORY_LIMIT,
    createState: createState,
    needsMigration: needsMigration,
    hydrateState: hydrateState,
    commitRecording: commitRecording,
    withSettings: withSettings,
  };
});
