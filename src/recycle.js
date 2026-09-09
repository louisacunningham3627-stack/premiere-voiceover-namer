(function (root, factory) {
  "use strict";
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory(require("./core.js"), require("./recycle-policy.js"), require("./recycle-auth.js"));
  } else root.VoiceoverNamerRecycle = factory(root.VoiceoverNamerCore, root.VoiceoverNamerRecyclePolicy, root.VoiceoverNamerRecycleAuth);
})(typeof globalThis !== "undefined" ? globalThis : this, function (Core, Policy, Auth) {
  "use strict";

  function join(dir, name) { return Core.joinNativePath(dir, name, Core.splitNativePath(dir).separator); }
  function timestamp(stat) { return Number(stat.birthtimeMs || (stat.birthtime && new Date(stat.birthtime).getTime()) || 0); }
  function create(options) {
    var fs = options.fs;
    var context = options.context;
    var registryPath = context.statePath + ".recordings";
    var policy = Policy.createPolicy(Core.normalizePathForComparison);
    var records = [];
    var loaded = false;
    var nextScan = 0;
    var job = null;
    var disabled = false;
    var bridge = null;
    var now = options.now || Date.now;
    async function read(path) { return JSON.parse(String(await fs.readFile(path, { encoding: "utf-8" }))); }
    async function write(path, value) {
      await fs.writeFile(path, JSON.stringify(value), { encoding: "utf-8", flag: "wx" });
    }
    async function exists(path) {
      try { await fs.lstat(path); return true; }
      catch (e) { if (String(e.code) === "ENOENT") return false; throw e; }
    }
    function recordPath(record) { return join(registryPath, record.recordingId + ".json"); }
    function destination(record) {
      var directory = Core.recordingDirectoryFromProjectPath(context.project.path);
      var name = Core.fileNameFromPath(record.targetPath);
      if (!name.endsWith("-" + record.recordingId + ".wav")) return "";
      return join(directory, name);
    }
    async function load() {
      if (loaded) return;
      if (await exists(registryPath)) {
        var names = await fs.readdir(registryPath);
        var ignored = 0;
        for (var name of names) {
          if (!/^[0-9a-f]{32}\.json$/.test(name)) continue;
          var record = await read(join(registryPath, name));
          if (!bridge) bridge = await options.bridge();
          if (record.mac !== Auth.sign(record, bridge.token)
              || !Policy.validRecord(record, context, Core.sameNativePath, destination)) {
            ignored += 1;
            continue;
          }
          if (name !== record.recordingId + ".json") throw new Error("回收登记身份不匹配");
          // A committed or uncertain operation is never automatically replayed after restart.
          if (!(await exists(recordPath(record) + ".issued"))) records.push(record);
        }
        if (ignored) options.log("warn", "已保护 " + ignored + " 条不匹配当前本机工程的旧登记，不纳入自动回收");
      }
      loaded = true;
    }
    async function register(plan, candidate) {
      await options.validate();
      await load();
      if (!bridge) bridge = await options.bridge();
      if (!candidate.projectItemId || !candidate.trackItems || !candidate.trackItems.length) return;
      var before = await fs.lstat(plan.targetPath);
      var hash = await options.hashFile(fs, plan.targetPath);
      var after = await fs.lstat(plan.targetPath);
      if (options.signature(before) !== options.signature(after) || hash.size !== Number(after.size)) {
        throw new Error("录音仍在变化，未授予自动回收权限");
      }
      var record = {
        schemaVersion: 1, projectIdentity: context.identity, projectPath: context.project.path,
        recordingId: plan.recordingId, projectItemId: candidate.projectItemId,
        targetPath: plan.targetPath, size: hash.size, sha256: hash.digest,
        birthtimeMs: Math.floor(timestamp(after)), registeredAt: new Date().toISOString(),
      };
      record.mac = Auth.sign(record, bridge.token);
      if (!Policy.validRecord(record, context, Core.sameNativePath, destination)) throw new Error("文件身份不足，未登记自动回收");
      await options.ensureFolder(registryPath);
      if (await exists(recordPath(record))) throw new Error("回收登记已存在，保留旧记录");
      await options.validate();
      await write(recordPath(record), record);
      var verified = await read(recordPath(record));
      if (JSON.stringify(verified) !== JSON.stringify(record)) throw new Error("回收登记写入校验失败");
      records.push(record);
      policy.arm(record);
    }
    function associated(record, snapshot) {
      var matching = snapshot.items.filter(function (entry) {
        return entry.id === record.projectItemId || (entry.path && Core.sameNativePath(entry.path, record.targetPath));
      });
      if (matching.some(function (entry) {
        return entry.id !== record.projectItemId || !Core.sameNativePath(entry.path, record.targetPath);
      })) throw new Error("录音已被重新链接或重复导入，保留文件");
      return matching;
    }
    async function prepare(record) {
      if (!bridge) bridge = await options.bridge();
      var id = Core.createRecordingId(options.randomSource);
      var path = join(bridge.directory, id);
      var request = { version: 1, id: id, token: bridge.token, expiresAt: now() + 25000, recordPath: recordPath(record) };
      await write(path + ".request.json", request);
      job = { id: id, path: path, record: record, expiresAt: request.expiresAt, committed: false };
      await options.launch("hechao-voiceover-recycle://job/" + id);
    }
    async function poll() {
      var current = job;
      var resultPath = current.path + ".result.json";
      if (await exists(resultPath)) {
        var result = await read(resultPath);
        if (result.id !== current.id || result.token !== bridge.token) throw new Error("回收助手响应不匹配");
        job = null;
        if (result.status !== "recycled") throw new Error("回收未完成，保留文件：" + String(result.message || result.status));
        if (await exists(current.record.targetPath)) throw new Error("回收结果与磁盘状态不符，保留 Premiere 素材项");
        records = records.filter(function (record) { return record.recordingId !== current.record.recordingId; });
        await options.validate();
        var after = await options.snapshot();
        if (Policy.referenced(current.record, after, Core.normalizePathForComparison)) {
          throw new Error("回收后检测到重新引用，请从系统回收站还原该录音");
        }
        for (var entry of associated(current.record, after)) await options.removeItem(entry);
        options.log("ok", "已移入系统回收站：" + Core.fileNameFromPath(current.record.targetPath));
        return;
      }
      if (now() > current.expiresAt) {
        job = null;
        throw new Error(current.committed ? "回收助手结果未确认，已停止自动重试；请检查系统回收站" : "回收助手未响应，本次未提交回收");
      }
      if (!current.committed && await exists(current.path + ".ready.json")) {
        var ready = await read(current.path + ".ready.json");
        if (ready.id !== current.id || ready.token !== bridge.token) throw new Error("回收助手身份不匹配");
        await options.validate();
        var finalSnapshot = await options.snapshot();
        if (Policy.referenced(current.record, finalSnapshot, Core.normalizePathForComparison)) {
          job = null;
          policy.observe(records, finalSnapshot, now());
          return;
        }
        associated(current.record, finalSnapshot);
        await options.validate();
        await write(recordPath(current.record) + ".issued", { id: current.id, at: new Date().toISOString() });
        await options.validate();
        // Invoking the commit write is the point of no return, including an uncertain write result.
        current.committed = true;
        await write(current.path + ".commit.json", { id: current.id, token: bridge.token, at: now() });
      }
    }
    async function tick() {
      if (disabled) return;
      try {
        await options.validate();
        await load();
        if (job) { await poll(); return; }
        if (!records.length || now() < nextScan) return;
        nextScan = now() + 10000;
        var snapshot = await options.snapshot();
        var ready = policy.observe(records, snapshot, now());
        if (ready.length) {
          associated(ready[0], snapshot);
          await options.validate();
          await prepare(ready[0]);
        }
      } catch (error) {
        policy.reset();
        disabled = true;
        options.log("warn", "自动回收已暂停：" + (error.message || error) + "；可点击刷新项目重新检查");
      }
    }
    return {
      register: register, tick: tick,
      stop: function () { disabled = true; policy.reset(); },
      retry: function () {
        disabled = false;
        if (job && job.committed) return;
        job = null; records = []; loaded = false; nextScan = 0; policy.reset();
      },
    };
  }
  return { create: create };
});
