param(
  [Parameter(Mandatory = $true)]
  [string]$BinPath
)

$ErrorActionPreference = "Stop"
$UsbPrintGuid = "{28d78fad-5a12-11d1-ae5b-0000f803a8c2}"

function Get-UsbPrintDevicePath {
  if ($env:USBPRINT_PATH) {
    return $env:USBPRINT_PATH
  }

  $portsKey = "HKLM:\SYSTEM\CurrentControlSet\Control\Print\Monitors\USB Monitor\Ports"
  if (Test-Path $portsKey) {
    foreach ($port in Get-ChildItem $portsKey) {
      $props = Get-ItemProperty $port.PSPath
      if ($props."Device Path") {
        return [string]$props."Device Path"
      }
    }
  }

  $vid = if ($env:PRINTER_VID) { $env:PRINTER_VID } else { "6868" }
  $pid = if ($env:PRINTER_PID) { $env:PRINTER_PID } else { "0200" }
  $device = Get-PnpDevice -ErrorAction SilentlyContinue |
    Where-Object { $_.InstanceId -like "USB\VID_$vid&PID_$pid*" } |
    Select-Object -First 1
  if ($device) {
    $serial = ($device.InstanceId -split "\\")[-1]
    return "\\?\usb#vid_$vid&pid_$pid#$serial#$UsbPrintGuid"
  }

  throw "No USB printer port found. Plug the thermal printer in and power it on."
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class EcoNovaUsbPrint {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr CreateFile(string lpFileName, uint dwDesiredAccess, uint dwShareMode, IntPtr lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool WriteFile(IntPtr hFile, byte[] lpBuffer, uint nNumberOfBytesToWrite, out uint lpNumberOfBytesWritten, IntPtr lpOverlapped);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr hObject);
}
"@

if (-not (Test-Path -LiteralPath $BinPath)) {
  throw "Print data file not found: $BinPath"
}

$bytes = [System.IO.File]::ReadAllBytes($BinPath)
if ($bytes.Length -lt 1) {
  throw "Print data file is empty."
}

$path = Get-UsbPrintDevicePath
$GENERIC_WRITE = [uint32]0x40000000
$SHARE = [uint32]3
$OPEN_EXISTING = [uint32]3
$handle = [EcoNovaUsbPrint]::CreateFile($path, $GENERIC_WRITE, $SHARE, [IntPtr]::Zero, $OPEN_EXISTING, 0, [IntPtr]::Zero)
if ($handle -eq [IntPtr]::Zero -or $handle.ToInt64() -eq -1) {
  $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  throw "Could not open the USB printer ($path). Windows error $err."
}

try {
  $written = [uint32]0
  $ok = [EcoNovaUsbPrint]::WriteFile($handle, $bytes, [uint32]$bytes.Length, [ref]$written, [IntPtr]::Zero)
  if (-not $ok) {
    $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "Printer did not accept the receipt. Windows error $err."
  }
  Write-Output "OK $written"
}
finally {
  [EcoNovaUsbPrint]::CloseHandle($handle) | Out-Null
}
