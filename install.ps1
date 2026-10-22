$ErrorActionPreference = "Stop"
# Node'un Turkce ciktisi konsolda dogru gorunsun.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$InstallDir = Join-Path $env:LOCALAPPDATA "StockTrackSync"
$TaskName = "StockTrack Esitleme Ajani"

Write-Host "StockTrack esitleme ajani kuruluyor -> $InstallDir"

# Node.js 20 ya da daha yenisi gerekli (yerel sunucu da Node ile calisir).
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Error "Node.js bulunamadi. https://nodejs.org adresinden Node.js 20 LTS (ya da daha yenisini) kurun, sonra bu kurulumu tekrar calistirin."
    exit 1
}
$NodeExe = $node.Source
$major = [int](& $NodeExe -p "process.versions.node.split('.')[0]")
if ($major -lt 20) {
    Write-Error "Node.js $major eski; 20 ya da daha yenisi gerekli."
    exit 1
}

# Calisiyorsa once durdur (dosyalar degisecek).
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*StockTrackSync\run.ps1*" -or $_.CommandLine -like "*StockTrackSync\dist\main.js*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# Derle (kaynak klasorunde), sonra yalniz calisma dosyalarini kopyala.
Push-Location $ScriptDir
try {
    & npm.cmd ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm ci basarisiz (internet baglantisini kontrol edin)." }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "Derleme basarisiz." }
} finally {
    Pop-Location
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$Dist = Join-Path $InstallDir "dist"
if (Test-Path $Dist) { Remove-Item $Dist -Recurse -Force }
Copy-Item -Path (Join-Path $ScriptDir "dist") -Destination $Dist -Recurse
Copy-Item -Path (Join-Path $ScriptDir "package.json"), (Join-Path $ScriptDir "package-lock.json") -Destination $InstallDir -Force
Push-Location $InstallDir
try {
    & npm.cmd ci --omit=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm ci (calisma paketleri) basarisiz." }
} finally {
    Pop-Location
}

$ConfigPath = Join-Path $InstallDir "config.json"
if (-not (Test-Path $ConfigPath)) {
    $cfg = Get-Content (Join-Path $ScriptDir "config.example.json") -Raw -Encoding UTF8 | ConvertFrom-Json
    Write-Host ""
    Write-Host "Merkezde Ayarlar > Yerel sunucular sayfasindan bu dukkan icin bir anahtar uretin."
    $url = Read-Host "Merkez sunucu adresi (ornek https://stok.ornek.com/api/v1)"
    if ($url) { $cfg.UPSTREAM_URL = $url.Trim().TrimEnd('/') }
    $secure = Read-Host "Yerel sunucu anahtari (str_ ile baslar; yazarken gorunmez)" -AsSecureString
    $token = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
    if ($token) { $cfg.REPLICA_TOKEN = $token.Trim() }
    $dbPass = Read-Host "Yerel veritabani parolasi (bos birakirsaniz: stocktrack)"
    if ($dbPass) {
        $cfg.REPLICA_DB_URL = "postgres://stocktrack:$([uri]::EscapeDataString($dbPass))@127.0.0.1:5433/stocktrack"
    }
    $json = $cfg | ConvertTo-Json -Depth 5
    [System.IO.File]::WriteAllText($ConfigPath, $json, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "Ayar dosyasi olusturuldu: $ConfigPath"
} else {
    Write-Host "Mevcut ayar dosyasi korundu: $ConfigPath"
}
$cfg = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json

# Ayar dosyasi anahtar ve veritabani parolasi icerir: yalniz bu kullanici,
# SYSTEM ve yoneticiler okuyabilsin (adlar Turkce Windows'ta da gecerli olsun diye SID).
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls $ConfigPath /inheritance:r /grant:r "*${me}:(F)" "*S-1-5-18:(F)" "*S-1-5-32-544:(F)" | Out-Null

Write-Host ""
Write-Host "Baglanti deneniyor..."
Push-Location $InstallDir
& $NodeExe (Join-Path $InstallDir "dist\main.js") --check
Pop-Location
Write-Host ""

# Calistirici: ajani baslatir, coker ya da kapanirsa yeniden baslatir.
$RunPath = Join-Path $InstallDir "run.ps1"
$q = { param($s) $s.Replace("'", "''") }
$run = @"
# StockTrack esitleme ajani: calistirir; coker ya da kapanirsa 5 sn sonra yeniden baslatir.
# Cikis kodu 2 kisi mudahalesi gerektirir (ikinci ajan, yanlis veritabani): 5 dk sonra yeniden denenir.
Set-Location '$(& $q $InstallDir)'
while (`$true) {
    & '$(& $q $NodeExe)' '$(& $q (Join-Path $InstallDir "dist\main.js"))'
    if (`$LASTEXITCODE -eq 2) { Start-Sleep -Seconds 300 } else { Start-Sleep -Seconds 5 }
}
"@
[System.IO.File]::WriteAllText($RunPath, $run, (New-Object System.Text.UTF8Encoding($true)))

# Zamanlanmis gorev: yonetici olarak kurulduysa bilgisayar acilisinda (oturum
# acilmadan, hizmet gibi), degilse oturum acilisinda baslar.
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $RunPath + '"') `
    -WorkingDirectory $InstallDir
if ($isAdmin) {
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
    $when = "bilgisayar acilisinda (oturum acmadan)"
} else {
    $user = "$env:USERDOMAIN\$env:USERNAME"
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $when = "oturum acilisinda (bilgisayar acilisinda calismasi icin kurulumu 'Yonetici olarak calistir' ile yapin)"
}
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
    -Description "StockTrack yerel sunucusunu merkezle esitler (stock-track-sync)." -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "Ajan $when baslayacak; simdi baslatildi."

Write-Host "Ilk turu bekleniyor..."
$port = if ($cfg.STATUS_PORT) { $cfg.STATUS_PORT } else { 3100 }
$health = $null
for ($i = 0; $i -lt 15 -and -not $health; $i++) {
    Start-Sleep -Seconds 2
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 3
    } catch {
        if ($_.ErrorDetails.Message) { $health = $_.ErrorDetails.Message | ConvertFrom-Json }
    }
}
if ($health) {
    Write-Host ("Merkez baglantisi: " + $(if ($health.upstream) { "var" } else { "yok" }) + " | bekleyen: " + $health.pending + " | reddedilen: " + $health.rejected)
    if ($health.lastError) { Write-Host ("Son hata: " + $health.lastError) }
} else {
    Write-Host "Durum alinamadi; gunlukler: $InstallDir\logs"
}
Write-Host ""
Write-Host "Kurulum tamamlandi. Durumu yerel sunucunun Esitleme ekranindan izleyebilirsiniz."
Write-Host "Gunlukler: $InstallDir\logs"
