(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.VoiceoverNamerRecycleHost = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function list(value) {
    if (!Array.isArray(value)) throw new Error("回收检查未取得完整列表，保留录音");
    return value;
  }
  async function identity(item) {
    var id = String(await item.getId());
    if (!id || id === "undefined" || id === "null") throw new Error("素材身份不可读，保留录音");
    return id;
  }

  async function snapshot(project, ppro, normalize, validate) {
    var ids = new Set();
    var paths = new Set();
    var items = [];
    var visited = new Set();
    var folderIds = new Set();
    async function clipFor(raw) {
      var clip = ppro.ClipProjectItem.cast(raw);
      if (!clip) throw new Error("无法读取素材类型，保留录音");
      return clip;
    }
    async function mediaPath(clip) {
      if (typeof clip.isMergedClip === "function" && await clip.isMergedClip()) {
        throw new Error("存在合并素材，无法完整证明底层引用，保留录音");
      }
      var path = await clip.getMediaFilePath();
      if (typeof path !== "string" || !path.trim()) throw new Error("存在源文件不可确认的素材，保留录音");
      return path;
    }
    async function sequence(seq) {
      await validate();
      if (!seq || !seq.guid) throw new Error("序列身份不可读，保留录音");
      var key = String(seq.guid);
      if (visited.has(key)) return;
      visited.add(key);
      for (var kind of ["Audio", "Video"]) {
        var count = await seq["get" + kind + "TrackCount"]();
        if (!Number.isInteger(count) || count < 0) throw new Error("轨道列表不完整，保留录音");
        for (var n = 0; n < count; n += 1) {
          var track = await seq["get" + kind + "Track"](n);
          var clips = list(await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false));
          for (var trackItem of clips) {
            var raw = await trackItem.getProjectItem();
            ids.add(await identity(raw));
            var clip = await clipFor(raw);
            if (await clip.isSequence()) {
              await sequence(await clip.getSequence());
            } else {
              paths.add(normalize(await mediaPath(clip)));
            }
          }
          await validate();
        }
      }
    }
    async function folder(parent) {
      var key = await identity(parent);
      if (folderIds.has(key)) throw new Error("项目文件夹结构重复，保留录音");
      folderIds.add(key);
      for (var raw of list(await parent.getItems())) {
        var child = null;
        try { child = ppro.FolderItem.cast(raw); } catch (castError) { /* A media item is not a folder. */ }
        if (child) {
          await folder(child);
        } else {
          var clip = await clipFor(raw);
          if (await clip.isSequence()) await sequence(await clip.getSequence());
          else items.push({ id: await identity(raw), path: await mediaPath(clip), raw: raw, parent: parent });
        }
      }
      await validate();
    }
    var sequences = list(await project.getSequences());
    for (var seq of sequences) await sequence(seq);
    await folder(await project.getRootItem());
    await validate();
    return { complete: true, ids: ids, paths: paths, items: items };
  }

  async function removeUnusedItem(project, entry) {
    var result = false;
    await project.lockedAccess(function () {
      result = project.executeTransaction(function (compound) {
        compound.addAction(entry.parent.createRemoveItemAction(entry.raw));
      }, "回收已弃用录音的素材项");
    });
    if (await result !== true) throw new Error("录音已回收，但 Premiere 素材项移除失败");
  }
  return { snapshot: snapshot, removeUnusedItem: removeUnusedItem };
});
