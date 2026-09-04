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
    if (code === "EACCES" || code === "EPERM") return "无法创建工程录音目录：当前账户没有写入权限。";
    if (code === "ENOSPC") return "无法创建工程录音目录：目标磁盘空间不足。";
    if (code === "EROFS") return "无法创建工程录音目录：目标磁盘为只读状态。";
    return "无法创建工程录音目录：文件系统拒绝了创建操作。";
  }

  async function ensure(fs, nativePath) {
    if (!nativePath) {
      return { valid: false, created: false, problem: "请先保存 Premiere 工程。" };
    }

    var current = await inspect(fs, nativePath);
    if (current.valid) return { valid: true, created: false, problem: "" };

    if (!fs || typeof fs.mkdir !== "function") {
      return {
        valid: false,
        created: false,
        problem: "当前 UXP 无法创建工程录音目录。",
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
          problem: creationProblem(error),
        };
      }
    }

    var verified = await inspect(fs, nativePath);
    if (!verified.valid) {
      return {
        valid: false,
        created: false,
        problem: "工程录音目录创建后仍无法访问。",
      };
    }
    return { valid: true, created: created, problem: "" };
  }

  return {
    inspect: inspect,
    ensure: ensure,
  };
});
