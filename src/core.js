(function (root, factory) {
  "use strict";

  var api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.VoiceoverNamerCore = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var INVALID_FILE_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;
  var RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;
  var RECORDING_ID_NAME = /^(.*)-([0-9a-f]{32})\.wav$/i;
  var UUID_V4_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  var RECORDING_ID = /^[0-9a-f]{32}$/i;
  var PROJECT_TIMESTAMP_NAME = /^(.*)-(\d{6,})-(\d{8})-(\d{6})\.wav$/i;
  var PROJECT_NAME = /^(.*)-(\d{6,})\.wav$/i;
  var LEGACY_TRACK_NAME = /^(.*)-A(\d+)-(\d+)-(\d{8})-(\d{6})\.wav$/i;

  function pad(value, width) {
    return String(value).padStart(width, "0");
  }

  function truncateCharacters(value, maxLength) {
    var characters = Array.from(String(value));
    if (characters.length <= maxLength) return characters.join("");
    return characters.slice(0, maxLength).join("");
  }

  function sanitizeSegment(value, fallback, maxLength) {
    var text = String(value == null ? "" : value);
    if (typeof text.normalize === "function") text = text.normalize("NFC");
    text = text.replace(INVALID_FILE_CHARS, "_");
    text = text.replace(/\s+/g, " ").trim();
    text = text.replace(/[. ]+$/g, "");
    text = text.replace(/_+/g, "_");
    text = truncateCharacters(text, maxLength || 80);
    text = text.replace(/[. ]+$/g, "");
    if (!text) text = fallback || "未命名项目";
    if (RESERVED_NAMES.test(text)) text = "_" + text;
    return text;
  }

  function fileNameFromPath(nativePath) {
    var text = String(nativePath || "");
    var index = Math.max(text.lastIndexOf("\\"), text.lastIndexOf("/"));
    return index >= 0 ? text.slice(index + 1) : text;
  }

  function extensionOf(fileName) {
    var base = fileNameFromPath(fileName);
    var index = base.lastIndexOf(".");
    return index > 0 ? base.slice(index) : "";
  }

  function stemOf(fileName) {
    var base = fileNameFromPath(fileName);
    var extension = extensionOf(base);
    return extension ? base.slice(0, -extension.length) : base;
  }

  function projectStem(projectName) {
    var base = fileNameFromPath(projectName || "");
    if (/\.prproj$/i.test(base)) base = base.slice(0, -7);
    return sanitizeSegment(base, "未命名项目", 80);
  }

  function secureRandomSource(source) {
    var candidate = source;
    if (candidate === undefined && typeof globalThis !== "undefined") candidate = globalThis;
    if (candidate && candidate.crypto) candidate = candidate.crypto;
    if (!candidate) return null;
    if (typeof candidate.randomUUID === "function" || typeof candidate.getRandomValues === "function") {
      return candidate;
    }
    return null;
  }

  function secureRandomAvailable(source) {
    return !!secureRandomSource(source);
  }

  function bytesToHex(bytes) {
    var output = "";
    for (var index = 0; index < bytes.length; index += 1) {
      output += Number(bytes[index]).toString(16).padStart(2, "0");
    }
    return output;
  }

  function createRecordingId(source) {
    var cryptoApi = secureRandomSource(source);
    if (!cryptoApi) {
      throw new Error("当前 UXP 不支持安全随机源，已停止生成唯一录音名");
    }

    if (typeof cryptoApi.randomUUID === "function") {
      var uuid = String(cryptoApi.randomUUID());
      if (!UUID_V4_TEXT.test(uuid)) {
        throw new Error("安全随机源返回了无效的 UUIDv4，已停止生成唯一录音名");
      }
      return uuid.replace(/-/g, "").toLowerCase();
    }

    var bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    return bytesToHex(bytes);
  }

  function normalizeRecordingId(recordingId) {
    var value = String(recordingId == null ? "" : recordingId).replace(/-/g, "");
    if (!RECORDING_ID.test(value)) {
      throw new Error("录音 ID 必须是 32 位十六进制 UUID");
    }
    return value.toLowerCase();
  }

  function buildRecordingName(options) {
    var project = projectStem(options.projectName);
    var recordingId = normalizeRecordingId(options.recordingId);
    return project + "-" + recordingId + ".wav";
  }

  function isGlobalRecordingName(fileName) {
    return RECORDING_ID_NAME.test(fileNameFromPath(fileName));
  }

  function createAvailableRecordingName(options) {
    var existing = new Set();
    (options.existingNames || []).forEach(function (name) {
      existing.add(fileNameFromPath(name).toLowerCase());
    });
    var maximumAttempts = Number(options.maxAttempts || 1000);
    if (!Number.isInteger(maximumAttempts) || maximumAttempts < 1) {
      throw new Error("冲突重试次数必须是大于或等于 1 的整数");
    }

    for (var attempt = 0; attempt < maximumAttempts; attempt += 1) {
      var recordingId = createRecordingId(options.randomSource);
      var targetName = buildRecordingName({
        projectName: options.projectName,
        recordingId: recordingId,
      });
      if (!existing.has(targetName.toLowerCase())) {
        return { recordingId: recordingId, targetName: targetName, attempts: attempt + 1 };
      }
    }
    throw new Error("无法生成未被占用的唯一录音 ID");
  }

  function managedResult(project, sequence, date, time, format, trackLabel, recordingId) {
    return {
      project: project,
      sequence: Number(sequence),
      recordingId: recordingId || "",
      date: date,
      time: time,
      format: format,
      trackLabel: trackLabel || "",
    };
  }

  function parseManagedName(fileName, expectedProject) {
    var base = fileNameFromPath(fileName);
    var idMatch = base.match(RECORDING_ID_NAME);
    if (idMatch) {
      return managedResult(idMatch[1], 0, "", "", "global-id", "", idMatch[2].toLowerCase());
    }
    if (expectedProject != null) {
      var project = projectStem(expectedProject);
      var prefix = project + "-";
      if (base.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) return null;
      var remainder = base.slice(prefix.length);
      var projectMatch = remainder.match(/^(\d{6,})\.wav$/i);
      if (projectMatch) {
        return managedResult(project, projectMatch[1], "", "", "project");
      }
      var projectTimestampMatch = remainder.match(/^(\d{6,})-(\d{8})-(\d{6})\.wav$/i);
      if (projectTimestampMatch) {
        return managedResult(
          project,
          projectTimestampMatch[1],
          projectTimestampMatch[2],
          projectTimestampMatch[3],
          "project-timestamp"
        );
      }
      var exactLegacyMatch = remainder.match(/^A(\d+)-(\d+)-(\d{8})-(\d{6})\.wav$/i);
      if (exactLegacyMatch) {
        return managedResult(
          project,
          exactLegacyMatch[2],
          exactLegacyMatch[3],
          exactLegacyMatch[4],
          "legacy-track",
          "A" + pad(Number(exactLegacyMatch[1]), 2)
        );
      }
      return null;
    }

    var match = base.match(PROJECT_TIMESTAMP_NAME);
    if (match) {
      return managedResult(match[1], match[2], match[3], match[4], "project-timestamp");
    }
    var legacyMatch = base.match(LEGACY_TRACK_NAME);
    if (legacyMatch) {
      return managedResult(
        legacyMatch[1],
        legacyMatch[3],
        legacyMatch[4],
        legacyMatch[5],
        "legacy-track",
        "A" + pad(Number(legacyMatch[2]), 2)
      );
    }
    var projectMatch = base.match(PROJECT_NAME);
    if (projectMatch) {
      return managedResult(projectMatch[1], projectMatch[2], "", "", "project");
    }
    return null;
  }

  function splitNativePath(nativePath) {
    var text = String(nativePath || "");
    var winIndex = text.lastIndexOf("\\");
    var posixIndex = text.lastIndexOf("/");
    var index = Math.max(winIndex, posixIndex);
    var separator = winIndex > posixIndex ? "\\" : "/";
    return {
      dir: index === 0 && separator === "/" ? "/" : (index >= 0 ? text.slice(0, index) : ""),
      base: index >= 0 ? text.slice(index + 1) : text,
      separator: separator,
    };
  }

  function joinNativePath(directory, fileName, separator) {
    var rawDirectory = String(directory || "");
    var isRootDirectory = rawDirectory.length > 0 && rawDirectory.split("").every(function (character) {
      return character === "/";
    });
    var dir = isRootDirectory ? "/" : rawDirectory.replace(/[\\/]+$/g, "");
    if (!dir) return String(fileName || "");
    if (dir === "/") return "/" + String(fileName || "");
    return dir + (separator || (dir.indexOf("\\") >= 0 ? "\\" : "/")) + fileName;
  }

  function recordingDirectoryFromProjectPath(projectPath) {
    var nativePath = String(projectPath || "").trim();
    if (!nativePath || nativePathPlatform(nativePath) === "relative") return "";
    var parts = splitNativePath(nativePath);
    if (!parts.dir || !parts.base) return "";
    return joinNativePath(parts.dir, "录音", parts.separator);
  }

  function nativePathPlatform(nativePath) {
    var text = String(nativePath || "");
    if (/^[a-z]:[\\/]/i.test(text) || /^\\\\/.test(text)) return "windows";
    if (text.indexOf("//") === 0) return "windows";
    if (/^\//.test(text)) return "posix";
    return "relative";
  }

  function normalizePathSegments(text, absolute, isUnc) {
    var segments = String(text || "").split("/");
    var output = [];
    for (var index = 0; index < segments.length; index += 1) {
      var segment = segments[index];
      if (!segment || segment === ".") continue;
      if (segment === "..") {
        var protectsDrive = output.length === 1 && /^[a-z]:$/i.test(output[0]);
        if (output.length && output[output.length - 1] !== ".." && !protectsDrive) {
          output.pop();
        } else if (!absolute) {
          output.push("..");
        }
        continue;
      }
      output.push(segment);
    }
    if (isUnc) return "//" + output.join("/");
    if (absolute) return "/" + output.join("/");
    return output.join("/");
  }

  function normalizePathForComparison(nativePath) {
    var raw = String(nativePath || "").replace(/\\/g, "/");
    var platform = nativePathPlatform(nativePath);
    var isUnc = platform === "windows" && raw.indexOf("//") === 0;
    var isAbsolute = platform !== "relative";
    var text = normalizePathSegments(raw, isAbsolute, isUnc);
    if (platform === "windows" && !isUnc) text = text.slice(1);
    if (platform === "windows") text = text.toLowerCase();
    return text;
  }

  function sameNativePath(left, right) {
    return normalizePathForComparison(left) === normalizePathForComparison(right);
  }

  function isPathInside(nativePath, directory) {
    var path = normalizePathForComparison(nativePath);
    var root = normalizePathForComparison(directory);
    if (!root) return false;
    if (root === "/") return path.indexOf("/") === 0;
    return path === root || path.indexOf(root + "/") === 0;
  }

  function isWaveFile(nativePath) {
    return /\.wav$/i.test(fileNameFromPath(nativePath));
  }

  return {
    sanitizeSegment: sanitizeSegment,
    fileNameFromPath: fileNameFromPath,
    extensionOf: extensionOf,
    stemOf: stemOf,
    projectStem: projectStem,
    secureRandomAvailable: secureRandomAvailable,
    createRecordingId: createRecordingId,
    buildRecordingName: buildRecordingName,
    isGlobalRecordingName: isGlobalRecordingName,
    createAvailableRecordingName: createAvailableRecordingName,
    parseManagedName: parseManagedName,
    splitNativePath: splitNativePath,
    joinNativePath: joinNativePath,
    recordingDirectoryFromProjectPath: recordingDirectoryFromProjectPath,
    nativePathPlatform: nativePathPlatform,
    normalizePathForComparison: normalizePathForComparison,
    sameNativePath: sameNativePath,
    isPathInside: isPathInside,
    isWaveFile: isWaveFile,
  };
});
