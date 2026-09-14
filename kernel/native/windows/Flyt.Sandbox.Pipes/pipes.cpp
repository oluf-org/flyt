#include <windows.h>
#include "detours.h"

// This is a compatibility adapter, not a security boundary. The token and
// filesystem ACLs enforce confinement even if a child unloads this library.
// Win32's named-pipe default ignores TokenDefaultDacl. Supply that DACL only
// when a caller did not specify its own descriptor, so private per-call IPC
// capabilities work without granting the user's SID in the restricted token.
static char modulePath[MAX_PATH];
static SECURITY_DESCRIPTOR descriptor;
static TOKEN_DEFAULT_DACL* tokenDacl;
static auto realPipeW = CreateNamedPipeW;
static auto realPipeA = CreateNamedPipeA;
static auto realProcessW = CreateProcessW;
static auto realProcessA = CreateProcessA;

static SECURITY_ATTRIBUTES Attributes(LPSECURITY_ATTRIBUTES original) {
    SECURITY_ATTRIBUTES attributes = {sizeof(SECURITY_ATTRIBUTES), &descriptor,
        original ? original->bInheritHandle : FALSE};
    return attributes;
}

static HANDLE WINAPI PipeW(LPCWSTR name, DWORD openMode, DWORD pipeMode,
    DWORD instances, DWORD outputSize, DWORD inputSize, DWORD timeout, LPSECURITY_ATTRIBUTES original) {
    auto attributes = Attributes(original);
    return realPipeW(name, openMode, pipeMode, instances, outputSize, inputSize, timeout,
        original && original->lpSecurityDescriptor ? original : &attributes);
}

static HANDLE WINAPI PipeA(LPCSTR name, DWORD openMode, DWORD pipeMode,
    DWORD instances, DWORD outputSize, DWORD inputSize, DWORD timeout, LPSECURITY_ATTRIBUTES original) {
    auto attributes = Attributes(original);
    return realPipeA(name, openMode, pipeMode, instances, outputSize, inputSize, timeout,
        original && original->lpSecurityDescriptor ? original : &attributes);
}

static BOOL WINAPI ProcessW(LPCWSTR app, LPWSTR command, LPSECURITY_ATTRIBUTES processAttributes,
    LPSECURITY_ATTRIBUTES threadAttributes, BOOL inherit, DWORD flags, LPVOID environment,
    LPCWSTR directory, LPSTARTUPINFOW startup, LPPROCESS_INFORMATION process) {
    return DetourCreateProcessWithDllExW(app, command, processAttributes, threadAttributes,
        inherit, flags, environment, directory, startup, process, modulePath, realProcessW);
}

static BOOL WINAPI ProcessA(LPCSTR app, LPSTR command, LPSECURITY_ATTRIBUTES processAttributes,
    LPSECURITY_ATTRIBUTES threadAttributes, BOOL inherit, DWORD flags, LPVOID environment,
    LPCSTR directory, LPSTARTUPINFOA startup, LPPROCESS_INFORMATION process) {
    return DetourCreateProcessWithDllExA(app, command, processAttributes, threadAttributes,
        inherit, flags, environment, directory, startup, process, modulePath, realProcessA);
}

extern "C" __declspec(dllexport) BOOL WINAPI FlytAttachPipeCompatibility(HANDLE process) {
    LPCSTR libraries[] = {modulePath};
    return DetourUpdateProcessWithDll(process, libraries, 1);
}

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID) {
    if (reason != DLL_PROCESS_ATTACH) return TRUE;
    if (DetourIsHelperProcess()) return TRUE;
    const auto length = GetModuleFileNameA(instance, modulePath, MAX_PATH);
    if (!length || length >= MAX_PATH) return FALSE;
    DetourRestoreAfterWith();
    HANDLE token;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return FALSE;
    const BOOL restricted = IsTokenRestricted(token);
    if (!restricted) { CloseHandle(token); return TRUE; } // Trusted .NET launcher.
    DWORD bytes = 0;
    GetTokenInformation(token, TokenDefaultDacl, nullptr, 0, &bytes);
    tokenDacl = static_cast<TOKEN_DEFAULT_DACL*>(HeapAlloc(GetProcessHeap(), 0, bytes));
    const BOOL read = tokenDacl && GetTokenInformation(token, TokenDefaultDacl, tokenDacl, bytes, &bytes);
    CloseHandle(token);
    if (!read || !tokenDacl->DefaultDacl ||
        !InitializeSecurityDescriptor(&descriptor, SECURITY_DESCRIPTOR_REVISION) ||
        !SetSecurityDescriptorDacl(&descriptor, TRUE, tokenDacl->DefaultDacl, FALSE)) return FALSE;
    if (DetourTransactionBegin() != NO_ERROR) return FALSE;
    if (DetourUpdateThread(GetCurrentThread()) != NO_ERROR ||
        DetourAttach(reinterpret_cast<PVOID*>(&realPipeW), PipeW) != NO_ERROR ||
        DetourAttach(reinterpret_cast<PVOID*>(&realPipeA), PipeA) != NO_ERROR ||
        DetourAttach(reinterpret_cast<PVOID*>(&realProcessW), ProcessW) != NO_ERROR ||
        DetourAttach(reinterpret_cast<PVOID*>(&realProcessA), ProcessA) != NO_ERROR) {
        DetourTransactionAbort();
        return FALSE;
    }
    return DetourTransactionCommit() == NO_ERROR;
}
