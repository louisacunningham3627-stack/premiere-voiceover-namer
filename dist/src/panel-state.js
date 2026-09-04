(function (root, factory) {
  "use strict";

  var api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.VoiceoverNamerPanelState = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var PIPELINE_STAGES = ["found", "stable", "rename", "relink"];

  function readiness(input) {
    var values = {
      project: input.hasProject === true && input.projectSaved === true,
      sequence: input.hasSequence === true,
    };
    values.completed = [values.project, values.sequence].filter(Boolean).length;
    return values;
  }

  function view(mode, tone, statusLabel, kicker, title, description, primaryAction, primaryLabel, showStop, ready) {
    return {
      mode: mode,
      tone: tone,
      statusLabel: statusLabel,
      kicker: kicker,
      title: title,
      description: description,
      primaryAction: primaryAction || "",
      primaryLabel: primaryLabel || "",
      showStop: showStop === true,
      busy: ["loading", "starting", "scanning", "processing"].indexOf(mode) >= 0,
      readiness: ready,
    };
  }

  function derivePanelState(input) {
    input = input || {};
    var ready = readiness(input);
    var showStop = input.monitoring === true;

    if (input.starting === true) {
      return view("starting", "busy", "布防中", "正在连接原生录音", "建立当前素材基线", "完成后直接点击时间线音轨上的麦克风。", "", "", false, ready);
    }
    if (input.errorMessage) {
      return view(
        "error",
        "error",
        "出错",
        "上一项操作未完成",
        "需要检查",
        String(input.errorMessage),
        showStop ? "" : "refresh",
        showStop ? "" : "重新连接",
        showStop,
        ready
      );
    }
    if (input.processing === true) {
      return view("processing", "busy", "处理中", "检测到原生录音", "正在整理文件", "录音停止写入后会移入工程媒体目录并更新 Premiere 链接。", "", "", showStop, ready);
    }
    if (input.scanning === true) {
      return view("scanning", "busy", "扫描中", "正在检查遗漏", "扫描当前序列", "找到未整理的录音后，会先显示文件名预览。", "", "", showStop, ready);
    }
    if (input.refreshing === true) {
      return view("loading", "busy", "连接中", "正在读取 Premiere", "检查当前工程", "正在核对工程、活动序列和最终保存目录。", "", "", false, ready);
    }
    if (input.hasProject !== true) {
      return view("disconnected", "warning", "未连接", "还未找到工程", "打开一个 Premiere 工程", "打开工程后回到这里重新检查。", "refresh", "重新检查", false, ready);
    }
    if (input.projectSaved !== true) {
      return view("unsaved", "warning", "待准备", "还差保存工程", "先保存 Premiere 工程", "保存后插件才能用项目名生成录音文件名。", "refresh", "保存后重新连接", false, ready);
    }
    if (input.hasSequence !== true) {
      return view("no-sequence", "warning", "待准备", "还差活动序列", "打开要录音的序列", "打开序列后，插件会自动布防。", "refresh", "序列打开后连接", false, ready);
    }
    if (input.monitoring === true) {
      return view("listening", "active", "自动待命", "无需插件前置操作", "直接点音轨麦克风录音", "录音结束后会自动移入工程媒体目录、命名并重链接。", "", "", true, ready);
    }
    if (input.paused === true) {
      return view("paused", "warning", "已暂停", "自动命名没有运行", "恢复后继续录音", "恢复只需一次，不必重新选择目录或重启 Premiere。", "resume", "恢复自动命名", false, ready);
    }
    return view("ready", "ready", "准备完成", "正在自动启动", "连接原生录音", "稍候即可直接点击时间线音轨麦克风。", "start", "立即启用", false, ready);
  }

  function derivePipeline(input) {
    input = input || {};
    var currentStage = String(input.stage || "");
    var errorStage = String(input.errorStage || "");
    var result = PIPELINE_STAGES.map(function (name) {
      return { name: name, status: "waiting" };
    });

    if (!currentStage) return result;

    if (currentStage === "complete") {
      result.forEach(function (entry) {
        entry.status = "done";
      });
      return result;
    }

    var stageForIndex = currentStage === "error" ? errorStage : currentStage;
    var activeIndex = PIPELINE_STAGES.indexOf(stageForIndex);
    if (activeIndex < 0) return result;

    result.forEach(function (entry, index) {
      if (index < activeIndex) entry.status = "done";
      if (index === activeIndex) entry.status = currentStage === "error" ? "error" : "active";
    });
    return result;
  }

  return {
    PIPELINE_STAGES: PIPELINE_STAGES.slice(),
    derivePanelState: derivePanelState,
    derivePipeline: derivePipeline,
  };
});
