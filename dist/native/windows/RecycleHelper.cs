using System;
using System.Collections.Generic;
using System.IO;
using System.Globalization;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

// A single authenticated request per process. No service, network listener, or startup task.
public static class RecycleHelper
{
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 65536 };
    static readonly DateTime Epoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);
    static long Now() { return (long)(DateTime.UtcNow - Epoch).TotalMilliseconds; }
    public static string JobId(string value)
    {
        if (!Regex.IsMatch(value ?? "", "^hechao-voiceover-recycle://job/[0-9a-f]{32}$"))
            throw new InvalidDataException("无效的回收请求地址");
        return value.Substring(value.Length - 32);
    }
    static Dictionary<string, object> Read(string path)
    {
        AssertPlainPath(path);
        var info = new FileInfo(path);
        if (info.Length > 65536) throw new InvalidDataException("回收请求过大");
        return Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(path, Encoding.UTF8));
    }
    static string Text(Dictionary<string, object> value, string key)
    {
        object field;
        if (!value.TryGetValue(key, out field) || !(field is string)) throw new InvalidDataException("回收字段缺失");
        return (string)field;
    }
    static double Number(Dictionary<string, object> value, string key)
    {
        object field;
        if (!value.TryGetValue(key, out field) || field is string || field == null) throw new InvalidDataException("回收数值缺失");
        var result = Convert.ToDouble(field);
        if (Double.IsNaN(result) || Double.IsInfinity(result)) throw new InvalidDataException("回收数值无效");
        return result;
    }
    public static void AssertPlainPath(string path)
    {
        if (!Regex.IsMatch(path ?? "", @"^[a-zA-Z]:\\") || path.IndexOf(':', 2) >= 0 || path.Contains("/"))
            throw new InvalidDataException("回收仅支持本地绝对路径");
        if (!String.Equals(Path.GetFullPath(path), path, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("拒绝非规范回收路径");
        string current = path;
        while (!String.IsNullOrEmpty(current))
        {
            if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                throw new InvalidDataException("拒绝通过链接或挂载点回收");
            current = Path.GetDirectoryName(current);
        }
    }
    static bool Same(string left, string right) { return String.Equals(left, right, StringComparison.OrdinalIgnoreCase); }
    static void WriteResult(string path, string id, string status, string message, string token)
    {
        var output = new Dictionary<string, object> { { "id", id }, { "status", status }, { "message", message }, { "token", token } };
        var temporary = path + ".tmp";
        using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
        using (var writer = new StreamWriter(stream, new UTF8Encoding(false))) writer.Write(Json.Serialize(output));
        File.Move(temporary, path);
    }
    static void VerifySignature(Dictionary<string, object> record, string token)
    {
        var fields = new[] { "schemaVersion", "projectIdentity", "projectPath", "recordingId", "projectItemId", "targetPath", "size", "sha256", "birthtimeMs", "registeredAt" };
        var values = new List<string>();
        foreach (var field in fields)
        {
            string value;
            if (field == "schemaVersion" || field == "size" || field == "birthtimeMs")
            {
                var number = Number(record, field);
                if (number != Math.Truncate(number) || number < 0) throw new InvalidDataException("登记数值无效");
                value = number.ToString("0", CultureInfo.InvariantCulture);
            }
            else value = Text(record, field);
            values.Add(value.Length.ToString(CultureInfo.InvariantCulture) + ":" + value);
        }
        var key = new byte[32];
        for (int i = 0; i < key.Length; i++) key[i] = Convert.ToByte(token.Substring(i * 2, 2), 16);
        using (var hmac = new HMACSHA256(key))
        {
            var digest = BitConverter.ToString(hmac.ComputeHash(Encoding.UTF8.GetBytes(String.Join("|", values.ToArray())))).Replace("-", "").ToLowerInvariant();
            if (digest != Text(record, "mac")) throw new InvalidDataException("录音登记签名不匹配，保留文件");
        }
    }
    static void Fresh(Dictionary<string, object> request)
    {
        var expiry = Number(request, "expiresAt");
        if (expiry < Now() || expiry > Now() + 30000) throw new InvalidDataException("回收请求已过期");
    }
    public static string ValidateRecord(Dictionary<string, object> record, string registryPath)
    {
        if (Number(record, "schemaVersion") != 1) throw new InvalidDataException("未知的录音登记版本");
        var id = Text(record, "recordingId");
        if (!Regex.IsMatch(id, "^[0-9a-f]{32}$") || !Regex.IsMatch(Text(record, "sha256"), "^[0-9a-f]{64}$"))
            throw new InvalidDataException("录音登记身份无效");
        if (String.IsNullOrEmpty(Text(record, "projectIdentity")) || String.IsNullOrEmpty(Text(record, "projectItemId")))
            throw new InvalidDataException("录音项目身份缺失");
        var project = Text(record, "projectPath");
        AssertPlainPath(project);
        if (!Same(Path.GetExtension(project), ".prproj")) throw new InvalidDataException("不是 Premiere 工程");
        var expectedRegistry = Path.Combine(Path.GetDirectoryName(project), Path.GetFileNameWithoutExtension(project)
            + ".voiceover-namer.json.recordings", id + ".json");
        if (!Same(expectedRegistry, registryPath)) throw new InvalidDataException("回收登记不属于该工程");
        var target = Text(record, "targetPath");
        AssertPlainPath(target);
        var directory = Path.Combine(Path.GetDirectoryName(project), "Adobe Premiere Pro Captured and Generated");
        if (!Same(Path.GetDirectoryName(target), directory) || !Path.GetFileName(target).EndsWith("-" + id + ".wav", StringComparison.Ordinal))
            throw new InvalidDataException("目标不是已登记的工程录音");
        var drive = new DriveInfo(Path.GetPathRoot(target));
        if (drive.DriveType != DriveType.Fixed || !drive.IsReady) throw new InvalidDataException("该卷不支持自动回收，已保留录音");
        return target;
    }
    static FileStream VerifyFile(string target, Dictionary<string, object> record)
    {
        AssertPlainPath(target);
        var stream = new FileStream(target, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete);
        try
        {
            if (stream.Length <= 0 || stream.Length != Number(record, "size")) throw new InvalidDataException("录音尺寸已变化");
            var birth = (File.GetCreationTimeUtc(target) - Epoch).TotalMilliseconds;
            if (Math.Abs(birth - Number(record, "birthtimeMs")) > 2) throw new InvalidDataException("录音文件身份已变化");
            using (var sha = SHA256.Create())
            {
                var digest = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
                if (digest != Text(record, "sha256")) throw new InvalidDataException("录音内容已变化");
            }
            stream.Position = 0;
            return stream;
        }
        catch { stream.Dispose(); throw; }
    }

    [STAThread]
    public static int Main(string[] args)
    {
        string resultPath = null, id = null, token = null;
        try
        {
            if (args.Length != 1) return 2;
            id = JobId(args[0]);
            var locationPath = Path.Combine(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location), "bridge-location.json");
            var directory = Text(Read(locationPath), "directory");
            AssertPlainPath(directory);
            var path = Path.Combine(directory, id);
            // CreateNew prevents duplicate scheme invocations from replaying a request.
            using (var claim = new FileStream(path + ".lock", FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                var request = Read(path + ".request.json");
                var tokenPath = Path.Combine(directory, "token.txt");
                AssertPlainPath(tokenPath);
                token = File.ReadAllText(tokenPath).Trim();
                if (!Regex.IsMatch(token, "^[0-9a-f]{64}$") || Text(request, "token") != token
                    || Text(request, "id") != id || Number(request, "version") != 1)
                    throw new InvalidDataException("回收助手身份验证失败");
                resultPath = path + ".result.json";
                Fresh(request);
                var registryPath = Text(request, "recordPath");
                if (File.Exists(registryPath + ".issued")) throw new InvalidDataException("回收登记已提交，不重复执行");
                var record = Read(registryPath);
                VerifySignature(record, token);
                var target = ValidateRecord(record, registryPath);
                using (var pinned = VerifyFile(target, record))
                {
                    WriteResult(path + ".ready.json", id, "ready", "", token);
                    while (!File.Exists(path + ".commit.json")) { Fresh(request); Thread.Sleep(100); }
                    var commit = Read(path + ".commit.json");
                    var issued = Read(registryPath + ".issued");
                    Fresh(request);
                    if (Text(commit, "token") != token || Text(commit, "id") != id || Text(issued, "id") != id
                        || Math.Abs(Now() - Number(commit, "at")) > 1500)
                        throw new InvalidDataException("回收最终确认无效或过期");
                    using (var rechecked = VerifyFile(target, record))
                    {
                        if (Math.Abs(Now() - Number(commit, "at")) > 1500) throw new InvalidDataException("回收最终确认已过期");
                        RecycleNative.RecycleOnly(target);
                    }
                }
                if (File.Exists(target)) throw new IOException("系统未确认录音已进入回收站");
                WriteResult(resultPath, id, "recycled", "", token);
                return 0;
            }
        }
        catch (Exception error)
        {
            if (resultPath != null)
            {
                try { WriteResult(resultPath, id, "failed", error.Message, token); } catch { }
            }
            return 1;
        }
    }
}

public static class RecycleNative
{
    [StructLayout(LayoutKind.Sequential)]
    struct BinInfo { public uint Size; public long Bytes; public long Items; }
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    static extern int SHQueryRecycleBin(string root, ref BinInfo info);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHCreateItemFromParsingName(string path, IntPtr binding, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IShellItem item);
    [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellItem { }
    [ComImport, Guid("947aab5f-0a5c-4c13-b4d6-4bf7836fc9f8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IFileOperation
    {
        void Advise(IntPtr sink, out uint cookie); void Unadvise(uint cookie);
        void SetOperationFlags(uint flags); void SetProgressMessage([MarshalAs(UnmanagedType.LPWStr)] string text);
        void SetProgressDialog(IntPtr dialog); void SetProperties(IntPtr properties); void SetOwnerWindow(uint owner);
        void ApplyPropertiesToItem(IShellItem item); void ApplyPropertiesToItems(IntPtr items);
        void RenameItem(IShellItem item, [MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr sink); void RenameItems(IntPtr items, string name);
        void MoveItem(IShellItem item, IShellItem folder, string name, IntPtr sink); void MoveItems(IntPtr items, IShellItem folder);
        void CopyItem(IShellItem item, IShellItem folder, string name, IntPtr sink); void CopyItems(IntPtr items, IShellItem folder);
        void DeleteItem(IShellItem item, IntPtr sink); void DeleteItems(IntPtr items);
        void NewItem(IShellItem folder, uint attributes, string name, string template, IntPtr sink);
        [PreserveSig] int PerformOperations();
        [PreserveSig] int GetAnyOperationsAborted([MarshalAs(UnmanagedType.Bool)] out bool aborted);
    }
    public static void RecycleOnly(string path)
    {
        if (Environment.OSVersion.Version < new Version(6, 2)) throw new IOException("该系统不支持强制回收接口");
        var bin = new BinInfo { Size = (uint)Marshal.SizeOf(typeof(BinInfo)) };
        if (SHQueryRecycleBin(Path.GetPathRoot(path), ref bin) != 0) throw new IOException("无法确认该卷的回收站可用，已保留录音");
        var operation = (IFileOperation)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("3ad05575-8857-4850-9277-11b85bdb8e09")));
        IShellItem item = null;
        try
        {
            // RECYCLEONDELETE requests recycling explicitly. Never use File.Delete as fallback.
            operation.SetOperationFlags(0x00080000 | 0x00100000 | 0x00000400 | 0x00000004 | 0x00000010 | 0x00004000);
            var iid = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");
            SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out item);
            operation.DeleteItem(item, IntPtr.Zero);
            var result = operation.PerformOperations();
            bool aborted;
            var abortResult = operation.GetAnyOperationsAborted(out aborted);
            if (result != 0) throw new IOException("系统回收失败：" + result.ToString("X8"));
            if (abortResult != 0 || aborted) throw new IOException("系统取消了回收，已保留录音");
        }
        finally
        {
            if (item != null) Marshal.ReleaseComObject(item);
            Marshal.ReleaseComObject(operation);
        }
    }
}
