(function (root, factory) {
  "use strict";

  var api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.VoiceoverNamerFolderReadiness = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  async function inspect(fs, nativePath) {
    if (!nativePath) return { valid: false, problem: "" };

    try {
      var stat = await fs.lstat(nativePath);
      if (!stat || typeof stat.isDirectory !== "function") {
        return {
          valid: false,
          problem: "无法确认所选路径是目录，请重新选择。",
        };
      }
      if (!stat.isDirectory()) {
        return {
          valid: false,
          problem: "所选路径是文件，请重新选择录音目录。",
        };
      }
      return { valid: true, problem: "" };
    } catch (error) {
      return {
        valid: false,
        problem: "已保存的录音目录不存在或无法访问，请重新选择。",
      };
    }
  }

  function isAlreadyExists(error) {
    var code = String(error && error.code || "").toUpperCase();
    return code === "EEXIST" || /already exists|file exists|已存在/i.test(String(error && error.message || error || ""));
  }

  function creationProblem(error) {
    var code = String(error && error.code || "").toUpperCase();
    if (code === "EACCES" || code === "EPERM") return "无法创建工程媒体目录：当前账户没有写入权限。";
    if (code === "ENOSPC") return "无法创建工程媒体目录：目标磁盘空间不足。";
    if (code === "EROFS") return "无法创建工程媒体目录：目标磁盘为只读状态。";
    return "无法创建工程媒体目录：文件系统拒绝了创建操作。";
  }

  function entryUrl(nativePath) {
    var path = String(nativePath).replace(/\\/g, "/");
    return "file:" + (/^[a-z]:\//i.test(path) ? "/" : "") + path;
  }

  function errorDetail(error) {
    return String(error && error.message || error || "未知错误")
      .replace(/[\r\n\t]+/g, " ").slice(0, 240);
  }

  async function ensureWithEntries(storage, nativePath) {
    var path = String(nativePath).replace(/\\/g, "/").replace(/\/+$/, "");
    var boundary = path.lastIndexOf("/");
    var name = path.slice(boundary + 1);
    if (boundary < 0 || !name || name === "." || name === "..") {
      throw new Error("工程媒体目录必须是绝对路径下的子文件夹。");
    }
    var parentPath = path.slice(0, boundary) || "/";
    if (/^[a-z]:$/i.test(parentPath)) parentPath += "/";
    var parent = await storage.getEntryWithUrl(entryUrl(parentPath));
    if (!parent || parent.isFolder !== true) throw new Error("工程所在路径不是文件夹。");
    var existing = null;
    try { existing = await parent.getEntry(name); } catch (error) { /* Creation verifies access below. */ }
    if (existing) {
      if (existing.isFolder !== true) throw new Error("工程媒体目录被同名文件占用，不会覆盖该文件。");
      return { valid: true, created: false, problem: "" };
    }
    var creationError = null;
    try { await parent.createFolder(name); } catch (error) { creationError = error; }
    // Re-read even after an error: Premiere or another refresh may have created it concurrently.
    var verified;
    try { verified = await parent.getEntry(name); } catch (error) { throw creationError || error; }
    if (!verified || verified.isFolder !== true) {
      throw creationError || new Error("工程媒体目录创建后仍不是可访问的文件夹。");
    }
    return { valid: true, created: !creationError, problem: "" };
  }

  async function ensure(fs, nativePath, storage) {
    if (!nativePath) {
      return { valid: false, created: false, problem: "请先保存 Premiere 工程。" };
    }

    var entryError = null;
    if (storage && typeof storage.getEntryWithUrl === "function") {
      try { return await ensureWithEntries(storage, nativePath); }
      catch (error) { entryError = error; }
    }

    var current = await inspect(fs, nativePath);
    if (current.valid) return { valid: true, created: false, problem: "" };

    if (!fs || typeof fs.mkdir !== "function") {
      return {
        valid: false,
        created: false,
        problem: "当前 UXP 无法创建工程媒体目录。",
      };
    }

    var created = false;
    try {
      await fs.mkdir(nativePath);
      created = true;
    } catch (error) {
      if (!isAlreadyExists(error)) {
        return {
          valid: false,
          created: false,
          problem: creationProblem(error) + " 目标：" + nativePath + (entryError
            ? " UXP：" + errorDetail(entryError) + "；fs：" + errorDetail(error)
            : (!(error && error.code) ? " " + errorDetail(error) : "")),
        };
      }
    }

    var verified = await inspect(fs, nativePath);
    if (!verified.valid) {
      return {
        valid: false,
        created: false,
        problem: "工程媒体目录创建后仍无法访问。",
      };
    }
    return { valid: true, created: created, problem: "" };
  }

  return {
    inspect: inspect,
    ensure: ensure,
  };
});
