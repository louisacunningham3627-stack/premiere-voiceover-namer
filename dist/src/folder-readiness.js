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

  return {
    inspect: inspect,
  };
});
