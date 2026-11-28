<#
.SYNOPSIS
  AIcoop のランチャーと、ログオン時の自動起動を入れる（設計書 5.14 の1）。管理者の権限は要らない。

.DESCRIPTION
  1. WSL の中に aicoop コマンドがあるか確かめる（なければ、入れ方を出して止める）
  2. ランチャー（aicoop-launcher.ps1）を %LOCALAPPDATA%\AIcoop\ に置く
  3. スタートメニューに「AIcoop」のショートカットを作る（窓なしでランチャーを動かす）
  4. ログオン時の自動起動のタスク「AIcoop 自動起動」を登録し直す（すでにあれば置き換える）。
     タスクは WSL の中で `aicoop start --autostart` を動かす。設定（~/.aicoop/aicoop.yaml）がなければ
     何もせず、動いていれば何もせず、そうでなければ起動して ~/.aicoop/logs/autostart.log に書く

  何度実行してもよい（置き換える）。消すときは uninstall.ps1。

.PARAMETER Distro
  WSL のディストリの名前（既定：既定のディストリ）

.PARAMETER User
  WSL の中のユーザー（既定：そのディストリの既定のユーザー）

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\windows\install.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\windows\install.ps1 -Distro Ubuntu -User kaede
#>
param(
  [string]$Distro = "",
  [string]$User = ""
)

$ErrorActionPreference = "Stop"

$TaskName = "AIcoop 自動起動"
$InstallDir = Join-Path $env:LOCALAPPDATA "AIcoop"
$LauncherName = "aicoop-launcher.ps1"
$ShortcutPath = Join-Path ([Environment]::GetFolderPath("Programs")) "AIcoop.lnk"
$Wsl = Join-Path $env:SystemRoot "System32\wsl.exe"
$Conhost = Join-Path $env:SystemRoot "System32\conhost.exe"
$PowerShellExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"

function Write-Step([string]$Text) { Write-Host "* $Text" }

function ConvertTo-Argument([string]$Value) {
  if ($Value -ne "" -and $Value -notmatch '[\s"]') { return $Value }
  return '"' + ($Value -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

# -d・-u（指定したときだけ）
$target = @()
if ($Distro -ne "") { $target += @("-d", $Distro) }
if ($User -ne "") { $target += @("-u", $User) }
$where = if ($Distro -ne "") { "WSL（$Distro）" } else { "WSL（既定のディストリ）" }

# 1. WSL と aicoop
if (-not (Test-Path $Wsl)) {
  Write-Host "WSL（wsl.exe）が見つかりません。管理者の PowerShell で wsl --install を実行し、再起動してから、もう一度実行してください。" -ForegroundColor Red
  exit 1
}
$env:WSL_UTF8 = "1"
# wsl -e は .profile を読まないので、ランチャー・自動起動と同じ PATH で探す
& $Wsl @target -e sh -c "command -v aicoop" | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host "$where の中に aicoop コマンドが見つかりません（wsl -e で動かすので、/usr/local/bin などに置く必要があります）。" -ForegroundColor Red
  Write-Host ""
  Write-Host "Ubuntu の中で、次のように入れてください（リポジトリが ~/AIcoop にあるとき）："
  Write-Host ""
  Write-Host '  printf ''#!/bin/sh\nexec %s %s/AIcoop/packages/cli/bin/aicoop.ts "$@"\n'' "$(command -v node)" "$HOME" | sudo tee /usr/local/bin/aicoop >/dev/null'
  Write-Host "  sudo chmod 755 /usr/local/bin/aicoop"
  Write-Host ""
  Write-Host "くわしくは README の「Windows」の節を見てください。入れたら、もう一度このスクリプトを実行します。"
  exit 1
}

# 2. ランチャーを置く
$source = Join-Path $PSScriptRoot $LauncherName
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$launcher = Join-Path $InstallDir $LauncherName
Copy-Item -Path $source -Destination $launcher -Force
Write-Step "ランチャーを置きました：$launcher"

# 3. スタートメニューのショートカット
$launcherArgs = @("-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", $launcher)
if ($Distro -ne "") { $launcherArgs += @("-Distro", $Distro) }
if ($User -ne "") { $launcherArgs += @("-User", $User) }
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($ShortcutPath)
$lnk.TargetPath = $PowerShellExe
$lnk.Arguments = ($launcherArgs | ForEach-Object { ConvertTo-Argument $_ }) -join " "
$lnk.WorkingDirectory = $InstallDir
$lnk.WindowStyle = 7   # 最小化（窓を出さない）
$lnk.Description = "AIcoop の承認アプリを開く"
$lnk.Save()
Write-Step "スタートメニューに「AIcoop」を作りました：$ShortcutPath"

# 4. ログオン時の自動起動（置き換える）
$taskArgs = @("--headless", $Wsl, "--cd", "~") + $target + @("-e", "aicoop", "start", "--autostart")
$action = New-ScheduledTaskAction -Execute $Conhost -Argument (($taskArgs | ForEach-Object { ConvertTo-Argument $_ }) -join " ")
$me = "$env:USERDOMAIN\$env:USERNAME"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $me
$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal `
  -Settings $settings -Description "Windows にログインしたら、WSL の中で AIcoop の制御サーバーを起動する（aicoop start --autostart）" | Out-Null
Write-Step "ログオン時の自動起動のタスク「$TaskName」を登録しました"

Write-Host ""
Write-Host "できました。スタートメニューの「AIcoop」から開けます。"
Write-Host "  はじめて開くと、設定の雛形を作り、制御サーバーを起動して、この PC のブラウザを承認アプリの端末として登録します。"
Write-Host "  自動起動の記録：$where の ~/.aicoop/logs/autostart.log"
Write-Host "  消すとき：powershell -ExecutionPolicy Bypass -File `"$(Join-Path $PSScriptRoot 'uninstall.ps1')`""
