(function (root, factory) {
  "use strict";

  var api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.VoiceoverNamerTransaction = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function wait(milliseconds) {
    return new Promise(function (resolve) {
      setTimeout(resolve, milliseconds);
    });
  }

  async function exists(fs, nativePath) {
    try {
      await fs.lstat(nativePath);
      return true;
    } catch (error) {
      return false;
    }
  }

  function successResult(value) {
    return value === 0 || value === undefined || value === null;
  }

  function isTargetConflict(error) {
    var current = error;
    for (var depth = 0; current && depth < 4; depth += 1) {
      var code = String(current.code || "").toUpperCase();
      var message = String(current.message || current);
      if (code === "EEXIST") return true;
      if (/目标文件已存在|already exists|file exists/i.test(message)) return true;
      current = current.cause;
    }
    return false;
  }

  async function renameFile(fs, sourcePath, targetPath) {
    var result = await fs.rename(sourcePath, targetPath);
    if (!successResult(result)) {
      throw new Error("文件系统返回了意外结果: " + result);
    }
  }

  async function verifyLink(projectItem, expectedPath, samePath) {
    var actualPath = await projectItem.getMediaFilePath();
    var offline = await projectItem.isOffline();
    return !offline && samePath(actualPath, expectedPath);
  }

  async function waitForVerifiedLink(projectItem, expectedPath, samePath, delay) {
    for (var attempt = 0; attempt < 10; attempt += 1) {
      try {
        if (await verifyLink(projectItem, expectedPath, samePath)) return true;
      } catch (error) {}
      if (attempt < 9) await delay(150);
    }
    return false;
  }

  async function recoverLink(context, recoveryPath) {
    for (var attempt = 0; attempt < 3; attempt += 1) {
      if (await waitForVerifiedLink(context.projectItem, recoveryPath, context.samePath, context.delay)) return true;
      try {
        var relinked = await context.projectItem.changeMediaFilePath(recoveryPath, true);
        if (relinked) {
          await context.projectItem.refreshMedia();
          if (await waitForVerifiedLink(context.projectItem, recoveryPath, context.samePath, context.delay)) return true;
        }
      } catch (error) {}
      if (attempt < 2) await context.delay(150);
    }
    return false;
  }

  async function waitForVerifiedName(projectItem, expectedName, delay) {
    for (var attempt = 0; attempt < 8; attempt += 1) {
      if (String(projectItem.name || "") === String(expectedName)) return true;
      if (attempt < 7) await delay(80);
    }
    return false;
  }

  async function validateContext(validate) {
    if (typeof validate !== "function") return;
    var valid = await validate();
    if (valid === false) throw new Error("项目或序列已切换");
  }

  function notifyStage(listener, stage) {
    if (typeof listener !== "function") return;
    try {
      listener(stage);
    } catch (error) {}
  }

  function setProjectItemName(project, projectItem, name, undoLabel) {
    var success = false;
    project.lockedAccess(function () {
      success = project.executeTransaction(function (compoundAction) {
        compoundAction.addAction(projectItem.createSetNameAction(name));
      }, undoLabel || "Rename captured audio");
    });
    return success;
  }

  async function bestEffortRollback(context) {
    var warnings = [];
    if (!context.fileRenamed && !context.linkChanged && !context.itemNameChanged) return warnings;

    var sourceExists = await exists(context.fs, context.sourcePath);
    var targetExists = await exists(context.fs, context.targetPath);
    var preferTarget = false;

    if (context.fileRenamed) {
      try {
        if (targetExists && sourceExists) {
          preferTarget = true;
          warnings.push("旧路径与新路径同时存在；为避免误链到新生成的同名文件，保留本次事务的目标文件");
        } else if (targetExists && !sourceExists) {
          await renameFile(context.fs, context.targetPath, context.sourcePath);
          sourceExists = await exists(context.fs, context.sourcePath);
          targetExists = await exists(context.fs, context.targetPath);
        } else if (!sourceExists) {
          warnings.push("找不到可恢复的源文件或目标文件");
        }
      } catch (error) {
        warnings.push("磁盘文件名回滚失败: " + error.message);
        sourceExists = await exists(context.fs, context.sourcePath);
        targetExists = await exists(context.fs, context.targetPath);
      }
    }

    var recoveryPath = preferTarget ? context.targetPath : sourceExists ? context.sourcePath : targetExists ? context.targetPath : "";
    var recoveryName = recoveryPath === context.sourcePath ? context.originalName : context.targetName;
    if (recoveryPath === context.targetPath) {
      warnings.push("旧文件名未恢复，保留新文件并维持新路径");
    }

    if (recoveryPath) {
      var linkRecovered = await recoverLink(context, recoveryPath);
      if (!linkRecovered && recoveryPath === context.sourcePath && sourceExists && !targetExists) {
        var actualPath = "";
        try {
          actualPath = await context.projectItem.getMediaFilePath();
        } catch (error) {}
        if (context.samePath(actualPath, context.targetPath)) {
          try {
            await renameFile(context.fs, context.sourcePath, context.targetPath);
            sourceExists = false;
            targetExists = true;
            recoveryPath = context.targetPath;
            recoveryName = context.targetName;
            warnings.push("旧媒体路径无法恢复，已将文件重新放回当前新路径");
            linkRecovered = await recoverLink(context, recoveryPath);
          } catch (error) {
            warnings.push("恢复当前新路径失败: " + error.message);
          }
        }
      }
      if (!linkRecovered) warnings.push("恢复媒体路径后验证失败");

      try {
        if (String(context.projectItem.name || "") !== String(recoveryName)) {
          if (!setProjectItemName(context.project, context.projectItem, recoveryName, "Restore captured audio name")) {
            warnings.push("恢复素材名返回失败");
          } else if (!(await waitForVerifiedName(context.projectItem, recoveryName, context.delay))) {
            warnings.push("恢复素材名后验证失败");
          }
        }
      } catch (error) {
        warnings.push("恢复素材名失败: " + error.message);
      }
    } else {
      warnings.push("源文件和目标文件都不存在，未修改媒体路径");
    }

    return warnings;
  }

  async function renameAndRelink(options) {
    var fs = options.fs;
    var project = options.project;
    var projectItem = options.projectItem;
    var sourcePath = options.sourcePath;
    var targetPath = options.targetPath;
    var targetName = options.targetName;
    var samePath = options.samePath;
    var delay = options.delay || wait;
    var originalName = String(projectItem.name || "");
    var context = {
      fs: fs,
      project: project,
      projectItem: projectItem,
      sourcePath: sourcePath,
      targetPath: targetPath,
      targetName: targetName,
      originalName: originalName,
      samePath: samePath,
      delay: delay,
      fileRenamed: false,
      linkChanged: false,
      itemNameChanged: false,
    };

    try {
      await validateContext(options.validate);
      var currentMediaPath = await projectItem.getMediaFilePath();
      if (!samePath(currentMediaPath, sourcePath)) {
        throw new Error("Premiere 素材已不再指向候选源路径");
      }
      if (!(await exists(fs, sourcePath))) throw new Error("源文件不存在");
      if (await exists(fs, targetPath)) throw new Error("目标文件已存在");

      notifyStage(options.onStage, "rename");
      var canChange = await projectItem.canChangeMediaPath();
      if (!canChange) throw new Error("Premiere 不允许修改此素材的媒体路径");

      await validateContext(options.validate);
      await renameFile(fs, sourcePath, targetPath);
      context.fileRenamed = true;

      await validateContext(options.validate);
      notifyStage(options.onStage, "relink");
      var relinked = await projectItem.changeMediaFilePath(targetPath, true);
      if (!relinked) throw new Error("Premiere 重链接返回失败");
      context.linkChanged = true;

      await validateContext(options.validate);
      await projectItem.refreshMedia();
      if (!(await waitForVerifiedLink(projectItem, targetPath, samePath, delay))) {
        throw new Error("重链接后素材仍离线或路径不一致");
      }

      await validateContext(options.validate);
      if (!setProjectItemName(project, projectItem, targetName, "同步录音素材名")) {
        throw new Error("Premiere 素材名事务返回失败");
      }
      context.itemNameChanged = true;
      if (!(await waitForVerifiedName(projectItem, targetName, delay))) {
        throw new Error("Premiere 素材名验证失败");
      }

      await validateContext(options.validate);

      return {
        sourcePath: sourcePath,
        targetPath: targetPath,
        targetName: targetName,
        originalName: originalName,
      };
    } catch (error) {
      var rollbackWarnings = await bestEffortRollback(context);
      var wrapped = new Error(error && error.message ? error.message : String(error));
      wrapped.cause = error;
      if (error && error.code) wrapped.code = error.code;
      wrapped.rollbackWarnings = rollbackWarnings;
      throw wrapped;
    }
  }

  return {
    exists: exists,
    isTargetConflict: isTargetConflict,
    renameAndRelink: renameAndRelink,
    setProjectItemName: setProjectItemName,
  };
});
