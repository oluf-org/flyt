param([Parameter(Mandatory = $true)][string]$UserName)

# Alternate-credential processes need access to their parent's window station
# and desktop, even when they only run console tests. Grant only the temporary
# test account on this ephemeral runner, preserving all existing ACL entries.
Add-Type @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
public static class SandboxDesktopAccess {
    [DllImport("user32.dll", SetLastError=true)]
    static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll", SetLastError=true)]
    static extern IntPtr GetThreadDesktop(uint threadId);
    [DllImport("kernel32.dll")]
    static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", SetLastError=true)]
    static extern bool GetUserObjectSecurity(IntPtr handle, ref uint information, byte[] descriptor, uint length, out uint needed);
    [DllImport("user32.dll", SetLastError=true)]
    static extern bool SetUserObjectSecurity(IntPtr handle, ref uint information, byte[] descriptor);
    static void Grant(IntPtr handle, SecurityIdentifier sid, int access) {
        if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        uint information = 4, needed;
        GetUserObjectSecurity(handle, ref information, null, 0, out needed);
        var bytes = new byte[needed];
        if (!GetUserObjectSecurity(handle, ref information, bytes, needed, out needed))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        var descriptor = new RawSecurityDescriptor(bytes, 0);
        // A null DACL already allows access; leave it unchanged.
        if (descriptor.DiscretionaryAcl == null) return;
        descriptor.DiscretionaryAcl.InsertAce(descriptor.DiscretionaryAcl.Count,
            new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, access, sid, false, null));
        bytes = new byte[descriptor.BinaryLength];
        descriptor.GetBinaryForm(bytes, 0);
        if (!SetUserObjectSecurity(handle, ref information, bytes))
            throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    public static void Grant(string sid) {
        var identity = new SecurityIdentifier(sid);
        Grant(GetProcessWindowStation(), identity, 0xF037F);
        Grant(GetThreadDesktop(GetCurrentThreadId()), identity, 0xF01FF);
    }
}
'@
[SandboxDesktopAccess]::Grant((Get-LocalUser -Name $UserName).SID.Value)
