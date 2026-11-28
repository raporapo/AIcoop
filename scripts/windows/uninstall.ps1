<#
.SYNOPSIS
  install.ps1 で入れたもの（スタートメニューの「AIcoop」・自動起動のタスク・ランチャー）を消す。

.DESCRIPTION
  WSL の中の設定（~/.aicoop）と、動いている制御サーバーには触らない
  （止めるなら WSL の中で aicoop stop）。管理者の権限は要らない。
#>
$ErrorActionPreference = "Stop"

$TaskName = "AIcoop 自動起動"
$InstallDir = Join-Path $env:LOCALAPPDATA "AIcoop"
$ShortcutPath = Join-Path ([Environment]::GetFolderPath("Programs")) "AIcoop.lnk"

if (Test-Path $ShortcutPath) {
  Remove-Item -LiteralPath $ShortcutPath -Force
  Write-Host "* スタートメニューの「AIcoop」を消しました"
}
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "* 自動起動のタスク「$TaskName」を消しました"
}
$launcher = Join-Path $InstallDir "aicoop-launcher.ps1"
if (Test-Path $launcher) {
  Remove-Item -LiteralPath $launcher -Force
  Write-Host "* ランチャーを消しました：$launcher"
}
if ((Test-Path $InstallDir) -and -not (Get-ChildItem -LiteralPath $InstallDir -Force)) {
  Remove-Item -LiteralPath $InstallDir -Force
}
Write-Host "消しました（WSL の中の ~/.aicoop はそのままです）。"
