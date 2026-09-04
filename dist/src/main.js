(function () {
  "use strict";

  var uxp = require("uxp");
  var ppro = require("premierepro");
  var fs = require("fs");
  var Core = globalThis.VoiceoverNamerCore;
  var State = globalThis.VoiceoverNamerState;
  var PanelState = globalThis.VoiceoverNamerPanelState;
  var FolderReadiness = globalThis.VoiceoverNamerFolderReadiness;
  var MediaCandidates = globalThis.VoiceoverNamerMediaCandidates;
  var MonitoringPolicy = globalThis.VoiceoverNamerMonitoringPolicy;
  var Transaction = globalThis.VoiceoverNamerTransaction;
  var Coordination = globalThis.VoiceoverNamerCoordination;

  var POLL_INTERVAL_MS = 1200;
  var DISCOVERY_TRACK_SCAN_MS = 2500;
  var LEARNED_TRACK_FALLBACK_MS = 10000;
  var REQUIRED_STABLE_POLLS = 3;
  var STABLE_QUIET_MS = 3000;
  var FRESH_FILE_TOLERANCE_MS = 2000;
  var PENDING_WARNING_MS = 60000;
  var LOCK_WARNING_RETRIES = 8;
  var MAX_TARGET_CONFLICT_RETRIES = 8;
  var UNMATCHED_RETRY_MS = 10000;
  var UNMATCHED_LONG_RETRY_MS = 30000;
  var LOG_LIMIT = 20;
  var EXAMPLE_RECORDING_ID = "7f3c9a2e4b1d48f0a6c1e8d2b9f04a77";

  var context = null;
  var projectState = null;
  var monitoring = false;
  var startingMonitoring = false;
  var timer = null;
  var scheduledTick = null;
  var tickInFlight = false;
  var manualScanInFlight = false;
  var manualScanExecuting = false;
  var seenPaths = new Set();
  var pendingFiles = new Map();
  var watchedFolderBaseline = new Set();
  var unmatchedFolderFiles = new Map();
  var normalizedNameChecks = new Set();
  var eventScanRequested = false;
  var trackListeners = [];
  var globalImportListenerAttached = false;
  var globalImportEventName = null;
  var activeSequenceIdentity = "";
  var armedAtMs = 0;
  var lastTrackScanAt = 0;
  var userPaused = false;
  var sessionMetrics = { processed: 0, errors: 0 };
  var contextRefreshCount = 0;
  var contextRefreshGeneration = 0;
  var panelErrorMessage = "";
  var currentJob = null;
  var primaryAction = "";
  var watchFolderValid = false;
  var watchFolderProblem = "";
  var monitorGuard = Coordination.createGenerationGuard();
  var lifecycleGuard = Coordination.createGenerationGuard();
  var operationQueue = Coordination.createOperationQueue();
  var wired = false;
  var panelVisible = false;

  function element(id) {
    return document.getElementById(id);
  }

  function nowTime() {
    var date = new Date();
    return String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0") + ":" + String(date.getSeconds()).padStart(2, "0");
  }

  function addLog(kind, message) {
    var list = element("activityLog");
    if (!list) return;
    var empty = list.querySelector(".activity-empty");
    if (empty && empty.parentNode) empty.parentNode.removeChild(empty);

    var item = document.createElement("li");
    item.className = "activity-item activity-item--" + kind;
    var time = document.createElement("span");
    time.className = "activity-time";
    time.textContent = nowTime();
    item.appendChild(time);
    item.appendChild(document.createTextNode(String(message)));
    list.insertBefore(item, list.firstChild);

    while (list.children.length > LOG_LIMIT) list.removeChild(list.lastChild);
  }

  function clearLog() {
    var list = element("activityLog");
    if (!list) return;
    list.textContent = "";
    var empty = document.createElement("li");
    empty.className = "activity-empty";
    empty.textContent = "暂无记录";
    list.appendChild(empty);
  }

  function setStatus(kind, text) {
    var host = element("monitorStatus");
    if (host) host.className = "monitor-status monitor-status--" + kind;
    if (element("monitorStatusText")) element("monitorStatusText").textContent = text;
  }

  function setText(id, text, title) {
    var node = element(id);
    if (!node) return;
    node.textContent = text;
    node.title = title || text;
  }

  function projectIsSaved() {
    return !!(context && context.statePath);
  }

  function recordingFolderForCandidate(candidate) {
    var project = candidate && candidate.project ? candidate.project : context && context.project;
    return Core.recordingDirectoryFromProjectPath(project && project.path ? project.path : "");
  }

  function isNormalizedRecording(candidate) {
    if (!candidate || !Core.isGlobalRecordingName(candidate.mediaPath)) return false;
    var recordingFolder = recordingFolderForCandidate(candidate);
    if (!recordingFolder) return false;
    return Core.sameNativePath(Core.splitNativePath(candidate.mediaPath).dir, recordingFolder);
  }

  function resetWatchFolderValidation() {
    watchFolderValid = false;
    watchFolderProblem = "";
  }

  function applyWatchFolderInspection(inspection) {
    watchFolderValid = inspection && inspection.valid === true;
    watchFolderProblem = inspection && inspection.problem ? inspection.problem : "";
    return inspection;
  }

  async function refreshWatchFolderValidation(nativePath) {
    return applyWatchFolderInspection(await FolderReadiness.inspect(fs, nativePath));
  }

  function setReadiness(id, ready, label, value) {
    var node = element(id);
    if (!node) return;
    node.setAttribute("data-ready", ready ? "true" : "false");
    node.setAttribute("aria-label", label + "：" + (ready ? "已完成" : "未完成") + "，" + value);
  }

  function renderReadiness(readiness) {
    var projectValue = "未打开工程";
    if (context && context.project) {
      projectValue = context.project.name || "未命名项目";
      if (!projectIsSaved()) projectValue += " · 尚未保存";
    } else if (contextRefreshCount > 0) {
      projectValue = "正在读取";
    }

    var sourceFolderPath = projectState && projectState.watchFolder ? projectState.watchFolder : "";
    var captureHint = context && context.capturePathHint ? context.capturePathHint : "";
    var outputPath = context && context.recordingFolderPath ? context.recordingFolderPath : "";
    var outputReady = !!(context && context.recordingFolderValid);
    var folderValue = outputPath || "保存工程后自动确定";
    if (outputPath && !outputReady && context.recordingFolderProblem) {
      folderValue = "无法使用：" + context.recordingFolderProblem;
    }
    var sequenceValue = context && context.sequence ? context.sequence.name || "当前序列" : "未打开序列";
    if (!context && contextRefreshCount > 0) sequenceValue = "正在读取";

    setText("projectName", projectValue, projectValue);
    setText("watchFolder", folderValue, outputPath || folderValue);
    setText("sequenceName", sequenceValue, sequenceValue);
    setReadiness("readinessProject", readiness.project, "工程已保存", projectValue);
    setReadiness("readinessSequence", readiness.sequence, "序列已打开", sequenceValue);
    setReadiness("readinessFolder", outputReady, "最终保存位置", folderValue);
    var chooseFolderButton = element("chooseFolderButton");
    if (chooseFolderButton) {
      var sourceScope = "只用于发现 Premiere 原始录音，不会改变最终保存位置。";
      var sourceHint = watchFolderValid
        ? "备用采集目录：" + sourceFolderPath
        : sourceFolderPath && watchFolderProblem
          ? "备用采集目录不可用：" + watchFolderProblem
          : captureHint
            ? "当前自动识别来源：" + captureHint
            : "仅在无法自动识别 Premiere 原始录音时设置";
      chooseFolderButton.title = sourceScope + sourceHint;
      chooseFolderButton.setAttribute("aria-label", "设置备用采集目录。" + sourceScope + sourceHint);
    }
    setText("readinessCount", readiness.completed === 2 ? "自动待命" : readiness.completed + "/2 已完成");
  }

  function currentJobIsProcessing() {
    if (!currentJob) return false;
    return ["found", "stable", "rename", "relink"].indexOf(currentJob.stage) >= 0;
  }

  function pipelineSummary() {
    if (!currentJob) {
      if (monitoring) return "等待新录音";
      if (projectIsSaved() && context && context.sequence) return userPaused ? "自动命名已暂停" : "正在自动布防";
      return "等待准备完成";
    }
    var summaries = {
      found: "已发现新 WAV",
      stable: "等待文件写入完成",
      rename: "正在移入工程录音目录并命名",
      relink: "正在重链接并同步时间线片段名",
      complete: "最近一条已完成",
      error: "处理失败",
    };
    return summaries[currentJob.stage] || "等待新录音";
  }

  function renderPipeline() {
    var nodes = [
      element("pipelineFound"),
      element("pipelineStable"),
      element("pipelineRename"),
      element("pipelineRelink"),
    ];
    var labels = ["发现 WAV", "等待稳定", "移入并命名", "重链接并同步时间线片段名"];
    var statusLabels = { waiting: "等待", active: "正在进行", done: "已完成", error: "失败" };
    var pipeline = PanelState.derivePipeline(currentJob || {});

    pipeline.forEach(function (entry, index) {
      var node = nodes[index];
      if (!node) return;
      var marker = node.querySelector(".pipeline-marker");
      node.className = "pipeline-step pipeline-step--" + entry.status;
      node.setAttribute("aria-label", labels[index] + "：" + statusLabels[entry.status]);
      if (entry.status === "active") node.setAttribute("aria-current", "step");
      else node.removeAttribute("aria-current");
      if (marker) {
        marker.textContent = entry.status === "done" ? "✓" : entry.status === "error" ? "!" : String(index + 1);
      }
    });
    setText("pipelineSummary", pipelineSummary());
  }

  function exampleTargetName() {
    try {
      return Core.buildRecordingName({
        projectName: context && context.project ? context.project.name : "项目名",
        recordingId: EXAMPLE_RECORDING_ID,
      });
    } catch (error) {
      return "项目名-" + EXAMPLE_RECORDING_ID + ".wav";
    }
  }

  function renderFilenamePreview() {
    if (!currentJob) {
      setText("previewCaption", "命名示例");
      setText("previewSourceName", "音频 2_1.wav");
      setText("previewTargetName", exampleTargetName());
      return;
    }

    var caption = "当前录音";
    if (currentJob.stage === "complete") caption = "最近完成";
    if (currentJob.stage === "error") caption = "失败录音";
    setText("previewCaption", caption);
    setText("previewSourceName", currentJob.sourceName || "新录音.wav");
    setText("previewTargetName", currentJob.targetName || "正在计算目标文件名…");
  }

  function renderUsageGuide(view) {
    var steps = [
      ["guideProject", monitoring],
      ["guideFolder", !!currentJob],
      ["guideListen", currentJob && currentJob.stage === "complete"],
    ];
    steps.forEach(function (entry, index) {
      var node = element(entry[0]);
      if (!node) return;
      var completed = entry[1] === true;
      var active = !completed && ((index === 0 && !monitoring) || (index === 1 && monitoring) || (index === 2 && currentJobIsProcessing()));
      node.setAttribute("data-guide-status", completed ? "done" : active ? "active" : "waiting");
      node.setAttribute("aria-label", node.querySelector(".guide-title").textContent + "：" + (completed ? "已完成" : active ? "当前步骤" : "等待"));
      var marker = node.querySelector(".guide-marker");
      if (marker) marker.textContent = completed ? "✓" : String(index + 1);
    });

    var status = "正在连接 Premiere";
    if (view.mode === "ready" || view.mode === "starting") status = "正在自动布防";
    if (view.mode === "listening") status = "直接点音轨麦克风";
    if (view.mode === "paused") status = "恢复后继续自动处理";
    if (["processing", "scanning"].indexOf(view.mode) >= 0) status = "录音已捕获，正在自动处理";
    if (view.mode === "error") status = "看顶部提示后重新检查";
    setText("guideStatus", status);
  }

  function deriveCurrentPanelState() {
    return PanelState.derivePanelState({
      hasProject: !!(context && context.project),
      projectSaved: projectIsSaved(),
      hasSequence: !!(context && context.sequence),
      monitoring: monitoring,
      paused: userPaused,
      starting: startingMonitoring,
      scanning: manualScanInFlight && !manualScanExecuting,
      processing: currentJobIsProcessing() && (!manualScanInFlight || manualScanExecuting),
      refreshing: contextRefreshCount > 0,
      errorMessage: panelErrorMessage,
    });
  }

  function renderPanelState(view) {
    var shell = element("panelMain");
    if (shell) {
      shell.setAttribute("data-panel-state", view.mode);
      shell.setAttribute("aria-busy", view.busy ? "true" : "false");
    }
    setStatus(view.tone, view.statusLabel);
    setText("stateKicker", view.kicker);
    setText("stateTitle", view.title);
    setText("stateDescription", view.description);
    renderReadiness(view.readiness);
    renderUsageGuide(view);
    renderPipeline();
    renderFilenamePreview();
  }

  function setJobStage(stage, candidate, plan) {
    var sourceName = candidate ? Core.fileNameFromPath(candidate.mediaPath) : currentJob && currentJob.sourceName;
    var sourceKey = candidate ? Core.normalizePathForComparison(candidate.mediaPath) : currentJob && currentJob.sourceKey;
    if (!currentJob || (sourceKey && currentJob.sourceKey !== sourceKey)) {
      currentJob = {
        sourceKey: sourceKey || "",
        sourceName: sourceName || "新录音.wav",
        targetName: "",
        stage: "found",
        errorStage: "",
        errorMessage: "",
      };
    }
    if (sourceName) currentJob.sourceName = sourceName;
    if (plan && plan.targetName) currentJob.targetName = plan.targetName;
    currentJob.stage = stage;
    currentJob.errorStage = "";
    currentJob.errorMessage = "";
    panelErrorMessage = "";
    updateControls();
  }

  function setJobError(error, candidate) {
    if (!currentJob && candidate) setJobStage("found", candidate);
    if (currentJob) {
      currentJob.errorStage = ["found", "stable", "rename", "relink"].indexOf(currentJob.stage) >= 0 ? currentJob.stage : "found";
      currentJob.stage = "error";
      currentJob.errorMessage = error && error.message ? error.message : String(error);
    }
    panelErrorMessage = error && error.message ? error.message : String(error);
    updateControls();
  }

  function updateControls() {
    var view = deriveCurrentPanelState();
    var startButton = element("startButton");
    var stopButton = element("stopButton");
    var scanButton = element("scanButton");
    var chooseFolderButton = element("chooseFolderButton");
    var refreshButton = element("refreshButton");
    primaryAction = view.primaryAction;
    if (startButton) {
      startButton.hidden = !view.primaryAction;
      startButton.disabled = view.busy || !view.primaryAction;
      if (view.primaryLabel) startButton.textContent = view.primaryLabel;
    }
    if (stopButton) {
      stopButton.hidden = !view.showStop;
      stopButton.disabled = !monitoring;
    }
    if (scanButton) {
      scanButton.disabled =
        view.busy || !context || !projectIsSaved() || !context.sequence || !projectState;
    }
    if (chooseFolderButton) chooseFolderButton.disabled = monitoring || view.busy || !context || !projectIsSaved();
    if (refreshButton) {
      refreshButton.textContent = monitoring ? "重新检查" : "刷新项目";
      refreshButton.disabled = view.busy || (monitoring && !panelErrorMessage);
    }

    setText("processedCount", String(sessionMetrics.processed));
    setText("pendingCount", String(pendingFiles.size + unmatchedFolderFiles.size));
    setText("errorCount", String(sessionMetrics.errors));
    renderPanelState(view);
  }

  function getProjectIdentity(project) {
    var guidIdentity = "";
    try {
      if (project.guid && typeof project.guid.toString === "function") guidIdentity = project.guid.toString();
    } catch (error) {}
    return MonitoringPolicy.buildProjectIdentity(
      project && project.path ? project.path : "",
      guidIdentity || String(project && project.name || ""),
      Core.normalizePathForComparison
    );
  }

  function getSequenceIdentity(sequence) {
    if (!sequence) return "";
    try {
      if (sequence.guid && typeof sequence.guid.toString === "function") return sequence.guid.toString();
    } catch (error) {}
    return String(sequence.name || "active-sequence");
  }

  function withOperationLock(operation) {
    return operationQueue.run(operation);
  }

  function cancellationError(message) {
    var error = new Error(message || "操作已取消");
    error.code = "VOICEOVER_NAMER_CANCELLED";
    return error;
  }

  function isCancellation(error) {
    return error && error.code === "VOICEOVER_NAMER_CANCELLED";
  }

  function ensureLifecycle(generation) {
    if (!panelVisible || (generation != null && !lifecycleGuard.isCurrent(generation))) {
      throw cancellationError("面板已关闭");
    }
  }

  async function ensureCurrentContext(expectedProjectIdentity, expectedSequenceIdentity, generation, lifecycleGeneration) {
    ensureLifecycle(lifecycleGeneration);
    if (generation != null && (!monitoring || !monitorGuard.isCurrent(generation))) {
      throw cancellationError("监听已停止");
    }

    var activeProject = await ppro.Project.getActiveProject();
    if (!activeProject || getProjectIdentity(activeProject) !== expectedProjectIdentity) {
      throw cancellationError("项目已切换");
    }
    var activeSequence = await activeProject.getActiveSequence();
    if (!activeSequence || getSequenceIdentity(activeSequence) !== expectedSequenceIdentity) {
      throw cancellationError("序列已切换");
    }

    if (generation != null && (!monitoring || !monitorGuard.isCurrent(generation))) {
      throw cancellationError("监听已停止");
    }
    ensureLifecycle(lifecycleGeneration);
  }

  async function ensureActiveMediaContext(expectedProjectIdentity, expectedSequenceIdentity) {
    var activeProject = await ppro.Project.getActiveProject();
    if (!activeProject || getProjectIdentity(activeProject) !== expectedProjectIdentity) {
      throw cancellationError("项目已切换");
    }
    var activeSequence = await activeProject.getActiveSequence();
    if (!activeSequence || getSequenceIdentity(activeSequence) !== expectedSequenceIdentity) {
      throw cancellationError("序列已切换");
    }
    return true;
  }

  function sidecarPathFor(project) {
    if (!project.path) throw new Error("请先保存 Premiere 工程");
    var parts = Core.splitNativePath(project.path);
    var fileStem = Core.stemOf(parts.base);
    return Core.joinNativePath(parts.dir, fileStem + ".voiceover-namer.json", parts.separator);
  }

  async function readText(nativePath) {
    var value = await fs.readFile(nativePath, { encoding: "utf-8" });
    return typeof value === "string" ? value : String(value);
  }

  async function loadProjectState(activeContext) {
    if (!activeContext.statePath) return State.hydrateState(null, activeContext.identity);
    var raw = null;
    var statePath = activeContext.statePath;
    try {
      raw = JSON.parse(await readText(statePath));
    } catch (error) {
      try {
        raw = JSON.parse(await readText(statePath + ".bak"));
        addLog("warn", "状态文件已从备份恢复读取");
      } catch (backupError) {
        raw = null;
      }
    }
    var hydrated = State.hydrateState(raw, activeContext.identity);
    if (State.needsMigration(raw)) {
      try {
        await saveProjectState(activeContext, hydrated);
        addLog("ok", "状态文件已升级为全局录音 ID 格式");
      } catch (migrationError) {
        addLog("warn", "状态文件已在内存中升级，但写回失败: " + (migrationError.message || migrationError));
      }
    }
    return hydrated;
  }

  async function safeUnlink(nativePath) {
    try {
      if (await Transaction.exists(fs, nativePath)) await fs.unlink(nativePath);
    } catch (error) {}
  }

  async function saveProjectState(stateContext, stateValue) {
    var targetContext = stateContext || context;
    var targetState = stateValue || projectState;
    if (!targetContext || !targetState) return;
    if (!targetContext.statePath) throw new Error("请先保存 Premiere 工程");
    var statePath = targetContext.statePath;
    var tempPath = statePath + ".tmp";
    var backupPath = statePath + ".bak";
    var hadOriginal = await Transaction.exists(fs, statePath);
    var promoted = false;

    await safeUnlink(tempPath);
    await fs.writeFile(tempPath, JSON.stringify(targetState, null, 2) + "\n", { encoding: "utf-8" });

    try {
      if (hadOriginal) {
        await safeUnlink(backupPath);
        await fs.rename(statePath, backupPath);
      }
      await fs.rename(tempPath, statePath);
      promoted = true;
      await safeUnlink(backupPath);
    } catch (error) {
      await safeUnlink(tempPath);
      if (!promoted && hadOriginal && (await Transaction.exists(fs, backupPath)) && !(await Transaction.exists(fs, statePath))) {
        try {
          await fs.rename(backupPath, statePath);
        } catch (restoreError) {}
      }
      throw error;
    }
  }

  async function getCapturePathHint(project) {
    try {
      if (!ppro.ProjectSettings || typeof ppro.ProjectSettings.getScratchDiskSettings !== "function") return "";
      var folderType = ppro.Constants && ppro.Constants.ScratchDiskFolderType
        ? ppro.Constants.ScratchDiskFolderType.CAPTURE
        : null;
      if (folderType == null) return "";
      var settings = await ppro.ProjectSettings.getScratchDiskSettings(project);
      if (!settings || typeof settings.getScratchDiskPath !== "function") return "";
      return String(settings.getScratchDiskPath(folderType) || "");
    } catch (error) {
      return "";
    }
  }

  async function getActiveContext() {
    var project = null;
    try {
      project = await ppro.Project.getActiveProject();
    } catch (error) {
      project = null;
    }
    if (!project) return null;

    var sequence = null;
    try {
      sequence = await project.getActiveSequence();
    } catch (error) {
      sequence = null;
    }

    return {
      project: project,
      sequence: sequence,
      identity: getProjectIdentity(project),
      sequenceIdentity: getSequenceIdentity(sequence),
      statePath: project.path ? sidecarPathFor(project) : "",
      recordingFolderPath: Core.recordingDirectoryFromProjectPath(project.path || ""),
      recordingFolderValid: false,
      recordingFolderProblem: "",
      capturePathHint: await getCapturePathHint(project),
    };
  }

  async function refreshContext(options) {
    if (!panelVisible) return null;
    var allowAutoStart = !options || options.allowAutoStart !== false;
    var refreshGeneration = ++contextRefreshGeneration;
    var refreshLifecycleGeneration = lifecycleGuard.current();
    contextRefreshCount += 1;
    resetWatchFolderValidation();
    updateControls();
    try {
      var nextContext = null;
      var readError = null;
      try {
        nextContext = await getActiveContext();
      } catch (error) {
        readError = error;
      }
      if (
        refreshGeneration !== contextRefreshGeneration ||
        !panelVisible ||
        !lifecycleGuard.isCurrent(refreshLifecycleGeneration)
      ) return null;
      if (readError) addLog("error", readError.message || String(readError));

      if (!nextContext) {
        if (monitoring) stopMonitoring("项目不可用");
        context = null;
        projectState = null;
        resetWatchFolderValidation();
        panelErrorMessage = readError ? readError.message || String(readError) : "";
        updateControls();
        return null;
      }

      var nextProjectState = await loadProjectState(nextContext);
      var inspections = await Promise.all([
        FolderReadiness.inspect(fs, nextProjectState.watchFolder),
        nextContext.recordingFolderPath
          ? FolderReadiness.ensure(fs, nextContext.recordingFolderPath)
          : Promise.resolve({ valid: false, created: false, problem: "" }),
      ]);
      var folderInspection = inspections[0];
      var recordingFolderInspection = inspections[1];
      if (
        refreshGeneration !== contextRefreshGeneration ||
        !panelVisible ||
        !lifecycleGuard.isCurrent(refreshLifecycleGeneration)
      ) return null;

      var changedProject = context && context.identity !== nextContext.identity;
      if (changedProject && monitoring) stopMonitoring("项目已切换");

      context = nextContext;
      context.recordingFolderValid = recordingFolderInspection.valid === true;
      context.recordingFolderProblem = recordingFolderInspection.problem || "";
      projectState = nextProjectState;
      applyWatchFolderInspection(folderInspection);
      panelErrorMessage = projectIsSaved() && !context.recordingFolderValid
        ? context.recordingFolderProblem || "工程录音目录不可用"
        : "";

      if (recordingFolderInspection.created) {
        addLog("ok", "已创建最终保存目录：" + context.recordingFolderPath);
      }

      updateControls();

      if (
        allowAutoStart &&
        panelVisible &&
        lifecycleGuard.isCurrent(refreshLifecycleGeneration) &&
        projectIsSaved() &&
        context.recordingFolderValid &&
        context.sequence &&
        !monitoring &&
        !userPaused
      ) {
        await startMonitoring(true);
      }
      return context;
    } finally {
      contextRefreshCount = Math.max(0, contextRefreshCount - 1);
      updateControls();
    }
  }

  async function collectTrackMedia(activeContext) {
    var sequence = await activeContext.project.getActiveSequence();
    if (!sequence) return { entries: [], tracks: [], sequence: null, sequenceIdentity: "" };

    var entries = [];
    var tracks = [];
    var sequenceIdentity = getSequenceIdentity(sequence);
    var trackCount = await sequence.getAudioTrackCount();
    var clipType = ppro.Constants && ppro.Constants.TrackItemType ? ppro.Constants.TrackItemType.CLIP : 1;

    for (var index = 0; index < trackCount; index += 1) {
      var track = await sequence.getAudioTrack(index);
      if (!track) continue;
      tracks.push(track);

      var trackItems = await track.getTrackItems(clipType, false);

      for (var itemIndex = 0; itemIndex < trackItems.length; itemIndex += 1) {
        try {
          var trackItem = trackItems[itemIndex];
          var rawItem = await trackItem.getProjectItem();
          var clipItem = ppro.ClipProjectItem.cast(rawItem);
          if (!clipItem) continue;
          var projectItemId = "";
          try {
            if (rawItem && typeof rawItem.getId === "function") {
              var rawProjectItemId = await rawItem.getId();
              if (rawProjectItemId != null && String(rawProjectItemId) !== "") {
                projectItemId = String(rawProjectItemId);
              }
            }
          } catch (idError) {}
          var mediaPath = await clipItem.getMediaFilePath();
          if (!mediaPath || !Core.isWaveFile(mediaPath)) continue;
          entries.push({
            mediaPath: mediaPath,
            projectItem: clipItem,
            projectItemIdentity: rawItem,
            projectItemId: projectItemId,
            trackItems: [trackItem],
            project: activeContext.project,
            projectIdentity: activeContext.identity,
            projectName: activeContext.project.name,
            sequenceIdentity: sequenceIdentity,
          });
        } catch (error) {
          addLog("warn", "跳过无法读取的音频片段: " + (error.message || error));
        }
      }
    }

    return {
      entries: MediaCandidates.deduplicate(entries, Core.normalizePathForComparison),
      tracks: tracks,
      sequence: sequence,
      sequenceIdentity: sequenceIdentity,
    };
  }

  async function listWatchedWavePaths() {
    if (!projectState || !projectState.watchFolder || !watchFolderValid) return [];
    var names = await fs.readdir(projectState.watchFolder);
    var separator = projectState.watchFolder.indexOf("\\") >= 0 ? "\\" : "/";
    return (names || [])
      .map(function (name) {
        return String(name);
      })
      .filter(Core.isWaveFile)
      .map(function (name) {
        return Core.joinNativePath(projectState.watchFolder, name, separator);
      });
  }

  function capturePathIsTrusted(nativePath) {
    return MonitoringPolicy.isTrustedCapturePath({
      mediaPath: nativePath,
      learnedFolder: watchFolderValid && projectState ? projectState.watchFolder : "",
      scratchPath: context ? context.capturePathHint : "",
      projectPath: context && context.project ? context.project.path : "",
      isPathInside: Core.isPathInside,
    });
  }

  function automaticCandidateIsTrusted(candidate) {
    return !!(
      candidate &&
      capturePathIsTrusted(candidate.mediaPath) &&
      MonitoringPolicy.isNativeDefaultRecordingName(candidate.mediaPath)
    );
  }

  async function createInitialPathBaseline(entries, armTime) {
    var baseline = new Set();
    for (var index = 0; index < (entries || []).length; index += 1) {
      var entry = entries[index];
      var key = Core.normalizePathForComparison(entry.mediaPath);
      if (isNormalizedRecording(entry)) {
        baseline.add(key);
        continue;
      }
      try {
        var stat = await fs.lstat(entry.mediaPath);
        if (automaticCandidateIsTrusted(entry) && MonitoringPolicy.isFreshFile(stat, armTime, FRESH_FILE_TOLERANCE_MS)) {
          continue;
        }
      } catch (error) {}
      baseline.add(key);
    }
    return baseline;
  }

  async function createInitialFolderBaseline(nativePaths, armTime) {
    var baseline = new Set();
    for (var index = 0; index < (nativePaths || []).length; index += 1) {
      var nativePath = nativePaths[index];
      try {
        var stat = await fs.lstat(nativePath);
        if (MonitoringPolicy.isFreshFile(stat, armTime, FRESH_FILE_TOLERANCE_MS)) continue;
      } catch (error) {}
      baseline.add(Core.normalizePathForComparison(nativePath));
    }
    return baseline;
  }

  async function projectItemId(projectItem) {
    try {
      if (projectItem && typeof projectItem.getId === "function") {
        var value = await projectItem.getId();
        if (value != null && String(value) !== "") return String(value);
      }
    } catch (error) {}
    return "";
  }

  async function exactMediaMatches(items, nativePath) {
    var matches = [];
    var matchKeys = new Set();

    for (var index = 0; index < (items || []).length; index += 1) {
      var rawItem = items[index];
      try {
        var clipItem = ppro.ClipProjectItem.cast(rawItem);
        if (!clipItem || typeof clipItem.getMediaFilePath !== "function") continue;
        var mediaPath = await clipItem.getMediaFilePath();
        if (!Core.sameNativePath(mediaPath, nativePath)) continue;
        var id = await projectItemId(rawItem);
        var key = id ? "id:" + id : rawItem;
        if (matchKeys.has(key)) continue;
        matchKeys.add(key);
        matches.push({ projectItem: clipItem, projectItemIdentity: rawItem, projectItemId: id });
      } catch (error) {}
    }
    return matches;
  }

  function mergeMediaMatches(primary, secondary) {
    var merged = [];
    var matchKeys = new Set();
    (primary || []).concat(secondary || []).forEach(function (entry) {
      var hasProjectItemId = entry && entry.projectItemId != null && String(entry.projectItemId) !== "";
      var key = hasProjectItemId
        ? "id:" + String(entry.projectItemId)
        : entry && (entry.projectItemIdentity || entry.projectItem);
      if (matchKeys.has(key)) return;
      matchKeys.add(key);
      merged.push(entry);
    });
    return merged;
  }

  async function collectProjectItemsForMediaPath(project, nativePath, seedProjectItem) {
    var indexedMatches = [];
    if (seedProjectItem && typeof seedProjectItem.findItemsMatchingMediaPath === "function") {
      try {
        var indexedItems = await seedProjectItem.findItemsMatchingMediaPath(nativePath, false);
        indexedMatches = await exactMediaMatches(indexedItems, nativePath);
      } catch (error) {}
    }

    if (!project || typeof project.getRootItem !== "function") return indexedMatches;
    var root = await project.getRootItem();
    var mediaItems = [];
    var visitedFolders = new Set();

    async function visitFolder(folder) {
      if (!folder || typeof folder.getItems !== "function") return;
      var folderId = await projectItemId(folder);
      if (folderId && visitedFolders.has(folderId)) return;
      if (folderId) visitedFolders.add(folderId);

      var items = await folder.getItems();
      for (var index = 0; index < (items || []).length; index += 1) {
        var rawItem = items[index];
        var item = rawItem;
        try {
          if (ppro.ProjectItem && typeof ppro.ProjectItem.cast === "function") item = ppro.ProjectItem.cast(rawItem);
        } catch (error) {}

        // Do not depend on undocumented ProjectItem bin/root constants.
        // FolderItem.cast is the supported way to distinguish bins from media.
        var childFolder = null;
        try {
          if (ppro.FolderItem && typeof ppro.FolderItem.cast === "function") {
            childFolder = ppro.FolderItem.cast(item);
          }
        } catch (error) {}
        if (!childFolder && item && typeof item.getItems === "function") childFolder = item;
        if (!childFolder && rawItem && typeof rawItem.getItems === "function") childFolder = rawItem;
        if (childFolder && typeof childFolder.getItems === "function") {
          try {
            await visitFolder(childFolder);
          } catch (error) {}
          continue;
        }

        mediaItems.push(item);
      }
    }

    await visitFolder(root);
    var recursiveMatches = await exactMediaMatches(mediaItems, nativePath);
    return mergeMediaMatches(indexedMatches, recursiveMatches);
  }

  async function ensureUniqueProjectMediaReference(candidate) {
    var references = await collectProjectItemsForMediaPath(
      candidate.project,
      candidate.mediaPath,
      candidate.projectItem
    );
    if (!references.length) {
      var notReady = new Error("录音素材尚未完成加入项目，稍后重试");
      notReady.code = "VOICEOVER_NAMER_NOT_READY";
      throw notReady;
    }
    if (references.length > 1) {
      var ambiguous = new Error("全项目中同一路径关联到多个 Premiere 素材，未自动改名");
      ambiguous.code = "VOICEOVER_NAMER_AMBIGUOUS";
      throw ambiguous;
    }
  }

  function detachTrackListeners() {
    if (!ppro.EventManager || typeof ppro.EventManager.removeEventListener !== "function") {
      trackListeners = [];
      return;
    }
    trackListeners.forEach(function (binding) {
      try {
        ppro.EventManager.removeEventListener(binding.track, binding.eventName, onTrackChanged);
      } catch (error) {}
    });
    trackListeners = [];
  }

  function attachTrackListeners(tracks) {
    detachTrackListeners();
    var eventName = ppro.Constants && ppro.Constants.AudioTrackEvent ? ppro.Constants.AudioTrackEvent.TRACK_CHANGED : null;
    if (eventName == null || !ppro.EventManager || typeof ppro.EventManager.addEventListener !== "function") return;
    tracks.forEach(function (track) {
      try {
        ppro.EventManager.addEventListener(track, eventName, onTrackChanged);
        trackListeners.push({ track: track, eventName: eventName });
      } catch (error) {}
    });
  }

  function onTrackChanged() {
    requestSoonScan();
  }

  function onImportMediaComplete(event) {
    var successState = ppro.Constants && ppro.Constants.OperationCompleteState
      ? ppro.Constants.OperationCompleteState.SUCCESS
      : null;
    if (!Coordination.shouldHandleOperationComplete(event, successState)) return;
    requestSoonScan();
  }

  function attachGlobalImportListener() {
    if (globalImportListenerAttached) return;
    var eventName = ppro.Constants && ppro.Constants.OperationCompleteEvent ? ppro.Constants.OperationCompleteEvent.IMPORT_MEDIA_COMPLETE : null;
    if (eventName == null || !ppro.EventManager || typeof ppro.EventManager.addGlobalEventListener !== "function") return;
    try {
      ppro.EventManager.addGlobalEventListener(eventName, onImportMediaComplete);
      globalImportListenerAttached = true;
      globalImportEventName = eventName;
    } catch (error) {}
  }

  function detachGlobalImportListener() {
    if (
      globalImportListenerAttached &&
      globalImportEventName != null &&
      ppro.EventManager &&
      typeof ppro.EventManager.removeGlobalEventListener === "function"
    ) {
      try {
        ppro.EventManager.removeGlobalEventListener(globalImportEventName, onImportMediaComplete);
      } catch (error) {}
    }
    globalImportListenerAttached = false;
    globalImportEventName = null;
  }

  function requestSoonScan() {
    eventScanRequested = true;
    if (!monitoring || scheduledTick) return;
    scheduledTick = setTimeout(function () {
      scheduledTick = null;
      scanTick();
    }, 160);
  }

  async function startMonitoring(fromAutoStart) {
    if (!panelVisible || monitoring || startingMonitoring) return;
    var requestedArmTime = Date.now();
    startingMonitoring = true;
    panelErrorMessage = "";
    var startRequestGeneration = monitorGuard.current();
    var startLifecycleGeneration = lifecycleGuard.current();
    updateControls();
    try {
      await withOperationLock(async function () {
        if (!monitorGuard.isCurrent(startRequestGeneration)) throw cancellationError("启动监听已取消");
        ensureLifecycle(startLifecycleGeneration);
        if (monitoring) return;
        await refreshContext({ allowAutoStart: false });
        if (!monitorGuard.isCurrent(startRequestGeneration)) throw cancellationError("启动监听已取消");
        ensureLifecycle(startLifecycleGeneration);
        if (!context) throw new Error("未连接 Premiere 项目");
        if (!projectIsSaved()) throw new Error("请先保存 Premiere 工程");
        if (!context.recordingFolderPath || !context.recordingFolderValid) {
          throw new Error(context.recordingFolderProblem || "工程录音目录不可用");
        }
        if (!context.sequence) throw new Error("请先打开一个序列");
        if (!Core.secureRandomAvailable(globalThis)) {
          throw new Error("当前 UXP 不支持安全随机源，无法生成全局唯一录音 ID");
        }
        Core.createRecordingId(globalThis);

        if (projectState.watchFolder) {
          await refreshWatchFolderValidation(projectState.watchFolder);
        } else {
          resetWatchFolderValidation();
        }

        normalizedNameChecks.clear();
        var snapshot = await collectTrackMedia(context);
        var folderFiles = watchFolderValid ? await listWatchedWavePaths() : [];
        armedAtMs = requestedArmTime;
        seenPaths = await createInitialPathBaseline(snapshot.entries, armedAtMs);
        watchedFolderBaseline = await createInitialFolderBaseline(folderFiles, armedAtMs);
        if (!monitorGuard.isCurrent(startRequestGeneration)) throw cancellationError("启动监听已取消");
        ensureLifecycle(startLifecycleGeneration);
        pendingFiles.clear();
        unmatchedFolderFiles.clear();
        eventScanRequested = false;
        activeSequenceIdentity = snapshot.sequenceIdentity;
        lastTrackScanAt = 0;
        attachTrackListeners(snapshot.tracks);
        attachGlobalImportListener();

        monitorGuard.bump();
        monitoring = true;
        userPaused = false;
        currentJob = null;
        timer = setInterval(scanTick, POLL_INTERVAL_MS);
        addLog("ok", watchFolderValid
          ? "已自动待命，直接点击时间线音轨麦克风"
          : "已自动待命，首条录音会自动识别实际目录");
        requestSoonScan();
      });
    } catch (error) {
      if (!isCancellation(error)) {
        panelErrorMessage = error.message || String(error);
        addLog("error", error.message || String(error));
      }
    } finally {
      startingMonitoring = false;
      updateControls();
    }
  }

  function stopMonitoring(reason, options) {
    if (timer) clearInterval(timer);
    if (scheduledTick) clearTimeout(scheduledTick);
    timer = null;
    scheduledTick = null;
    monitoring = false;
    userPaused = !!(options && options.pause === true);
    monitorGuard.bump();
    pendingFiles.clear();
    watchedFolderBaseline.clear();
    unmatchedFolderFiles.clear();
    normalizedNameChecks.clear();
    eventScanRequested = false;
    activeSequenceIdentity = "";
    armedAtMs = 0;
    lastTrackScanAt = 0;
    detachTrackListeners();
    currentJob = null;
    panelErrorMessage = "";
    if (reason) addLog("warn", reason);
    updateControls();
  }

  function statTimestamp(stat) {
    var milliseconds = Number(stat.birthtimeMs || 0) || Number(stat.mtimeMs || 0);
    if (!milliseconds && stat.birthtime) milliseconds = new Date(stat.birthtime).getTime();
    if (!milliseconds && stat.mtime) milliseconds = new Date(stat.mtime).getTime();
    return milliseconds > 0 ? new Date(milliseconds) : new Date();
  }

  function statSignature(stat) {
    var modified = Number(stat.mtimeMs || 0);
    if (!modified && stat.mtime) modified = new Date(stat.mtime).getTime();
    return String(stat.size) + "@" + String(modified);
  }

  function statIdentitySignature(stat) {
    var birth = Number(stat.birthtimeMs || 0);
    var changed = Number(stat.ctimeMs || 0);
    if (!birth && stat.birthtime) birth = new Date(stat.birthtime).getTime();
    if (!changed && stat.ctime) changed = new Date(stat.ctime).getTime();
    return [
      statSignature(stat),
      birth,
      changed,
      stat.ino == null ? "" : String(stat.ino),
    ].join("@");
  }

  function isRetryableLock(error) {
    var current = error;
    for (var depth = 0; current && depth < 4; depth += 1) {
      var code = String(current.code || "").toUpperCase();
      var message = String(current.message || current);
      if (["EBUSY", "EACCES", "EPERM"].indexOf(code) >= 0) return true;
      if (/busy|locked|being used|另一个进程|占用/i.test(message)) return true;
      current = current.cause;
    }
    return false;
  }

  async function targetPlanFor(candidate, allEntries) {
    if (!Core.secureRandomAvailable(globalThis)) {
      throw new Error("当前 UXP 不支持安全随机源，无法生成全局唯一录音 ID");
    }
    var existingNames = (allEntries || []).map(function (entry) {
      return entry.mediaPath;
    }).map(function (nativePath) {
      return Core.fileNameFromPath(nativePath);
    });
    var projectName = candidate.projectName || (candidate.project && candidate.project.name) || context.project.name;
    var targetDirectory = recordingFolderForCandidate(candidate);
    if (!targetDirectory) throw new Error("无法从 Premiere 工程路径确定最终保存目录");
    var destinationInspection = await FolderReadiness.ensure(fs, targetDirectory);
    if (!destinationInspection.valid) {
      throw new Error(destinationInspection.problem || "工程录音目录不可用");
    }
    if (context && context.identity === candidate.projectIdentity) {
      context.recordingFolderPath = targetDirectory;
      context.recordingFolderValid = true;
      context.recordingFolderProblem = "";
    }
    var sourceParts = Core.splitNativePath(candidate.mediaPath);
    var targetSeparator = Core.splitNativePath(targetDirectory).separator;
    var managedSource = Core.parseManagedName(sourceParts.base);
    var preservedPlan = managedSource && managedSource.format === "global-id"
      ? {
          recordingId: managedSource.recordingId,
          targetName: Core.buildRecordingName({ projectName: projectName, recordingId: managedSource.recordingId }),
          attempts: 1,
        }
      : null;
    var collisionRetries = 0;

    for (var attempt = 0; attempt < 1000; attempt += 1) {
      var namePlan = preservedPlan || Core.createAvailableRecordingName({
          projectName: projectName,
          existingNames: existingNames,
          randomSource: globalThis,
        });
      preservedPlan = null;
      collisionRetries += namePlan.attempts - 1;
      var targetName = namePlan.targetName;
      var targetPath = Core.joinNativePath(targetDirectory, targetName, targetSeparator);
      if (Core.sameNativePath(candidate.mediaPath, targetPath) || !(await Transaction.exists(fs, targetPath))) {
        return {
          candidate: candidate,
          recordingId: namePlan.recordingId,
          sourceSignature: candidate.sourceSignature,
          targetName: targetName,
          targetPath: targetPath,
          collisionRetries: collisionRetries,
        };
      }
      collisionRetries += 1;
      existingNames.push(targetName);
    }
    throw new Error("无法生成未被占用的唯一录音 ID");
  }

  async function executeCandidate(candidate, allEntries, preparedPlan) {
    var operationContext = context;
    var operationState = projectState;
    if (!operationContext || !operationState || operationContext.identity !== candidate.projectIdentity) {
      throw cancellationError("项目上下文已变化");
    }
    var candidateProject = candidate.project || operationContext.project;
    await ensureUniqueProjectMediaReference(candidate);
    var plan = preparedPlan || (await targetPlanFor(candidate, allEntries));
    var targetConflictRetries = 0;

    try {
      while (true) {
        if (await Transaction.exists(fs, plan.targetPath)) {
          if (targetConflictRetries >= MAX_TARGET_CONFLICT_RETRIES) {
            throw new Error("目标文件持续冲突，已停止处理以避免覆盖");
          }
          targetConflictRetries += 1;
          var occupiedRetries = Number(plan.collisionRetries || 0) + 1;
          plan = await targetPlanFor(candidate, allEntries);
          plan.collisionRetries += occupiedRetries;
          continue;
        }
        setJobStage("stable", candidate, plan);

        if (plan.sourceSignature) {
          var currentSourceStat = await fs.lstat(candidate.mediaPath);
          if (statIdentitySignature(currentSourceStat) !== plan.sourceSignature) {
            throw new Error("源文件在确认期间发生变化，请重新扫描");
          }
        }

        try {
          var transactionResult = await Transaction.renameAndRelink({
            fs: fs,
            project: candidateProject,
            projectItem: candidate.projectItem,
            trackItems: candidate.trackItems,
            sourcePath: candidate.mediaPath,
            targetPath: plan.targetPath,
            targetName: plan.targetName,
            operationId: plan.recordingId,
            samePath: Core.sameNativePath,
            onStage: function (stage) {
              setJobStage(stage, candidate, plan);
            },
            validate: function () {
              return ensureActiveMediaContext(candidate.projectIdentity, candidate.sequenceIdentity);
            },
          });
          plan.transferMode = transactionResult.transferMode;
          plan.sourceRetained = transactionResult.sourceRetained;
          plan.cleanupWarning = transactionResult.cleanupWarning;
          break;
        } catch (error) {
          if (!isCancellation(error) && Transaction.isTargetConflict(error) && targetConflictRetries < MAX_TARGET_CONFLICT_RETRIES) {
            targetConflictRetries += 1;
            var raceRetries = Number(plan.collisionRetries || 0) + 1;
            addLog("warn", "目标名刚被占用，正在重新生成录音 ID");
            plan = await targetPlanFor(candidate, allEntries);
            plan.collisionRetries += raceRetries;
            continue;
          }
          throw error;
        }
      }

      normalizedNameChecks.add(Core.normalizePathForComparison(plan.targetPath));

      var learnedFolder = MonitoringPolicy.captureFolderFromMediaPath(candidate.mediaPath);
      var nextState = State.commitRecording(operationState, {
        at: new Date().toISOString(),
        recordingId: plan.recordingId,
        sourcePath: candidate.mediaPath,
        targetPath: plan.targetPath,
      });
      if (learnedFolder) nextState = State.withSettings(nextState, { watchFolder: learnedFolder });

      try {
        await saveProjectState(operationContext, nextState);
      } catch (error) {
        addLog("warn", "录音已处理，但处理历史写入失败: " + (error.message || error));
      }

      if (context && context.identity === operationContext.identity) {
        projectState = nextState;
        if (learnedFolder) {
          watchFolderValid = true;
          watchFolderProblem = "";
        }
        Coordination.markProcessedPath(
          {
            seenPaths: seenPaths,
            watchedFolderBaseline: watchedFolderBaseline,
            unmatchedFolderFiles: unmatchedFolderFiles,
            pendingFiles: pendingFiles,
          },
          candidate.mediaPath,
          plan.targetPath,
          Core.normalizePathForComparison
        );
      }
      sessionMetrics.processed += 1;
      setJobStage("complete", candidate, plan);
      if (learnedFolder && !Core.sameNativePath(operationState.watchFolder, learnedFolder)) {
        addLog("ok", "已自动识别原始采集目录：" + learnedFolder);
      }
      if (plan.cleanupWarning) addLog("warn", plan.cleanupWarning);
      addLog(
        "ok",
        (plan.collisionRetries ? "重名避让 " + plan.collisionRetries + " 次 · " : "")
          + "已移入工程录音目录并同步 Premiere · "
          + plan.targetName
      );
      updateControls();
      return plan;
    } catch (error) {
      if (!isCancellation(error)) setJobError(error, candidate);
      throw error;
    }
  }

  async function synchronizeNormalizedRecordingNames(candidate) {
    var targetName = Core.fileNameFromPath(candidate.mediaPath);
    var result = await Transaction.synchronizeNames({
      project: candidate.project || context.project,
      projectItem: candidate.projectItem,
      trackItems: candidate.trackItems,
      targetName: targetName,
      expectedMediaPath: candidate.mediaPath,
      samePath: Core.sameNativePath,
      validate: function () {
        return ensureActiveMediaContext(candidate.projectIdentity, candidate.sequenceIdentity);
      },
    });
    if (result.changed) {
      addLog("ok", targetName + "：已补齐 Premiere 素材名和时间线片段名");
    }
    return result;
  }

  async function advancePending(candidate, allEntries, guard) {
    var key = Core.normalizePathForComparison(candidate.mediaPath);
    var existingPending = pendingFiles.get(key);
    var pending = existingPending || {
      firstSeenAt: Date.now(),
      lastChangedAt: Date.now(),
      signature: "",
      stablePolls: 0,
      lockRetries: 0,
      lockWarningReported: false,
      failureCount: 0,
      nextAttemptAt: 0,
      warnedLongRecording: false,
      errorReported: false,
      candidate: candidate,
    };
    pending.candidate = candidate;
    if (!existingPending) setJobStage("found", candidate);
    var now = Date.now();
    if (!automaticCandidateIsTrusted(candidate)) {
      pendingFiles.delete(key);
      seenPaths.add(key);
      return;
    }
    if (now < Number(pending.nextAttemptAt || 0)) {
      pendingFiles.set(key, pending);
      return;
    }

    try {
      var stat = await fs.lstat(candidate.mediaPath);
      if (!pending.freshnessConfirmed) {
        if (!MonitoringPolicy.isFreshFile(stat, armedAtMs, FRESH_FILE_TOLERANCE_MS)) {
          pendingFiles.delete(key);
          seenPaths.add(key);
          return;
        }
        pending.freshnessConfirmed = true;
      }
      pending = MonitoringPolicy.observeFileStability(pending, stat, now);
      pending.candidate = candidate;
      pendingFiles.set(key, pending);
      setJobStage("stable", candidate);

      if (!pending.warnedLongRecording && now - pending.firstSeenAt > PENDING_WARNING_MS) {
        pending.warnedLongRecording = true;
        addLog("warn", Core.fileNameFromPath(candidate.mediaPath) + "：录音仍在写入，将在停止后继续处理");
      }
      if (!MonitoringPolicy.isFileStable(pending, now, {
        requiredPolls: REQUIRED_STABLE_POLLS,
        quietMs: STABLE_QUIET_MS,
      })) return;
      candidate.sourceSignature = statIdentitySignature(stat);
      await ensureCurrentContext(guard.projectIdentity, guard.sequenceIdentity, guard.generation);
      await executeCandidate(candidate, allEntries);
    } catch (error) {
      if (isCancellation(error)) throw error;
      var disposition = MonitoringPolicy.failureDisposition(error);
      var retryableLock = disposition === "retry-file" && isRetryableLock(error);
      pending.failureCount = Number(pending.failureCount || 0) + 1;
      pending.lockRetries = retryableLock ? Number(pending.lockRetries || 0) + 1 : pending.lockRetries;
      pending.stablePolls = 0;
      pending.nextAttemptAt = Date.now() + MonitoringPolicy.retryDelayMs(pending.failureCount, retryableLock);
      pendingFiles.set(key, pending);

      if (retryableLock) {
        if (!pending.lockWarningReported && pending.lockRetries >= LOCK_WARNING_RETRIES) {
          pending.lockWarningReported = true;
          addLog("warn", Core.fileNameFromPath(candidate.mediaPath) + "：Premiere 仍在占用录音文件，释放后会自动继续");
        }
        return;
      }
      if (!pending.errorReported) {
        pending.errorReported = true;
        setJobError(error, candidate);
        sessionMetrics.errors += 1;
        var rollback = error.rollbackWarnings && error.rollbackWarnings.length ? "；回滚提示：" + error.rollbackWarnings.join("；") : "";
        addLog("error", Core.fileNameFromPath(candidate.mediaPath) + "：" + (error.message || error) + "；将自动重试" + rollback);
      }
    }
  }

  async function scanTick() {
    if (!monitoring || tickInFlight || manualScanInFlight) return;
    tickInFlight = true;
    var generation = monitorGuard.current();
    var expectedProjectIdentity = context && context.identity;
    try {
      await withOperationLock(async function () {
        if (!monitoring || !monitorGuard.isCurrent(generation)) throw cancellationError("监听已停止");

        var activeProject = await ppro.Project.getActiveProject();
        if (!activeProject || getProjectIdentity(activeProject) !== expectedProjectIdentity) {
          stopMonitoring("检测到项目切换，监听已停止");
          await refreshContext({ allowAutoStart: false });
          setTimeout(function () {
            refreshContext();
          }, 0);
          return;
        }

        var activeSequence = await activeProject.getActiveSequence();
        var currentSequenceIdentity = getSequenceIdentity(activeSequence);
        var sequenceChanged = currentSequenceIdentity !== activeSequenceIdentity;
        var eventRequested = eventScanRequested;
        eventScanRequested = false;
        var now = Date.now();
        var currentFolderMap = new Map();
        if (watchFolderValid) {
          try {
            var folderFiles = await listWatchedWavePaths();
            folderFiles.forEach(function (nativePath) {
              currentFolderMap.set(Core.normalizePathForComparison(nativePath), nativePath);
            });
          } catch (folderError) {
            watchFolderValid = false;
            watchFolderProblem = "已识别目录暂时不可用，正在重新自动识别";
            addLog("warn", watchFolderProblem);
          }
        }

        var newFolderKeys = new Set();
        currentFolderMap.forEach(function (_nativePath, key) {
          if (!watchedFolderBaseline.has(key)) newFolderKeys.add(key);
        });
        unmatchedFolderFiles.forEach(function (_pendingMatch, key) {
          if (!currentFolderMap.has(key)) unmatchedFolderFiles.delete(key);
        });
        var probeFolderKeys = new Set();
        newFolderKeys.forEach(function (key) {
          var pendingMatch = unmatchedFolderFiles.get(key);
          if (
            sequenceChanged ||
            eventRequested ||
            !pendingMatch ||
            now >= Number(pendingMatch.nextProbeAt || 0)
          ) {
            probeFolderKeys.add(key);
          }
        });

        var fallbackInterval = watchFolderValid ? LEARNED_TRACK_FALLBACK_MS : DISCOVERY_TRACK_SCAN_MS;
        var fullTrackProbeDue = now - lastTrackScanAt >= fallbackInterval;
        if (!sequenceChanged && !eventRequested && !probeFolderKeys.size && !pendingFiles.size && !fullTrackProbeDue) return;

        var snapshot = await collectTrackMedia(context);
        lastTrackScanAt = now;
        if (!monitoring || !monitorGuard.isCurrent(generation)) throw cancellationError("监听已停止");
        if (sequenceChanged) {
          activeSequenceIdentity = snapshot.sequenceIdentity;
          normalizedNameChecks.clear();
          seenPaths = await createInitialPathBaseline(snapshot.entries, armedAtMs);
          pendingFiles.clear();
          unmatchedFolderFiles.clear();
          attachTrackListeners(snapshot.tracks);
          context.sequence = snapshot.sequence;
          context.sequenceIdentity = snapshot.sequenceIdentity;
          setText("sequenceName", snapshot.sequence ? snapshot.sequence.name || "当前序列" : "未打开序列");
          addLog("warn", "序列已切换，新序列现有素材已作为基线");
        }

        var matchedFolderKeys = new Set();
        var currentEntryKeys = new Set();
        for (var index = 0; index < snapshot.entries.length; index += 1) {
          if (!monitoring || !monitorGuard.isCurrent(generation)) throw cancellationError("监听已停止");
          var candidate = snapshot.entries[index];
          var key = Core.normalizePathForComparison(candidate.mediaPath);
          currentEntryKeys.add(key);
          if (currentFolderMap.has(key)) matchedFolderKeys.add(key);
          unmatchedFolderFiles.delete(key);
          if (isNormalizedRecording(candidate)) {
            seenPaths.add(key);
            watchedFolderBaseline.add(key);
            if (!normalizedNameChecks.has(key)) {
              normalizedNameChecks.add(key);
              if (candidate.multipleProjectItems) {
                sessionMetrics.errors += 1;
                panelErrorMessage = "同一路径关联到多个 Premiere 素材，无法安全同步片段名";
                addLog("error", Core.fileNameFromPath(candidate.mediaPath) + "：" + panelErrorMessage);
              } else {
                try {
                  await synchronizeNormalizedRecordingNames(candidate);
                } catch (error) {
                  if (isCancellation(error)) throw error;
                  sessionMetrics.errors += 1;
                  panelErrorMessage = error.message || String(error);
                  var nameRollback = error.rollbackWarnings && error.rollbackWarnings.length
                    ? "；回滚提示：" + error.rollbackWarnings.join("；")
                    : "";
                  addLog("error", Core.fileNameFromPath(candidate.mediaPath) + "：历史名称同步失败：" + (error.message || error) + "；点击“重新检查”后可重试" + nameRollback);
                }
              }
            }
            continue;
          }
          if (candidate.multipleProjectItems) {
            var ambiguityPending = pendingFiles.get(key) || {
              firstSeenAt: now,
              lastChangedAt: now,
              signature: "",
              stablePolls: 0,
              lockRetries: 0,
              lockWarningReported: false,
              failureCount: 0,
              nextAttemptAt: now,
              candidate: candidate,
            };
            ambiguityPending.candidate = candidate;
            ambiguityPending.nextAttemptAt = now + DISCOVERY_TRACK_SCAN_MS;
            pendingFiles.set(key, ambiguityPending);
            if (!ambiguityPending.errorReported) {
              ambiguityPending.errorReported = true;
              sessionMetrics.errors += 1;
              var ambiguousError = new Error("同一路径关联到多个 Premiere 素材，解除重复后会自动重试");
              setJobError(ambiguousError, candidate);
              addLog("error", Core.fileNameFromPath(candidate.mediaPath) + "：" + ambiguousError.message);
            }
            continue;
          }
          if (pendingFiles.has(key)) {
            await advancePending(candidate, snapshot.entries, {
              projectIdentity: expectedProjectIdentity,
              sequenceIdentity: snapshot.sequenceIdentity,
              generation: generation,
            });
            continue;
          }
          if (seenPaths.has(key)) continue;

          var candidateStat;
          try {
            candidateStat = await fs.lstat(candidate.mediaPath);
          } catch (statError) {
            var statPending = {
              firstSeenAt: now,
              lastChangedAt: now,
              signature: "",
              stablePolls: 0,
              lockRetries: 0,
              lockWarningReported: false,
              failureCount: 0,
              nextAttemptAt: now,
              candidate: candidate,
            };
            pendingFiles.set(key, statPending);
            await advancePending(candidate, snapshot.entries, {
              projectIdentity: expectedProjectIdentity,
              sequenceIdentity: snapshot.sequenceIdentity,
              generation: generation,
            });
            continue;
          }

          if (!MonitoringPolicy.isFreshFile(candidateStat, armedAtMs, FRESH_FILE_TOLERANCE_MS)) {
            seenPaths.add(key);
            if (currentFolderMap.has(key)) watchedFolderBaseline.add(key);
            continue;
          }
          if (!automaticCandidateIsTrusted(candidate)) {
            if (capturePathIsTrusted(candidate.mediaPath)) {
              seenPaths.add(key);
              watchedFolderBaseline.add(key);
              continue;
            }
            var deferred = unmatchedFolderFiles.get(key) || { firstSeenAt: now, warned: false, nextProbeAt: now };
            if (!deferred.warned && now - deferred.firstSeenAt > PENDING_WARNING_MS) {
              deferred.warned = true;
              addLog("warn", Core.fileNameFromPath(candidate.mediaPath) + "：无法确认是 Premiere 录音；可点“源目录”指定备用采集目录");
            }
            deferred.nextProbeAt = now + DISCOVERY_TRACK_SCAN_MS;
            unmatchedFolderFiles.set(key, deferred);
            continue;
          }

          await advancePending(candidate, snapshot.entries, {
            projectIdentity: expectedProjectIdentity,
            sequenceIdentity: snapshot.sequenceIdentity,
            generation: generation,
          });
        }

        probeFolderKeys.forEach(function (key) {
          if (matchedFolderKeys.has(key) || watchedFolderBaseline.has(key)) return;
          var pendingMatch = unmatchedFolderFiles.get(key);
          if (!pendingMatch || typeof pendingMatch !== "object") {
            pendingMatch = { firstSeenAt: now, warned: false, nextProbeAt: now };
          }
          var unmatchedAge = now - pendingMatch.firstSeenAt;
          if (!pendingMatch.warned && unmatchedAge > PENDING_WARNING_MS) {
            pendingMatch.warned = true;
            addLog("warn", Core.fileNameFromPath(currentFolderMap.get(key)) + "：暂未在当前序列找到，将继续等待关联");
          }
          pendingMatch.nextProbeAt = now + (unmatchedAge > 300000 ? UNMATCHED_LONG_RETRY_MS : unmatchedAge > PENDING_WARNING_MS ? UNMATCHED_RETRY_MS : POLL_INTERVAL_MS);
          unmatchedFolderFiles.set(key, pendingMatch);
        });
        pendingFiles.forEach(function (_pending, key) {
          if (!currentEntryKeys.has(key)) {
            pendingFiles.delete(key);
          }
        });
      });
    } catch (error) {
      if (isCancellation(error)) {
        currentJob = null;
      } else {
        sessionMetrics.errors += 1;
        if (currentJobIsProcessing()) setJobError(error);
        else panelErrorMessage = error.message || String(error);
        addLog("error", "监听扫描失败: " + (error.message || error));
      }
    } finally {
      tickInFlight = false;
      updateControls();
    }
  }

  async function stableFileInfo(nativePath, lifecycleGeneration) {
    var observation = null;
    var latestStat = null;
    for (var attempt = 0; attempt < 14; attempt += 1) {
      ensureLifecycle(lifecycleGeneration);
      latestStat = await fs.lstat(nativePath);
      var now = Date.now();
      observation = MonitoringPolicy.observeFileStability(observation, latestStat, now);
      if (MonitoringPolicy.isFileStable(observation, now, {
        requiredPolls: REQUIRED_STABLE_POLLS,
        quietMs: STABLE_QUIET_MS,
      })) {
        return { sourceSignature: statIdentitySignature(latestStat) };
      }
      await new Promise(function (resolve) {
        setTimeout(resolve, 350);
      });
    }
    throw new Error("文件仍在写入");
  }

  async function buildManualPlans(candidates, allEntries, lifecycleGeneration) {
    var plans = [];
    var virtualEntries = allEntries.slice();

    for (var index = 0; index < candidates.length; index += 1) {
      ensureLifecycle(lifecycleGeneration);
      var candidate = candidates[index];
      setJobStage("found", candidate);
      var stableInfo = await stableFileInfo(candidate.mediaPath, lifecycleGeneration);
      candidate.sourceSignature = stableInfo.sourceSignature;
      var plan = await targetPlanFor(candidate, virtualEntries);
      setJobStage("stable", candidate, plan);
      plans.push(plan);
      virtualEntries.push({ mediaPath: plan.targetPath });
    }
    return plans;
  }

  function showScanPreview(plans) {
    var preview = element("scanPreview");
    preview.textContent = "";
    plans.forEach(function (plan) {
      var row = document.createElement("div");
      row.className = "preview-row";
      var source = document.createElement("div");
      source.className = "preview-source";
      source.textContent = Core.fileNameFromPath(plan.candidate.mediaPath);
      var target = document.createElement("div");
      target.className = "preview-target";
      target.textContent = "→ " + plan.targetName;
      row.appendChild(source);
      row.appendChild(target);
      preview.appendChild(row);
    });
    element("scanDialogCount").textContent = plans.length + " 条";
  }

  async function confirmManualPlans(plans) {
    showScanPreview(plans);
    var dialog = element("scanDialog");
    try {
      var result = typeof dialog.uxpShowModal === "function"
        ? await dialog.uxpShowModal({
            title: "处理遗漏录音",
            resize: "both",
            size: { width: 520, height: 540 },
            minSize: { width: 340, height: 360 },
          })
        : await dialog.showModal();
      return result === "execute";
    } catch (error) {
      return false;
    }
  }

  async function runManualScanOperation(lifecycleGeneration) {
    ensureLifecycle(lifecycleGeneration);
    await refreshContext({ allowAutoStart: false });
    ensureLifecycle(lifecycleGeneration);
    if (!context || !context.sequence) throw new Error("请先打开一个序列");

    var expectedProjectIdentity = context.identity;
    var snapshot = await collectTrackMedia(context);
    ensureLifecycle(lifecycleGeneration);
    var expectedSequenceIdentity = snapshot.sequenceIdentity;
    var conflicts = snapshot.entries.filter(function (entry) {
      return entry.multipleProjectItems;
    });
    conflicts.forEach(function (entry) {
      sessionMetrics.errors += 1;
      addLog("error", Core.fileNameFromPath(entry.mediaPath) + "：同一路径关联到多个 Premiere 素材，已跳过");
    });
    var candidates = snapshot.entries.filter(function (entry) {
      return !entry.multipleProjectItems && !isNormalizedRecording(entry) && capturePathIsTrusted(entry.mediaPath);
    });
    if (!candidates.length) {
      currentJob = null;
      addLog("ok", "当前序列没有遗漏录音");
      updateControls();
      return;
    }

    var dated = [];
    for (var index = 0; index < candidates.length; index += 1) {
      ensureLifecycle(lifecycleGeneration);
      var stat = await fs.lstat(candidates[index].mediaPath);
      dated.push({
        candidate: candidates[index],
        time: statTimestamp(stat).getTime(),
        pathKey: Core.normalizePathForComparison(candidates[index].mediaPath),
      });
    }
    dated.sort(function (left, right) {
      if (left.time !== right.time) return left.time - right.time;
      return left.pathKey < right.pathKey ? -1 : left.pathKey > right.pathKey ? 1 : 0;
    });
    candidates = dated.map(function (entry) {
      return entry.candidate;
    });

    var plans = await buildManualPlans(candidates, snapshot.entries, lifecycleGeneration);
    ensureLifecycle(lifecycleGeneration);
    var confirmed = await confirmManualPlans(plans);
    ensureLifecycle(lifecycleGeneration);
    if (!confirmed) {
      currentJob = null;
      updateControls();
      return;
    }
    await ensureCurrentContext(expectedProjectIdentity, expectedSequenceIdentity, null, lifecycleGeneration);
    manualScanExecuting = true;
    if (plans.length) setJobStage("found", plans[0].candidate, plans[0]);
    else updateControls();

    for (var planIndex = 0; planIndex < plans.length; planIndex += 1) {
      await ensureCurrentContext(expectedProjectIdentity, expectedSequenceIdentity, null, lifecycleGeneration);
      try {
        await executeCandidate(plans[planIndex].candidate, snapshot.entries, plans[planIndex]);
        snapshot.entries.push({ mediaPath: plans[planIndex].targetPath });
      } catch (error) {
        if (isCancellation(error)) throw error;
        sessionMetrics.errors += 1;
        var rollback = error.rollbackWarnings && error.rollbackWarnings.length ? "；回滚提示：" + error.rollbackWarnings.join("；") : "";
        addLog("error", Core.fileNameFromPath(plans[planIndex].candidate.mediaPath) + "：" + (error.message || error) + rollback);
      }
    }
  }

  async function scanMissedRecordings() {
    if (manualScanInFlight) return;
    manualScanInFlight = true;
    manualScanExecuting = false;
    panelErrorMessage = "";
    currentJob = null;
    var lifecycleGeneration = lifecycleGuard.current();
    updateControls();
    try {
      await withOperationLock(function () {
        return runManualScanOperation(lifecycleGeneration);
      });
    } catch (error) {
      if (isCancellation(error)) {
        currentJob = null;
        if (lifecycleGuard.isCurrent(lifecycleGeneration)) addLog("warn", "批处理已取消: " + (error.message || error));
      } else {
        sessionMetrics.errors += 1;
        if (currentJob) setJobError(error);
        else panelErrorMessage = error.message || String(error);
        addLog("error", "扫描遗漏失败: " + (error.message || error));
      }
    } finally {
      manualScanInFlight = false;
      manualScanExecuting = false;
      updateControls();
    }
  }

  async function chooseWatchFolder() {
    try {
      panelErrorMessage = "";
      await refreshContext({ allowAutoStart: false });
      if (!context) throw new Error("未连接 Premiere 项目");
      if (!projectIsSaved()) throw new Error("请先保存 Premiere 工程");
      var folder = await uxp.storage.localFileSystem.getFolder();
      if (!folder) return;
      var nativePath = folder.nativePath || uxp.storage.localFileSystem.getNativePath(folder);
      if (!nativePath) throw new Error("无法取得目录路径");
      var inspection = await FolderReadiness.inspect(fs, nativePath);
      if (!inspection.valid) throw new Error(inspection.problem || "录音目录不可用");

      var previousState = projectState;
      var previousFolderValid = watchFolderValid;
      var previousFolderProblem = watchFolderProblem;
      projectState = State.withSettings(projectState, { watchFolder: nativePath });
      try {
        await saveProjectState();
      } catch (error) {
        projectState = previousState;
        watchFolderValid = previousFolderValid;
        watchFolderProblem = previousFolderProblem;
        throw error;
      }
      applyWatchFolderInspection(inspection);
      addLog("ok", "备用采集目录已设为 " + nativePath);
      updateControls();
    } catch (error) {
      sessionMetrics.errors += 1;
      panelErrorMessage = error.message || String(error);
      addLog("error", error.message || String(error));
      updateControls();
    }
  }

  async function saveSetting(name, value) {
    try {
      await withOperationLock(async function () {
        if (!context || !projectState) return;
        var settings = {};
        settings[name] = value;
        projectState = State.withSettings(projectState, settings);
        await saveProjectState();
      });
    } catch (error) {
      sessionMetrics.errors += 1;
      panelErrorMessage = error.message || String(error);
      addLog("error", "设置保存失败: " + (error.message || error));
    }
    updateControls();
  }

  function handlePrimaryAction() {
    if (primaryAction === "start" || primaryAction === "resume") {
      userPaused = false;
      startMonitoring(false);
    } else if (primaryAction === "refresh") {
      panelErrorMessage = "";
      userPaused = false;
      normalizedNameChecks.clear();
      refreshContext();
    }
  }

  function onStopButtonClick() {
    stopMonitoring("自动命名已暂停", { pause: true });
  }

  function onRefreshButtonClick() {
    normalizedNameChecks.clear();
    if (monitoring) {
      panelErrorMessage = "";
      requestSoonScan();
      updateControls();
      return;
    }
    refreshContext({ allowAutoStart: false });
  }

  function onCancelScanClick() {
    element("scanDialog").close("cancel");
  }

  function onConfirmScanClick() {
    element("scanDialog").close("execute");
  }

  function onWindowError(event) {
    sessionMetrics.errors += 1;
    var error = event.error instanceof Error ? event.error : new Error(event.message || String(event.error || event));
    if (currentJobIsProcessing()) setJobError(error);
    else panelErrorMessage = error.message;
    addLog("error", "脚本错误: " + (event.message || event.error || event));
    updateControls();
  }

  function onUnhandledRejection(event) {
    sessionMetrics.errors += 1;
    var reason = event.reason instanceof Error ? event.reason : new Error(String(event.reason));
    if (currentJobIsProcessing()) setJobError(reason);
    else panelErrorMessage = reason.message;
    addLog("error", "异步错误: " + (event.reason && event.reason.message ? event.reason.message : event.reason));
    updateControls();
  }

  function wireUI() {
    if (wired) return;
    if (!element("startButton")) return;
    wired = true;

    element("chooseFolderButton").addEventListener("click", chooseWatchFolder);
    element("startButton").addEventListener("click", handlePrimaryAction);
    element("stopButton").addEventListener("click", onStopButtonClick);
    element("scanButton").addEventListener("click", scanMissedRecordings);
    element("refreshButton").addEventListener("click", onRefreshButtonClick);
    element("clearLogButton").addEventListener("click", clearLog);
    element("cancelScanButton").addEventListener("click", onCancelScanClick);
    element("closeScanButton").addEventListener("click", onCancelScanClick);
    element("confirmScanButton").addEventListener("click", onConfirmScanClick);
    window.addEventListener("error", onWindowError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
  }

  function unwireUI() {
    if (!wired) return;
    var bindings = [
      ["chooseFolderButton", chooseWatchFolder],
      ["startButton", handlePrimaryAction],
      ["stopButton", onStopButtonClick],
      ["scanButton", scanMissedRecordings],
      ["refreshButton", onRefreshButtonClick],
      ["clearLogButton", clearLog],
      ["cancelScanButton", onCancelScanClick],
      ["closeScanButton", onCancelScanClick],
      ["confirmScanButton", onConfirmScanClick],
    ];
    bindings.forEach(function (binding) {
      var node = element(binding[0]);
      if (node) node.removeEventListener("click", binding[1]);
    });
    window.removeEventListener("error", onWindowError);
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
    wired = false;
  }

  function initializePanel() {
    wireUI();
    userPaused = false;
    attachGlobalImportListener();
    refreshContext();
  }

  uxp.entrypoints.setup({
    panels: {
      voiceoverNamer: {
        create: function () {},
        show: function () {
          panelVisible = true;
          initializePanel();
        },
        hide: function () {
          panelVisible = false;
          contextRefreshGeneration += 1;
          lifecycleGuard.bump();
          stopMonitoring();
          detachGlobalImportListener();
        },
        destroy: function () {
          panelVisible = false;
          contextRefreshGeneration += 1;
          lifecycleGuard.bump();
          try {
            var dialog = element("scanDialog");
            if (dialog && dialog.open) dialog.close("cancel");
          } catch (error) {}
          stopMonitoring();
          detachGlobalImportListener();
          unwireUI();
        },
      },
    },
  });

  if (document.readyState !== "loading") wireUI();
  else document.addEventListener("DOMContentLoaded", wireUI);
})();
