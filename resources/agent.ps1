# BillTrix Print Agent - sends label printer files (PRN) straight to a Windows printer. Listens only on this computer.
$ErrorActionPreference = 'SilentlyContinue'
# web pages allowed to print through this agent (billtrix.in and the old cloud address); the shop Hub on the LAN is allowed below
$Allowed = @('https://billtrix.in', 'https://www.billtrix.in', 'https://billone.upendrakumar-raj.workers.dev')
$Port = 18181
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class BtRawPrn {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public class DOCINFO { [MarshalAs(UnmanagedType.LPWStr)] public string pDocName; [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile; [MarshalAs(UnmanagedType.LPWStr)] public string pDataType; }
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool OpenPrinter(string name, out IntPtr h, IntPtr d);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)] public static extern int StartDocPrinter(IntPtr h, int level, [In] DOCINFO di);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool WritePrinter(IntPtr h, byte[] b, int n, out int w);
  public static string Send(string printer, byte[] data) {
    IntPtr h; if (!OpenPrinter(printer, out h, IntPtr.Zero)) return "Printer not found: " + printer;
    DOCINFO di = new DOCINFO(); di.pDocName = "BillTrix labels"; di.pDataType = "RAW";
    string err = "";
    if (StartDocPrinter(h, 1, di) != 0) { if (StartPagePrinter(h)) { int w; if (!WritePrinter(h, data, data.Length, out w)) err = "Write failed"; EndPagePrinter(h); } else err = "Page failed"; EndDocPrinter(h); } else err = "Printer busy or offline";
    ClosePrinter(h); return err;
  }
}
'@
function Esc($s) { return ($s -replace '\\','\\' -replace '"','\"') }
function Reply($stream, $code, $body, $origin) {
  $b = [Text.Encoding]::UTF8.GetBytes($body)
  $h = "HTTP/1.1 $code`r`nContent-Type: application/json`r`nAccess-Control-Allow-Origin: $origin`r`nAccess-Control-Allow-Methods: GET, POST, OPTIONS`r`nAccess-Control-Allow-Headers: Content-Type`r`nAccess-Control-Allow-Private-Network: true`r`nContent-Length: $($b.Length)`r`nConnection: close`r`n`r`n"
  $hb = [Text.Encoding]::ASCII.GetBytes($h); $stream.Write($hb, 0, $hb.Length); if ($b.Length) { $stream.Write($b, 0, $b.Length) }; $stream.Flush()
}
try { $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port); $listener.Start() } catch { exit }
while ($true) {
  $client = $listener.AcceptTcpClient()
  try {
    $s = $client.GetStream(); $s.ReadTimeout = 8000
    $buf = New-Object byte[] 65536; $ms = New-Object System.IO.MemoryStream; $end = -1
    while ($end -lt 0) { $n = $s.Read($buf, 0, $buf.Length); if ($n -le 0) { break }; $ms.Write($buf, 0, $n); $all = $ms.ToArray(); $end = ([Text.Encoding]::ASCII.GetString($all)).IndexOf("`r`n`r`n") }
    if ($end -lt 0) { continue }
    $all = $ms.ToArray(); $head = [Text.Encoding]::ASCII.GetString($all, 0, $end); $lines = $head -split "`r`n"
    $req = $lines[0] -split ' '; $method = $req[0]; $path = $req[1]; $len = 0; $origin = ''
    foreach ($l in $lines) { if ($l -match '^(?i)content-length:\s*(\d+)') { $len = [int]$matches[1] }; if ($l -match '^(?i)origin:\s*(.+)$') { $origin = $matches[1].Trim() } }
    # the cloud address, or the shop's own BillTrix Hub on the local network (port 18300)
    # no Origin header (not a web page) may only ask /status; any other web page is refused
    $okOrigin = ((-not $origin) -and ($path -like '/status*')) -or ($Allowed -contains $origin) -or ($origin -match '^http://(localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}):18300$')
    if (-not $okOrigin) { Reply $s '403 Forbidden' '{"ok":false,"error":"not allowed"}' $Allowed[0]; continue }
    $ao = if ($origin) { $origin } else { $Allowed[0] }
    if ($method -eq 'OPTIONS') { Reply $s '204 No Content' '' $ao; continue }
    $body = New-Object byte[] $len; $have = $all.Length - ($end + 4); if ($have -gt 0) { [Array]::Copy($all, $end + 4, $body, 0, [Math]::Min($have, $len)) }
    while ($have -lt $len) { $n = $s.Read($body, $have, $len - $have); if ($n -le 0) { break }; $have += $n }
    $u = [Uri]('http://127.0.0.1' + $path)
    if ($u.AbsolutePath -eq '/status') {
      $names = @(); foreach ($p in [System.Drawing.Printing.PrinterSettings]::InstalledPrinters) { $names += '"' + (Esc $p) + '"' }
      Reply $s '200 OK' ('{"ok":true,"version":3,"printers":[' + ($names -join ',') + ']}') $ao
    } elseif ($u.AbsolutePath -eq '/print' -and $method -eq 'POST') {
      $printer = ''; foreach ($kv in $u.Query.TrimStart('?').Split('&')) { $p = $kv.Split('=', 2); if ($p[0] -eq 'printer' -and $p.Length -eq 2) { $printer = [Uri]::UnescapeDataString($p[1].Replace('+', ' ')) } }
      $err = [BtRawPrn]::Send($printer, $body)
      if ($err) { Reply $s '200 OK' ('{"ok":false,"error":"' + (Esc $err) + '"}') $ao } else { Reply $s '200 OK' '{"ok":true}' $ao }
    } elseif ($u.AbsolutePath -eq '/printimage' -and $method -eq 'POST') {
      $printer = ''; $wmm = 50; $hmm = 25; $dpi = 0
      foreach ($kv in $u.Query.TrimStart('?').Split('&')) { $p = $kv.Split('=', 2); if ($p.Length -eq 2) { $val = [Uri]::UnescapeDataString($p[1].Replace('+', ' ')); if ($p[0] -eq 'printer') { $printer = $val } elseif ($p[0] -eq 'w') { $wmm = [double]$val } elseif ($p[0] -eq 'h') { $hmm = [double]$val } elseif ($p[0] -eq 'dpi' -and $val) { $dpi = [double]$val } } }
      $err = ''
      try {
        $script:img = [System.Drawing.Image]::FromStream((New-Object System.IO.MemoryStream(,$body)))
        $script:pw = [int][Math]::Round($wmm / 25.4 * 100); $script:ph = [int][Math]::Round($hmm / 25.4 * 100)
        $pd = New-Object System.Drawing.Printing.PrintDocument
        $pd.PrinterSettings.PrinterName = $printer
        if (-not $pd.PrinterSettings.IsValid) { $err = 'Printer not found: ' + $printer } else {
          $pd.PrintController = New-Object System.Drawing.Printing.StandardPrintController
          $pd.DefaultPageSettings.PaperSize = New-Object System.Drawing.Printing.PaperSize('BillTrix', $script:pw, $script:ph)
          $pd.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0, 0, 0, 0)
          $pd.OriginAtMargins = $false
          if ($dpi -gt 0) { $script:dw = [single]($script:img.Width / $dpi * 100); $script:dh = [single]($script:img.Height / $dpi * 100) } else { $script:dw = [single]$script:pw; $script:dh = [single]$script:ph }
          $pd.add_PrintPage({ param($snd, $ev) $ev.Graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor; $ev.Graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half; $ev.Graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::None; $ev.Graphics.DrawImage($script:img, [single]0, [single]0, $script:dw, $script:dh); $ev.HasMorePages = $false })
          $pd.Print()
        }
        $script:img.Dispose()
      } catch { $err = 'Print failed: ' + $_.Exception.Message }
      if ($err) { Reply $s '200 OK' ('{"ok":false,"error":"' + (Esc $err) + '"}') $ao } else { Reply $s '200 OK' '{"ok":true}' $ao }
    } elseif ($u.AbsolutePath -eq '/info') {
      $printer = ''; foreach ($kv in $u.Query.TrimStart('?').Split('&')) { $p = $kv.Split('=', 2); if ($p[0] -eq 'printer' -and $p.Length -eq 2) { $printer = [Uri]::UnescapeDataString($p[1].Replace('+', ' ')) } }
      $ps = New-Object System.Drawing.Printing.PrinterSettings; $ps.PrinterName = $printer; $d = 0
      if ($ps.IsValid) { $d = $ps.DefaultPageSettings.PrinterResolution.X; if ($d -le 0) { foreach ($r in $ps.PrinterResolutions) { if ($r.X -gt $d) { $d = $r.X } } } }
      Reply $s '200 OK' ('{"ok":true,"dpi":' + [int]$d + '}') $ao
    } else { Reply $s '404 Not Found' '{"ok":false}' $ao }
  } catch { } finally { $client.Close() }
}
