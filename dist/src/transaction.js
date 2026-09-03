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

  function uniqueTrackItems(trackItems) {
    var unique = [];
    var seen = new Set();
    (trackItems || []).forEach(function (trackItem) {
      if (!trackItem || seen.has(trackItem)) return;
      seen.add(trackItem);
      unique.push(trackItem);
    });
    return unique;
  }

  async function captureTrackItemNames(trackItems) {
    var unique = uniqueTrackItems(trackItems);
    if (!unique.length) throw new Error("未找到可同步名称的 Premiere 时间线音频片段");

    var snapshots = [];
    for (var index = 0; index < unique.length; index += 1) {
      var trackItem = unique[index];
      if (typeof trackItem.getName !== "function" || typeof trackItem.createSetNameAction !== "function") {
        throw new Error("Premiere 时间线片段不支持名称读取或改名 API");
      }
      var originalName;
      try {
        originalName = await trackItem.getName();
      } catch (error) {
        throw new Error("无法读取 Premiere 时间线片段名称: " + (error.message || error));
      }
      if (originalName === undefined || originalName === null) {
        throw new Error("Premiere 时间线片段返回了无效名称");
      }
      snapshots.push({
        trackItem: trackItem,
        originalName: String(originalName),
      });
    }
    return snapshots;
  }

  function addRequiredNameAction(compoundAction, owner, name, description) {
    var action;
    try {
      action = owner.createSetNameAction(name);
    } catch (error) {
      throw new Error(description + "改名动作创建失败: " + (error.message || error));
    }
    if (!action) throw new Error(description + "改名动作不可用");
    var added;
    try {
      added = compoundAction.addAction(action);
    } catch (error) {
      throw new Error(description + "改名动作加入事务失败: " + (error.message || error));
    }
    if (added === false) throw new Error(description + "改名动作加入事务失败");
  }

  function ensureNameTransactionSupport(project, projectItem) {
    if (!project || typeof project.lockedAccess !== "function" || typeof project.executeTransaction !== "function") {
      throw new Error("Premiere 项目不支持名称事务 API");
    }
    if (!projectItem || typeof projectItem.createSetNameAction !== "function") {
      throw new Error("Premiere 素材不支持改名 API");
    }
  }

  function setProjectAndTrackItemNames(project, projectItem, projectItemName, trackItemNames, undoLabel) {
    ensureNameTransactionSupport(project, projectItem);

    var success = false;
    project.lockedAccess(function () {
      success = project.executeTransaction(function (compoundAction) {
        if (!compoundAction || typeof compoundAction.addAction !== "function") {
          throw new Error("Premiere 名称事务不可用");
        }
        if (projectItemName !== undefined && projectItemName !== null) {
          addRequiredNameAction(compoundAction, projectItem, projectItemName, "素材");
        }
        (trackItemNames || []).forEach(function (entry) {
          if (!entry || !entry.trackItem || typeof entry.trackItem.createSetNameAction !== "function") {
            throw new Error("Premiere 时间线片段不支持改名 API");
          }
          addRequiredNameAction(compoundAction, entry.trackItem, entry.name, "时间线片段");
        });
      }, undoLabel || "Rename captured audio");
    });
    return success;
  }

  function setProjectItemName(project, projectItem, name, undoLabel) {
    return setProjectAndTrackItemNames(project, projectItem, name, [], undoLabel);
  }

  async function waitForVerifiedTrackItemNames(trackItemNames, delay) {
    for (var attempt = 0; attempt < 8; attempt += 1) {
      var allMatch = true;
      for (var index = 0; index < (trackItemNames || []).length; index += 1) {
        var entry = trackItemNames[index];
        try {
          var actualName = await entry.trackItem.getName();
          if (String(actualName) !== String(entry.name)) allMatch = false;
        } catch (error) {
          allMatch = false;
        }
      }
      if (allMatch) return true;
      if (attempt < 7) await delay(80);
    }
    return false;
  }

  async function restoreNames(project, projectItem, originalName, trackItemNames, delay) {
    var warnings = [];
    var projectItemRestoreName = null;
    var trackItemRestoreNames = [];

    try {
      if (String(projectItem.name || "") !== String(originalName)) {
        projectItemRestoreName = originalName;
      }
    } catch (error) {
      projectItemRestoreName = originalName;
    }

    for (var index = 0; index < (trackItemNames || []).length; index += 1) {
      var entry = trackItemNames[index];
      try {
        var currentName = await entry.trackItem.getName();
        if (String(currentName) !== String(entry.originalName)) {
          trackItemRestoreNames.push({ trackItem: entry.trackItem, name: entry.originalName });
        }
      } catch (error) {
        trackItemRestoreNames.push({ trackItem: entry.trackItem, name: entry.originalName });
      }
    }

    if (projectItemRestoreName === null && !trackItemRestoreNames.length) return warnings;

    try {
      if (!setProjectAndTrackItemNames(
        project,
        projectItem,
        projectItemRestoreName,
        trackItemRestoreNames,
        "恢复录音素材和时间线片段名"
      )) {
        warnings.push("恢复素材名和时间线片段名返回失败");
        return warnings;
      }
      if (projectItemRestoreName !== null && !(await waitForVerifiedName(projectItem, originalName, delay))) {
        warnings.push("恢复素材名后验证失败");
      }
      var expectedTrackItemNames = (trackItemNames || []).map(function (entry) {
        return { trackItem: entry.trackItem, name: entry.originalName };
      });
      if (!(await waitForVerifiedTrackItemNames(expectedTrackItemNames, delay))) {
        warnings.push("恢复时间线片段名后验证失败");
      }
    } catch (error) {
      warnings.push("恢复素材名和时间线片段名失败: " + (error.message || error));
    }

    return warnings;
  }

  async function synchronizeNames(options) {
    var project = options.project;
    var projectItem = options.projectItem;
    var targetName = String(options.targetName || "");
    var delay = options.delay || wait;
    var originalName = String(projectItem.name || "");
    var trackItemNames = [];

    try {
      if (!targetName) throw new Error("缺少要同步的录音名称");
      await validateContext(options.validate);
      ensureNameTransactionSupport(project, projectItem);
      if (options.expectedMediaPath && typeof options.samePath === "function") {
        var currentMediaPath = await projectItem.getMediaFilePath();
        if (!options.samePath(currentMediaPath, options.expectedMediaPath)) {
          throw new Error("Premiere 素材已不再指向待核验的媒体路径");
        }
      }
      trackItemNames = await captureTrackItemNames(options.trackItems);

      var projectItemTargetName = originalName === targetName ? null : targetName;
      var changedTrackItemNames = trackItemNames.filter(function (entry) {
        return entry.originalName !== targetName;
      }).map(function (entry) {
        return { trackItem: entry.trackItem, name: targetName };
      });
      if (projectItemTargetName === null && !changedTrackItemNames.length) {
        return {
          changed: false,
          targetName: targetName,
          originalName: originalName,
        };
      }

      await validateContext(options.validate);
      if (!setProjectAndTrackItemNames(
        project,
        projectItem,
        projectItemTargetName,
        changedTrackItemNames,
        "修复录音素材和时间线片段名"
      )) {
        throw new Error("Premiere 素材和时间线片段名称事务返回失败");
      }

      if (!(await waitForVerifiedName(projectItem, targetName, delay))) {
        throw new Error("Premiere 素材名验证失败");
      }
      var targetTrackItemNames = trackItemNames.map(function (entry) {
        return { trackItem: entry.trackItem, name: targetName };
      });
      if (!(await waitForVerifiedTrackItemNames(targetTrackItemNames, delay))) {
        throw new Error("Premiere 时间线片段名验证失败");
      }
      await validateContext(options.validate);
      if (options.expectedMediaPath && typeof options.samePath === "function") {
        var verifiedMediaPath = await projectItem.getMediaFilePath();
        if (!options.samePath(verifiedMediaPath, options.expectedMediaPath)) {
          throw new Error("名称同步期间 Premiere 素材路径发生变化");
        }
      }

      return {
        changed: true,
        targetName: targetName,
        originalName: originalName,
      };
    } catch (error) {
      var rollbackWarnings = trackItemNames.length
        ? await restoreNames(project, projectItem, originalName, trackItemNames, delay)
        : [];
      var wrapped = new Error(error && error.message ? error.message : String(error));
      wrapped.cause = error;
      if (error && error.code) wrapped.code = error.code;
      wrapped.rollbackWarnings = rollbackWarnings;
      throw wrapped;
    }
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
    var recoveryName = recoveryPath === context.targetPath ? context.targetName : context.originalName;
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
        var trackItemRestoreNames = (context.trackItemNames || []).map(function (entry) {
          return { trackItem: entry.trackItem, name: entry.originalName };
        });
        var namesNeedRestore = String(context.projectItem.name || "") !== String(recoveryName);
        for (var nameIndex = 0; nameIndex < trackItemRestoreNames.length; nameIndex += 1) {
          try {
            var currentTrackItemName = await trackItemRestoreNames[nameIndex].trackItem.getName();
            if (String(currentTrackItemName) !== String(trackItemRestoreNames[nameIndex].name)) namesNeedRestore = true;
          } catch (error) {
            namesNeedRestore = true;
          }
        }
        if (namesNeedRestore) {
          if (!setProjectAndTrackItemNames(
            context.project,
            context.projectItem,
            recoveryName,
            trackItemRestoreNames,
            "Restore captured audio names"
          )) {
            warnings.push("恢复素材名和时间线片段名返回失败");
          } else {
            if (!(await waitForVerifiedName(context.projectItem, recoveryName, context.delay))) {
              warnings.push("恢复素材名后验证失败");
            }
            if (!(await waitForVerifiedTrackItemNames(trackItemRestoreNames, context.delay))) {
              warnings.push("恢复时间线片段名后验证失败");
            }
          }
        }
      } catch (error) {
        warnings.push("恢复素材名和时间线片段名失败: " + error.message);
      }
    } else {
      warnings.push("源文件和目标文件都不存在，未修改媒体路径、素材名或时间线片段名");
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
      trackItemNames: [],
    };

    try {
      await validateContext(options.validate);
      ensureNameTransactionSupport(project, projectItem);
      context.trackItemNames = await captureTrackItemNames(options.trackItems);
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
      var targetTrackItemNames = context.trackItemNames.map(function (entry) {
        return { trackItem: entry.trackItem, name: targetName };
      });
      if (!setProjectAndTrackItemNames(project, projectItem, targetName, targetTrackItemNames, "同步录音素材和时间线片段名")) {
        throw new Error("Premiere 素材和时间线片段名称事务返回失败");
      }
      context.itemNameChanged = true;
      if (!(await waitForVerifiedName(projectItem, targetName, delay))) {
        throw new Error("Premiere 素材名验证失败");
      }
      if (!(await waitForVerifiedTrackItemNames(targetTrackItemNames, delay))) {
        throw new Error("Premiere 时间线片段名验证失败");
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
    synchronizeNames: synchronizeNames,
    setProjectItemName: setProjectItemName,
  };
});
