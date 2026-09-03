(function (root, factory) {
  "use strict";

  var api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.VoiceoverNamerMediaCandidates = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function trackItemsFromEntry(entry) {
    var items = [];
    if (entry && Array.isArray(entry.trackItems)) items = items.concat(entry.trackItems);
    if (entry && entry.trackItem) items.push(entry.trackItem);
    return items.filter(function (item) {
      return !!item;
    });
  }

  function deduplicate(entries, normalizePath) {
    var grouped = new Map();
    (entries || []).forEach(function (entry) {
      var key = normalizePath ? normalizePath(entry.mediaPath) : String(entry.mediaPath || "");
      var hasProjectItemId = entry.projectItemId != null && String(entry.projectItemId) !== "";
      if (!grouped.has(key)) {
        grouped.set(key, {
          entry: entry,
          projectItemIds: new Set(),
          identityUnavailable: false,
          trackItems: [],
          trackItemIdentities: new Set(),
        });
      }
      var group = grouped.get(key);
      if (hasProjectItemId) group.projectItemIds.add(String(entry.projectItemId));
      else group.identityUnavailable = true;
      trackItemsFromEntry(entry).forEach(function (trackItem) {
        if (group.trackItemIdentities.has(trackItem)) return;
        group.trackItemIdentities.add(trackItem);
        group.trackItems.push(trackItem);
      });
    });
    return Array.from(grouped.values()).map(function (group) {
      // TrackItem wrappers are not stable object identities in UXP. Only two
      // distinct Premiere IDs prove a conflict here; the project-tree check
      // runs again immediately before any filesystem change.
      group.entry.multipleProjectItems = group.projectItemIds.size > 1;
      group.entry.projectItemIdentityUnavailable = group.identityUnavailable;
      group.entry.trackItems = group.trackItems.slice();
      return group.entry;
    });
  }

  return {
    deduplicate: deduplicate,
  };
});
