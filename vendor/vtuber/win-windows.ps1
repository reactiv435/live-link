# One-click VTuber helper: looks at the windows on this PC and touches ONLY the one window it is told to, and only
# when that window still has the title the app expects (a guard against a reused window number).
#   -Action list                              every visible window with a title:  hwnd|pid|minimised|x,y,w,h|title
#   -Action place -Hwnd N -Title T -W w -H h  un-minimise without taking focus, make its INSIDE w x h, send it behind
# All numbers are real screen pixels (this script asks Windows not to scale them; on a 4K screen at 250 % a 1040 x 540
# window is about 420 x 220 of what he sees, and the page reads its 1040 x 540 pixels). The window handle is kept in
# $win: PowerShell names ignore case, so $h would be the same variable as the -H parameter.
#   -Action close -Hwnd N -Title T            ask that window to close (the same as its X button)
#   -Action front -Hwnd N -Title T            bring it to the front
#   -Action hide -Hwnd N -Title T             hide it (what the Hide button on Chrome's "is sharing a window" bar does)
[CmdletBinding(PositionalBinding = $false)]
param([string]$Action = 'list', [long]$Hwnd = 0, [string]$Title = '', [int]$W = 0, [int]$H = 0)
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class VT3Win {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int w, int h, uint flags);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static string TitleOf(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
  public static List<string> List() {
    var o = new List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      string t = TitleOf(h);
      if (t.Length == 0) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      RECT r; GetWindowRect(h, out r);
      o.Add(string.Format("{0}|{1}|{2}|{3},{4},{5},{6}|{7}", h.ToInt64(), pid, IsIconic(h) ? 1 : 0, r.L, r.T, r.R - r.L, r.B - r.T, t));
      return true;
    }, IntPtr.Zero);
    return o;
  }
}
"@
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try { if (-not [VT3Win]::SetProcessDpiAwarenessContext([IntPtr](-4))) { [VT3Win]::SetProcessDPIAware() | Out-Null } } catch { }   # real pixels
if ($Action -eq 'list') { [VT3Win]::List() | ForEach-Object { $_ }; exit 0 }
$win = [IntPtr]$Hwnd
if (-not [VT3Win]::IsWindow($win) -or [VT3Win]::TitleOf($win) -ne $Title) { 'gone'; exit 0 }
if ($Action -eq 'place') {
  if ([VT3Win]::IsIconic($win)) { [VT3Win]::ShowWindow($win, 4) | Out-Null }                 # SW_SHOWNOACTIVATE
  $flags = 0x0002 -bor 0x0010                                                                # no move, no focus
  $ow = 0; $oh = 0
  if ($W -le 0 -or $H -le 0) { $flags = $flags -bor 0x0001 }                                 # no resize
  else {                                                                                     # inside size + its frame
    $r = New-Object VT3Win+RECT; $c = New-Object VT3Win+RECT
    [VT3Win]::GetWindowRect($win, [ref]$r) | Out-Null; [VT3Win]::GetClientRect($win, [ref]$c) | Out-Null
    $ow = $W + [Math]::Max(0, ($r.R - $r.L) - $c.R); $oh = $H + [Math]::Max(0, ($r.B - $r.T) - $c.B)
  }
  [VT3Win]::SetWindowPos($win, [IntPtr]1, 0, 0, $ow, $oh, $flags) | Out-Null                 # 1 = behind the other windows
  'ok'
} elseif ($Action -eq 'close') { [VT3Win]::PostMessage($win, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null; 'ok' }
elseif ($Action -eq 'hide') { [VT3Win]::ShowWindow($win, 0) | Out-Null; 'ok' }                # SW_HIDE
elseif ($Action -eq 'front') { if ([VT3Win]::IsIconic($win)) { [VT3Win]::ShowWindow($win, 9) | Out-Null }; [VT3Win]::SetForegroundWindow($win) | Out-Null; 'ok' }
