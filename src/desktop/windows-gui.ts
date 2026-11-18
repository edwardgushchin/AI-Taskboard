import { join } from "node:path";

const probe = `$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class TaskboardWindowStation {
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr CreateWindowStation(string name, uint flags, uint access, IntPtr attributes);
  [DllImport("user32.dll")]
  private static extern bool CloseWindowStation(IntPtr station);
  public static int Check() {
    IntPtr station = CreateWindowStation(null, 0, 0x80000008, IntPtr.Zero);
    int error = station == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
    if (error == 5) {
      station = CreateWindowStation(null, 0, 0x0000000a, IntPtr.Zero);
      error = station == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
    }
    if (station != IntPtr.Zero) CloseWindowStation(station);
    return error;
  }
}
'@
[Console]::WriteLine([TaskboardWindowStation]::Check())`;

export type WindowsGuiEvidence = { operation: "CreateWindowStationW"; mxcError: 5; hostError: 0 };

export async function windowsGuiEvidence(
  request: <R>(method: string, params: object) => Promise<R>, permissionProfile: string,
): Promise<WindowsGuiEvidence | undefined> {
  const cwd = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  const powershell = join(cwd, "WindowsPowerShell", "v1.0", "powershell.exe");
  // The host control runs only this bundled probe, with no project code or model-supplied arguments.
  const check = async (profile: string) => {
    const result = await request<{ exitCode: number; stdout: string }>("command/exec", {
      cwd, permissionProfile: profile, timeoutMs: 8000,
      command: [powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", probe],
    });
    return result.exitCode === 0 ? result.stdout.trim() : undefined;
  };
  try {
    if (await check(permissionProfile) === "5" && await check(":danger-full-access") === "0") {
      return { operation: "CreateWindowStationW", mxcError: 5, hostError: 0 };
    }
  } catch {
    // The approval flow still accepts the executor's own evidence if the probe is unavailable.
  }
}
