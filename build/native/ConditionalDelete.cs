using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

internal static class ConditionalDelete {
    [StructLayout(LayoutKind.Sequential)]
    private struct Information {
        public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct Disposition { public byte Delete; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle file, out Information info);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetFileInformationByHandle(SafeFileHandle file, int kind, ref Disposition info, uint size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool GetVolumeInformationByHandleW(SafeFileHandle file, StringBuilder label, uint labelSize, out uint serial, out uint componentLength, out uint flags, StringBuilder fileSystem, uint fileSystemSize);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder path, uint length, uint flags);
    private static string StringValue(Dictionary<string, object> plan, string name) {
        object value;
        if (!plan.TryGetValue(name, out value) || !(value is string)) throw new InvalidDataException("Invalid conditional delete plan");
        return (string)value;
    }
    private static ulong Index(Information info) { return ((ulong)info.IndexHigh << 32) | info.IndexLow; }
    private static ulong Size(Information info) { return ((ulong)info.SizeHigh << 32) | info.SizeLow; }
    private static string Extended(string path) {
        if (!Path.IsPathRooted(path) || path.IndexOf('\0') >= 0) throw new InvalidDataException("An absolute path is required");
        return path.StartsWith(@"\\") ? @"\\?\UNC\" + path.Substring(2) : @"\\?\" + path;
    }
    private static bool IsNtfs(SafeFileHandle file) {
        var fsName = new StringBuilder(32);
        uint serial, length, flags;
        return GetVolumeInformationByHandleW(file, null, 0, out serial, out length, out flags, fsName, 32) && fsName.ToString() == "NTFS";
    }
    private sealed class DirectoryChain : IDisposable {
        private readonly List<SafeFileHandle> handles = new List<SafeFileHandle>();
        private readonly Dictionary<string, Information> identities = new Dictionary<string, Information>(StringComparer.OrdinalIgnoreCase);
        public DirectoryChain(string filePath, bool includesLeaf, Dictionary<string, object> plan) {
            try {
                var path = filePath.Replace('/', '\\');
                string root;
                if (path.Length >= 3 && Char.IsLetter(path[0]) && path[1] == ':' && path[2] == '\\') root = path.Substring(0, 3);
                else if (path.StartsWith(@"\\") && !path.StartsWith(@"\\?\") && !path.StartsWith(@"\\.\")) {
                    var server = path.IndexOf('\\', 2); var share = server < 0 ? -1 : path.IndexOf('\\', server + 1);
                    if (server < 3 || share <= server + 1) throw new IOException("Invalid UNC path");
                    root = path.Substring(0, share + 1);
                } else root = null;
                if (String.IsNullOrEmpty(root))
                    throw new IOException("The path is not an unambiguous absolute path");
                var end = includesLeaf ? path : path.Substring(0, Math.Max(root.Length, path.LastIndexOf('\\')));
                var at = root;
                Check(at);
                foreach (var part in end.Substring(root.Length).Split(new[] {'\\'}, StringSplitOptions.RemoveEmptyEntries)) {
                    if (part == "." || part == "..") throw new IOException("Relative directory component refused");
                    at = at.TrimEnd('\\') + @"\" + part; Check(at);
                }
                object expected;
                if (plan.TryGetValue("directories", out expected)) foreach (var raw in (System.Collections.IEnumerable)expected) {
                    var item = (Dictionary<string, object>)raw;
                    Information info;
                    if (!identities.TryGetValue(StringValue(item, "path").Replace('/', '\\'), out info) ||
                        info.Volume != ulong.Parse(StringValue(item, "dev"), CultureInfo.InvariantCulture) ||
                        Index(info) != ulong.Parse(StringValue(item, "ino"), CultureInfo.InvariantCulture))
                        throw new IOException("An owned directory was replaced; file retained");
                }
            } catch { Dispose(); throw; }
        }
        private void Check(string path) {
            // Keep each ancestor open without sharing write/delete access until deletion ends.
            var handle = CreateFileW(Extended(path), 0x80, 1, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
            if (handle.IsInvalid) {
                var error = Marshal.GetLastWin32Error(); handle.Dispose();
                if (error == 2 || error == 3) throw new DirectoryNotFoundException();
                throw new IOException("Directory chain is unavailable or in use");
            }
            handles.Add(handle);
            Information info;
            if (!GetFileInformationByHandle(handle, out info) || (info.Attributes & 0x400) != 0 || (info.Attributes & 0x10) == 0)
                throw new IOException("Directory link or invalid ancestor refused");
            var final = new StringBuilder(32768);
            var length = GetFinalPathNameByHandleW(handle, final, (uint)final.Capacity, 0);
            if (length == 0 || length >= final.Capacity || !String.Equals(final.ToString().TrimEnd('\\'), Extended(path).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
                throw new IOException("Directory path resolved outside its declared chain");
            identities[path.TrimEnd('\\')] = info;
            identities[path] = info;
        }
        public void Dispose() { foreach (var handle in handles) handle.Dispose(); handles.Clear(); }
    }
    private static void InspectAttributes(Dictionary<string, object> plan) {
        object raw;
        if (!plan.TryGetValue("paths", out raw) || !(raw is System.Collections.IEnumerable) || raw is string)
            throw new InvalidDataException("Invalid path inspection plan");
        var count = 0;
        foreach (var item in (System.Collections.IEnumerable)raw) {
            if (!(item is string) || ++count > 256) throw new InvalidDataException("Invalid path inspection member");
            var path = ((string)item).Replace('/', '\\');
            using (var file = CreateFileW(Extended(path), 0x80, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
                Information info;
                if (file.IsInvalid || !GetFileInformationByHandle(file, out info) || (info.Attributes & 0x400) != 0)
                    throw new IOException("Path is unavailable or contains a reparse point");
                var actual = new StringBuilder(32768);
                var length = GetFinalPathNameByHandleW(file, actual, (uint)actual.Capacity, 0);
                if (length == 0 || length >= actual.Capacity || !String.Equals(actual.ToString().TrimEnd('\\'), Extended(path).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
                    throw new IOException("Path resolved outside its declared location");
            }
        }
        if (count == 0) throw new InvalidDataException("Empty path inspection plan");
    }
    // Exit 0 deleted, 2 absent, 3 a different object/content, 4 locked or unverifiable.
    private static int Main() {
        try {
            Console.SetError(new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false)) { AutoFlush = true });
            var data = Environment.GetEnvironmentVariable("ZHUMO_FILE_DELETE_PLAN");
            var text = Encoding.UTF8.GetString(Convert.FromBase64String(data ?? ""));
            var plan = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(text);
            var kind = StringValue(plan, "kind");
            if (kind == "zhumo-path-attributes-v1") {
                InspectAttributes(plan);
                Console.Out.Write("ok");
                return 0;
            }
            var path = StringValue(plan, "path");
            if (kind == "zhumo-directory-chain-v1") {
                using (var parents = new DirectoryChain(path, true, plan)) { return 0; }
            }
            if (kind == "zhumo-owned-delete-capability-v1") {
              using (var parents = new DirectoryChain(path, true, plan)) {
                using (var directory = CreateFileW(Extended(path), 0x80, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
                    Information info;
                    if (directory.IsInvalid || !GetFileInformationByHandle(directory, out info) ||
                        (info.Attributes & 0x400) != 0 || (info.Attributes & 0x10) == 0 || !IsNtfs(directory))
                        throw new IOException("Shortcut publication requires a verified NTFS directory");
                    return 0;
                }
              }
            }
            if (kind != "zhumo-owned-file-v1") throw new InvalidDataException("Unknown operation");
            var expectedHash = StringValue(plan, "sha256");
            var expectedVolume = ulong.Parse(StringValue(plan, "dev"), CultureInfo.InvariantCulture);
            var expectedIndex = ulong.Parse(StringValue(plan, "ino"), CultureInfo.InvariantCulture);
            using (var parents = new DirectoryChain(path, false, plan)) {
            // DELETE + GENERIC_READ, no sharing; check and delete the same opened entity.
            using (var file = CreateFileW(Extended(path), 0x80010000, 0, IntPtr.Zero, 3, 0x08200080, IntPtr.Zero)) {
                if (file.IsInvalid) {
                    var error = Marshal.GetLastWin32Error();
                    if (error == 2 || error == 3) return 2;
                    throw new IOException("The owned file is locked or inaccessible (" + error + ")");
                }
                Information before;
                if (!GetFileInformationByHandle(file, out before)) throw new IOException("File identity unavailable");
                if (!IsNtfs(file))
                    throw new IOException("Conditional deletion requires verified NTFS identity");
                if ((before.Attributes & (0x400 | 0x10)) != 0 || before.Links != 1 || before.Volume != expectedVolume || Index(before) != expectedIndex) return 3;
                using (var stream = new FileStream(file, FileAccess.Read, 65536, false))
                using (var sha = SHA256.Create()) {
                    var actualHash = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
                    Information after;
                    if (!GetFileInformationByHandle(file, out after)) throw new IOException("File identity changed");
                    if (actualHash != expectedHash || Size(after) != Size(before) || after.WriteLow != before.WriteLow || after.WriteHigh != before.WriteHigh ||
                        after.Links != 1 || after.Volume != before.Volume || Index(after) != Index(before)) return 3;
                    var disposition = new Disposition { Delete = 1 };
                    if (!SetFileInformationByHandle(file, 4, ref disposition, 1)) throw new IOException("The checked file could not be removed");
                }
            }
            }
            return 0;
        } catch (DirectoryNotFoundException) { return 2;
        } catch (Exception error) {
            Console.Error.Write(error.Message);
            return 4;
        }
    }
}
