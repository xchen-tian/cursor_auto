param([int]$TargetPid, [string]$Action, [int]$W=0, [int]$H=0, [int]$X=-99999, [int]$Y=-99999)

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class Win32Window {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int X, int Y, int W, int H, bool repaint);
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    public static IntPtr FindByPid(uint targetPid) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((h, _) => {
            if (!IsWindowVisible(h)) return true;
            int len = GetWindowTextLength(h);
            if (len == 0) return true;
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            if (pid == targetPid) { found = h; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
"@

$hwnd = [Win32Window]::FindByPid([uint32]$TargetPid)
if ($hwnd -eq [IntPtr]::Zero) {
    Write-Output '{"ok":false,"error":"window_not_found"}'
    exit 0
}

[Win32Window+RECT]$rect = New-Object Win32Window+RECT
[Win32Window]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
$zoomed = [Win32Window]::IsZoomed($hwnd)

if ($Action -eq "info") {
    $json = '{"ok":true,"hwnd":' + $hwnd.ToInt64() + ',"zoomed":' + $zoomed.ToString().ToLower() + ',"left":' + $rect.Left + ',"top":' + $rect.Top + ',"width":' + ($rect.Right - $rect.Left) + ',"height":' + ($rect.Bottom - $rect.Top) + '}'
    Write-Output $json
}
elseif ($Action -eq "restore") {
    [Win32Window]::ShowWindow($hwnd, 9) | Out-Null
    Start-Sleep -Milliseconds 300
    [Win32Window]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
    $json = '{"ok":true,"action":"restore","hwnd":' + $hwnd.ToInt64() + ',"left":' + $rect.Left + ',"top":' + $rect.Top + ',"width":' + ($rect.Right - $rect.Left) + ',"height":' + ($rect.Bottom - $rect.Top) + '}'
    Write-Output $json
}
elseif ($Action -eq "resize") {
    if ($zoomed) { [Win32Window]::ShowWindow($hwnd, 9) | Out-Null; Start-Sleep -Milliseconds 300 }
    [Win32Window]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
    $curLeft = $rect.Left; $curTop = $rect.Top
    $curW = $rect.Right - $rect.Left; $curH = $rect.Bottom - $rect.Top
    $newW = if ($W -gt 0) { $W } else { $curW }
    $newH = if ($H -gt 0) { $H } else { $curH }
    $newX = if ($X -ne -99999) { $X } else { $curLeft }
    $newY = if ($Y -ne -99999) { $Y } else { $curTop }
    [Win32Window]::MoveWindow($hwnd, $newX, $newY, $newW, $newH, $true) | Out-Null
    Start-Sleep -Milliseconds 100
    [Win32Window]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
    $json = '{"ok":true,"action":"resize","hwnd":' + $hwnd.ToInt64() + ',"left":' + $rect.Left + ',"top":' + $rect.Top + ',"width":' + ($rect.Right - $rect.Left) + ',"height":' + ($rect.Bottom - $rect.Top) + '}'
    Write-Output $json
}
elseif ($Action -eq "maximize") {
    [Win32Window]::ShowWindow($hwnd, 3) | Out-Null
    Write-Output '{"ok":true,"action":"maximize"}'
}
