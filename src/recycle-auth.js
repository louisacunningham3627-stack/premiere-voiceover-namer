(function (root, factory) {
  "use strict";
  if (typeof module !== "undefined" && module.exports) module.exports = factory(require("./sha256.js"));
  else root.VoiceoverNamerRecycleAuth = factory(root.VoiceoverNamerSha256);
})(typeof globalThis !== "undefined" ? globalThis : this, function (Hash) {
  "use strict";
  function utf8(text) {
    var encoded = encodeURIComponent(text);
    var bytes = [];
    for (var i = 0; i < encoded.length; i += 1) {
      if (encoded[i] === "%") { bytes.push(parseInt(encoded.slice(i + 1, i + 3), 16)); i += 2; }
      else bytes.push(encoded.charCodeAt(i));
    }
    return new Uint8Array(bytes);
  }
  function hexBytes(value) {
    var bytes = new Uint8Array(value.length / 2);
    for (var i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
    return bytes;
  }
  function payload(record) {
    return ["schemaVersion", "projectIdentity", "projectPath", "recordingId", "projectItemId", "targetPath", "size", "sha256", "birthtimeMs", "registeredAt"]
      .map(function (name) { var value = String(record[name]); return value.length + ":" + value; }).join("|");
  }
  function sign(record, token) {
    if (!/^[0-9a-f]{64}$/.test(token)) throw new Error("回收助手凭据无效");
    var key = hexBytes(token);
    var inner = new Uint8Array(64);
    var outer = new Uint8Array(64);
    for (var i = 0; i < 64; i += 1) { inner[i] = (key[i] || 0) ^ 0x36; outer[i] = (key[i] || 0) ^ 0x5c; }
    var digest = Hash.createHasher().update(inner).update(utf8(payload(record))).digestHex();
    return Hash.createHasher().update(outer).update(hexBytes(digest)).digestHex();
  }
  return { sign: sign, payload: payload };
});
