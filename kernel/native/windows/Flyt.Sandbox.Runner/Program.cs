using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;

internal static class Program
{
    private static string Stage = "startup";
    private const int RunnerFailure = 120;
    private const uint TOKEN_ASSIGN_PRIMARY = 0x0001;
    private const uint TOKEN_DUPLICATE = 0x0002;
    private const uint TOKEN_QUERY = 0x0008;
    private const uint TOKEN_ADJUST_DEFAULT = 0x0080;
    private const uint DISABLE_MAX_PRIVILEGE = 0x1;
    private const uint LUA_TOKEN = 0x4;
    private const uint WRITE_RESTRICTED = 0x8;
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint INFINITE = 0xffffffff;

    public static int Main(string[] args)
    {
        try { return Run(args); }
        catch (Exception error)
        {
            Console.Error.WriteLine($"FLYT_SANDBOX_RUNNER: {Stage}: {error.GetType().Name}: {error.Message}");
            return RunnerFailure;
        }
    }

    private static SecurityIdentifier? ReadLogonSid(IntPtr token)
    {
        // WindowsIdentity.Groups intentionally filters SE_GROUP_LOGON_ID.
        // TokenLogonSid returns a TOKEN_GROUPS containing the session SID.
        const int TokenLogonSid = 28;
        GetTokenInformation(token, TokenLogonSid, IntPtr.Zero, 0, out var size);
        if (size == 0) ThrowWin32("GetTokenInformation(TokenLogonSid size)");
        var buffer = Marshal.AllocHGlobal(checked((int)size));
        try
        {
            if (!GetTokenInformation(token, TokenLogonSid, buffer, size, out _))
                ThrowWin32("GetTokenInformation(TokenLogonSid)");
            if (Marshal.ReadInt32(buffer) != 1) return null;
            var offset = Marshal.OffsetOf<TOKEN_GROUPS_ONE>(nameof(TOKEN_GROUPS_ONE.Group)).ToInt32();
            var group = Marshal.PtrToStructure<SID_AND_ATTRIBUTES>(IntPtr.Add(buffer, offset));
            return new SecurityIdentifier(group.Sid);
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static int Run(string[] args)
    {
        Stage = "parse"; Parse(args, out var mode, out var workspace, out var temp, out var command, out var allowElevatedParentForTest);
        if (!OperatingSystem.IsWindows()) throw new InvalidOperationException("the Windows runner was started on a non-Windows host");
        if (allowElevatedParentForTest && !string.Equals(Environment.GetEnvironmentVariable("GITHUB_ACTIONS"), "true", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("the elevated-parent test option is available only on GitHub Actions");
        Stage = "identity"; using var identity = WindowsIdentity.GetCurrent();
        if (!allowElevatedParentForTest && new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator))
            throw new InvalidOperationException("confined execution is refused while Flyt is elevated");
        Stage = "filesystem"; if (!IsNtfs(workspace) || (mode == "workspace-write" && !IsNtfs(temp)))
            throw new InvalidOperationException("the workspace and private temp must be on NTFS");
        // The restricted child must share a console. CREATE_NO_WINDOW and
        // CREATE_NEW_CONSOLE make Node and other runtimes fail during DLL
        // initialization under WRITE_RESTRICTED. GUI hosts have no console,
        // so give the runner a hidden one for the child to inherit.
        Stage = "console"; EnsureHiddenConsole();

        // Windows runtime loaders open shared kernel objects during process
        // initialisation. Those objects grant the World SID, not an application-
        // specific capability; using only RestrictedCode here makes Node and the
        // CLR die before main (0xC0000142 / E_ACCESSDENIED). World is the baseline
        // read/runtime SID. It does not make the ordinary user check disappear,
        // and writable workspace/temp paths still need their private capability.
        Stage = "interactive session SID";
        var worldSid = new SecurityIdentifier(WellKnownSidType.WorldSid, null);
        var logonSid = ReadLogonSid(identity.AccessToken.DangerousGetHandle());
        if (logonSid is null)
            throw new InvalidOperationException("Windows did not provide the logon identity required for confined command tools in this sign-in session");
        var workspaceSid = SidFromBytes(SHA256.HashData(Encoding.UTF8.GetBytes("flyt:workspace:v1:" + Canonical(workspace).ToUpperInvariant())));
        var tempSid = SidFromBytes(RandomNumberGenerator.GetBytes(32));
        var granted = new List<(string Path, SecurityIdentifier Sid)>();
        try
        {
            // The logon-session and World SIDs keep normal Windows runtime
            // objects usable; the private SIDs are the writable path grants.
            // This is still partial enforcement because ambient World ACEs
            // also satisfy the second write access check.
            var restrictionSids = new List<SecurityIdentifier> { logonSid, worldSid };
            if (mode == "workspace-write")
            {
                Stage = "workspace ACL"; AddWriteAce(workspace, workspaceSid); granted.Add((workspace, workspaceSid));
                Stage = "temp ACL"; AddWriteAce(temp, tempSid); granted.Add((temp, tempSid));
                restrictionSids.Add(workspaceSid); restrictionSids.Add(tempSid);
                Environment.SetEnvironmentVariable("TEMP", temp);
                Environment.SetEnvironmentVariable("TMP", temp);
            }
            Stage = "restricted token"; using var restricted = RestrictedToken(restrictionSids, mode == "workspace-write" ? tempSid : worldSid);
            Stage = "process launch";
            return StartOwned(restricted.DangerousGetHandle(), command);
        }
        finally
        {
            // The deterministic workspace ACE is inert without the restricting
            // SID, but removing both keeps directory ACLs tidy and makes the
            // private capability visibly one-call only.
            foreach (var grant in granted.AsEnumerable().Reverse())
                try { RemoveWriteAce(grant.Path, grant.Sid); } catch { }
        }
    }

    private static void Parse(string[] args, out string mode, out string workspace, out string temp, out string[] command, out bool allowElevatedParentForTest)
    {
        mode = ""; workspace = ""; temp = ""; allowElevatedParentForTest = false;
        var separator = Array.IndexOf(args, "--");
        if (separator < 0 || separator == args.Length - 1) throw new ArgumentException("expected -- followed by exact command argv");
        for (var i = 0; i < separator; i++)
        {
            if (args[i] == "--allow-elevated-parent-for-test") allowElevatedParentForTest = true;
            else if (args[i] == "--mode" && ++i < separator) mode = args[i];
            else if (args[i] == "--workspace" && ++i < separator) workspace = Canonical(args[i]);
            else if (args[i] == "--temp" && ++i < separator) temp = Canonical(args[i]);
            else throw new ArgumentException($"unknown or incomplete runner option {args[i]}");
        }
        if (mode is not ("read-only" or "workspace-write")) throw new ArgumentException("mode must be read-only or workspace-write");
        if (!Directory.Exists(workspace)) throw new DirectoryNotFoundException("workspace does not exist");
        if (mode == "workspace-write" && !Directory.Exists(temp)) throw new DirectoryNotFoundException("private temp does not exist");
        command = args[(separator + 1)..];
        if (!Path.IsPathFullyQualified(command[0]) || !File.Exists(command[0])) throw new FileNotFoundException("command executable must be an existing absolute path");
    }

    private static string Canonical(string value) => Path.TrimEndingDirectorySeparator(Path.GetFullPath(value));
    private static bool IsNtfs(string value) => string.Equals(new DriveInfo(Path.GetPathRoot(value)!).DriveFormat, "NTFS", StringComparison.OrdinalIgnoreCase);

    private static SecurityIdentifier SidFromBytes(byte[] hash)
    {
        uint Part(int offset) => BitConverter.ToUInt32(hash, offset) & 0x7fffffff;
        return new SecurityIdentifier($"S-1-5-21-{Part(0)}-{Part(4)}-{Part(8)}-{Part(12)}");
    }

    private static void AddWriteAce(string directory, SecurityIdentifier sid)
    {
        var info = new DirectoryInfo(directory);
        var security = info.GetAccessControl(AccessControlSections.Access);
        security.AddAccessRule(new FileSystemAccessRule(sid,
            FileSystemRights.Modify | FileSystemRights.Synchronize,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
            PropagationFlags.None, AccessControlType.Allow));
        info.SetAccessControl(security);
    }

    private static void RemoveWriteAce(string directory, SecurityIdentifier sid)
    {
        var info = new DirectoryInfo(directory);
        var security = info.GetAccessControl(AccessControlSections.Access);
        security.RemoveAccessRuleSpecific(new FileSystemAccessRule(sid,
            FileSystemRights.Modify | FileSystemRights.Synchronize,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
            PropagationFlags.None, AccessControlType.Allow));
        info.SetAccessControl(security);
    }

    private static SafeToken RestrictedToken(IReadOnlyList<SecurityIdentifier> sids, SecurityIdentifier? defaultGrant)
    {
        if (!OpenProcessToken(Process.GetCurrentProcess().Handle, TOKEN_ASSIGN_PRIMARY | TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ADJUST_DEFAULT, out var source))
            ThrowWin32("OpenProcessToken");
        using var sourceToken = new SafeToken(source);
        var native = new SID_AND_ATTRIBUTES[sids.Count];
        var allocated = new List<IntPtr>();
        try
        {
            for (var i = 0; i < sids.Count; i++)
            {
                var bytes = new byte[sids[i].BinaryLength]; sids[i].GetBinaryForm(bytes, 0);
                var pointer = Marshal.AllocHGlobal(bytes.Length); Marshal.Copy(bytes, 0, pointer, bytes.Length); allocated.Add(pointer);
                native[i] = new SID_AND_ATTRIBUTES { Sid = pointer, Attributes = 0 };
            }
            if (!CreateRestrictedToken(source, DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED,
                0, IntPtr.Zero, 0, IntPtr.Zero, (uint)native.Length, native, out var result)) ThrowWin32("CreateRestrictedToken");
            if (defaultGrant is not null) AddDefaultDaclGrant(result, defaultGrant);
            return new SafeToken(result);
        }
        finally { foreach (var pointer in allocated) Marshal.FreeHGlobal(pointer); }
    }

    private static void AddDefaultDaclGrant(IntPtr token, SecurityIdentifier sid)
    {
        // Preserve the source token's ordinary default DACL and add only the
        // revocable per-call temp capability. Replacing the DACL breaks runtime
        // initialization, while adding the standing workspace SID would let
        // unrelated calls in the same workspace open one another's objects.
        // CreateNamedPipe with no explicit descriptor uses a separate Windows
        // template, NOT this token DACL. Do not add the user's SID as a
        // restricting SID to fix libuv pipes: that defeats filesystem denial.
        GetTokenInformation(token, 6, IntPtr.Zero, 0, out var infoBytes);
        if (infoBytes == 0) ThrowWin32("GetTokenInformation(TokenDefaultDacl size)");
        var info = Marshal.AllocHGlobal((int)infoBytes);
        try
        {
            if (!GetTokenInformation(token, 6, info, infoBytes, out _)) ThrowWin32("GetTokenInformation(TokenDefaultDacl)");
            var existingPointer = Marshal.ReadIntPtr(info);
            if (existingPointer == IntPtr.Zero) throw new InvalidOperationException("the token has no default DACL");
            var aclBytes = unchecked((ushort)Marshal.ReadInt16(existingPointer, 2));
            var existing = new byte[aclBytes]; Marshal.Copy(existingPointer, existing, 0, aclBytes);
            var acl = new RawAcl(existing, 0);
            acl.InsertAce(acl.Count, new CommonAce(AceFlags.None, AceQualifier.AccessAllowed,
                unchecked((int)0x10000000), sid, false, null));
            var bytes = new byte[acl.BinaryLength]; acl.GetBinaryForm(bytes, 0);
            var aclPointer = Marshal.AllocHGlobal(bytes.Length);
            var setInfo = Marshal.AllocHGlobal(IntPtr.Size);
            try
            {
                Marshal.Copy(bytes, 0, aclPointer, bytes.Length); Marshal.WriteIntPtr(setInfo, aclPointer);
                if (!SetTokenInformation(token, 6, setInfo, (uint)IntPtr.Size)) ThrowWin32("SetTokenInformation(TokenDefaultDacl)");
            }
            finally { Marshal.FreeHGlobal(setInfo); Marshal.FreeHGlobal(aclPointer); }
        }
        finally { Marshal.FreeHGlobal(info); }
    }

    private static int StartOwned(IntPtr token, string[] argv)
    {
        using var job = new SafeKernel(CreateJobObject(IntPtr.Zero, null));
        if (job.IsInvalid) ThrowWin32("CreateJobObject");
        var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION(); limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        var size = Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>();
        var info = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(limits, info, false);
            if (!SetInformationJobObject(job.DangerousGetHandle(), JobObjectExtendedLimitInformation, info, (uint)size)) ThrowWin32("SetInformationJobObject");
        }
        finally { Marshal.FreeHGlobal(info); }

        var startup = new STARTUPINFO { cb = Marshal.SizeOf<STARTUPINFO>(), dwFlags = STARTF_USESTDHANDLES,
            hStdInput = GetStdHandle(-10), hStdOutput = GetStdHandle(-11), hStdError = GetStdHandle(-12) };
        var stdHandles = new[] { startup.hStdInput, startup.hStdOutput, startup.hStdError }.Distinct().ToArray();
        if (stdHandles.Any(handle => handle == IntPtr.Zero || handle == new IntPtr(-1)))
            throw new InvalidOperationException("the runner received an invalid standard handle");
        // Node/libuv clears HANDLE_FLAG_INHERIT after it wires a child's stdio.
        // The runner is that child, so turn inheritance back on while it creates
        // the confined grandchild, then restore the original safe state.
        foreach (var handle in stdHandles)
            if (!SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) ThrowWin32("SetHandleInformation(enable inherit)");
        // cmd /s /c consumes shell text, not a CRT argv element. The host has
        // already supplied its outer quotes; escaping them as \" changes the
        // command itself (even `echo hello` becomes an invalid program name).
        var shellEnvelope = argv.Length == 5
            && string.Equals(Path.GetFileName(argv[0]), "cmd.exe", StringComparison.OrdinalIgnoreCase)
            && string.Equals(argv[1], "/d", StringComparison.OrdinalIgnoreCase)
            && string.Equals(argv[2], "/s", StringComparison.OrdinalIgnoreCase)
            && string.Equals(argv[3], "/c", StringComparison.OrdinalIgnoreCase);
        var commandLine = shellEnvelope
            ? $"{Quote(argv[0])} /d /s /c {argv[4]}"
            : string.Join(" ", argv.Select(Quote));
        PROCESS_INFORMATION process;
        int createError = 0;
        bool created;
        try
        {
            created = CreateProcessAsUser(token, argv[0], commandLine, IntPtr.Zero, IntPtr.Zero, true,
                CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, IntPtr.Zero, null, ref startup, out process);
            if (!created) createError = Marshal.GetLastWin32Error();
        }
        finally
        {
            foreach (var handle in stdHandles) SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0);
        }
        if (!created) throw new InvalidOperationException($"CreateProcessAsUser: {new Win32Exception(createError).Message} ({createError})");
        using var processHandle = new SafeKernel(process.hProcess);
        using var threadHandle = new SafeKernel(process.hThread);
        if (!AssignProcessToJobObject(job.DangerousGetHandle(), process.hProcess)) ThrowWin32("AssignProcessToJobObject");
        if (ResumeThread(process.hThread) == uint.MaxValue) ThrowWin32("ResumeThread");
        WaitForSingleObject(process.hProcess, INFINITE);
        if (!GetExitCodeProcess(process.hProcess, out var code)) ThrowWin32("GetExitCodeProcess");
        if (code is 0xC0000142 or 0xC0000409 or 0xC0000005)
            throw new InvalidOperationException($"the child fast-failed during restricted-token initialization (0x{code:X8}); this runtime is incompatible with the Windows sandbox on this host");
        return unchecked((int)code);
    }

    private static string Quote(string value)
    {
        if (value.Length > 0 && !value.Any(char.IsWhiteSpace) && !value.Contains('"')) return value;
        var result = new StringBuilder("\""); var slashes = 0;
        foreach (var c in value)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { result.Append('\\', slashes * 2 + 1).Append('"'); slashes = 0; continue; }
            result.Append('\\', slashes).Append(c); slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }

    private static void ThrowWin32(string operation)
    {
        var code = Marshal.GetLastWin32Error();
        throw new InvalidOperationException($"{operation}: {new Win32Exception(code).Message} ({code})");
    }

    private static void EnsureHiddenConsole()
    {
        if (GetConsoleWindow() != IntPtr.Zero) return;
        if (!AllocConsole())
        {
            // ERROR_ACCESS_DENIED is also returned when the process is already
            // attached to a pseudoconsole that has no HWND.
            if (Marshal.GetLastWin32Error() == 5) return;
            ThrowWin32("AllocConsole");
        }
        var window = GetConsoleWindow();
        if (window != IntPtr.Zero) ShowWindow(window, 0); // SW_HIDE
    }

    [StructLayout(LayoutKind.Sequential)] private struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)] private struct TOKEN_GROUPS_ONE { public uint Count; public SID_AND_ATTRIBUTES Group; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct STARTUPINFO { public int cb; public string? lpReserved, lpDesktop, lpTitle; public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public ushort wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
    [StructLayout(LayoutKind.Sequential)] private struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public uint dwProcessId, dwThreadId; }
    [StructLayout(LayoutKind.Sequential)] private struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] private struct JOBOBJECT_BASIC_LIMIT_INFORMATION { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)] private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION { public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }

    private sealed class SafeToken(IntPtr handle) : SafeHandle(handle, true) { public override bool IsInvalid => handle == IntPtr.Zero || handle == new IntPtr(-1); protected override bool ReleaseHandle() => CloseHandle(handle); }
    private sealed class SafeKernel(IntPtr handle) : SafeHandle(handle, true) { public override bool IsInvalid => handle == IntPtr.Zero || handle == new IntPtr(-1); protected override bool ReleaseHandle() => CloseHandle(handle); }

    [DllImport("advapi32", SetLastError = true)] private static extern bool OpenProcessToken(IntPtr ProcessHandle, uint DesiredAccess, out IntPtr TokenHandle);
    [DllImport("advapi32", SetLastError = true)] private static extern bool CreateRestrictedToken(IntPtr ExistingTokenHandle, uint Flags, uint DisableSidCount, IntPtr SidsToDisable, uint DeletePrivilegeCount, IntPtr PrivilegesToDelete, uint RestrictedSidCount, [In] SID_AND_ATTRIBUTES[] SidsToRestrict, out IntPtr NewTokenHandle);
    [DllImport("advapi32", SetLastError = true)] private static extern bool SetTokenInformation(IntPtr TokenHandle, int TokenInformationClass, IntPtr TokenInformation, uint TokenInformationLength);
    [DllImport("advapi32", SetLastError = true)] private static extern bool GetTokenInformation(IntPtr TokenHandle, int TokenInformationClass, IntPtr TokenInformation, uint TokenInformationLength, out uint ReturnLength);
    [DllImport("advapi32", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool CreateProcessAsUser(IntPtr hToken, string lpApplicationName, string lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string? lpCurrentDirectory, ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);
    [DllImport("kernel32", SetLastError = true)] private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string? lpName);
    [DllImport("kernel32", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);
    [DllImport("kernel32", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);
    [DllImport("kernel32", SetLastError = true)] private static extern uint ResumeThread(IntPtr hThread);
    [DllImport("kernel32", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);
    [DllImport("kernel32", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);
    [DllImport("kernel32", SetLastError = true)] private static extern IntPtr GetStdHandle(int nStdHandle);
    [DllImport("kernel32", SetLastError = true)] private static extern bool SetHandleInformation(IntPtr hObject, uint dwMask, uint dwFlags);
    [DllImport("kernel32", SetLastError = true)] private static extern bool AllocConsole();
    [DllImport("kernel32")] private static extern IntPtr GetConsoleWindow();
    [DllImport("user32")] private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("kernel32", SetLastError = true)] private static extern bool CloseHandle(IntPtr hObject);
}
