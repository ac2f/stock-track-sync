$ErrorActionPreference = "SilentlyContinue"
$InstallDir = Join-Path $env:LOCALAPPDATA "StockTrackSync"
$TaskName = "StockTrack Esitleme Ajani"

Stop-ScheduledTask -TaskName $TaskName
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
if (Get-ScheduledTask -TaskName $TaskName) {
    Write-Host "Zamanlanmis gorev silinemedi: kaldirmayi 'Yonetici olarak calistir' ile yeniden deneyin."
}
Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -like "*StockTrackSync\run.ps1*" -or $_.CommandLine -like "*StockTrackSync\dist\main.js*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
# Ajan zorla durduruldu: yerel yazma duraklatmasi en cok 30 sn icinde kendiliginden kalkar.

$answer = Read-Host "Ayar (anahtar) ve gunluk dosyalari da silinsin mi? (e/h)"
if ($answer -eq "e") {
    Remove-Item $InstallDir -Recurse -Force
    Write-Host "Silindi: $InstallDir"
} else {
    foreach ($p in @("dist", "node_modules", "run.ps1", "package.json", "package-lock.json")) {
        Remove-Item (Join-Path $InstallDir $p) -Recurse -Force
    }
    Write-Host "Program kaldirildi; ayarlar ve gunlukler korundu: $InstallDir"
}
Write-Host "Yerel sunucu ve veritabanina dokunulmadi; bekleyen islemler giden kutusunda duruyor."
