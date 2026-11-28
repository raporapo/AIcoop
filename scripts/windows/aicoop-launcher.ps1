<#
.SYNOPSIS
  AIcoop のランチャー（設計書 5.14 の1）。スタートメニューの「AIcoop」から開く。

.DESCRIPTION
  WSL2 の中で `aicoop open --launcher` を窓なしで動かし、出てきた JSON の行を読む。
    open      … URL（http://localhost:<port>/app/ で始まるものだけ）を既定のブラウザで開く
    confirm   … 確認コードをメッセージボックス（はい／いいえ）で見せ、答え（yes / no）を返す
    cancelled … 登録をやめたことを見せる
    error     … メッセージとヒントを見せる
    done      … 終わり
  形は packages/cli/src/commands/open.ts の先頭に書いてある。
  二重に開かないよう、Mutex（Local\AIcoop-Launcher）を取る。

.PARAMETER Distro
  WSL のディストリの名前（既定：既定のディストリ）

.PARAMETER User
  WSL の中のユーザー（既定：そのディストリの既定のユーザー）

.PARAMETER Command
  WSL の中の aicoop コマンド（既定：aicoop。PATH から探す）
#>
param(
  [string]$Distro = "",
  [string]$User = "",
  [string]$Command = "aicoop"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms

$Title = "AIcoop"

# メッセージボックスを、ほかの窓（ブラウザ）の後ろに隠れないよう、最前面の見えない窓の子にする
function Show-Box {
  param(
    [string]$Text,
    [System.Windows.Forms.MessageBoxButtons]$Buttons = "OK",
    [System.Windows.Forms.MessageBoxIcon]$Icon = "Information",
    [System.Windows.Forms.MessageBoxDefaultButton]$Default = "Button1"
  )
  $owner = New-Object System.Windows.Forms.Form
  $owner.TopMost = $true
  $owner.ShowInTaskbar = $false
  $owner.StartPosition = "CenterScreen"
  $owner.Size = New-Object System.Drawing.Size(1, 1)
  $owner.Opacity = 0
  $owner.Show()
  $owner.Activate()
  try {
    return [System.Windows.Forms.MessageBox]::Show($owner, $Text, $Title, $Buttons, $Icon, $Default)
  } finally {
    $owner.Close()
    $owner.Dispose()
  }
}

# Windows の引数の決まりで、1つの引数を引用符で囲む
function ConvertTo-Argument([string]$Value) {
  if ($Value -ne "" -and $Value -notmatch '[\s"]') { return $Value }
  return '"' + ($Value -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

# 人に見せる文字から、制御文字・向きを変える文字を除く（CLI でも除いてあるが、念のため）
function Get-CleanText([string]$Value) {
  if ($null -eq $Value) { return "" }
  return ($Value -replace '[\x00-\x1f\x7f-\x9f؜‎‏‪-‮⁦-⁩  ]', '')
}

$mutex = New-Object System.Threading.Mutex($false, "Local\AIcoop-Launcher")
$owned = $false
try {
  try {
    $owned = $mutex.WaitOne(0)
  } catch [System.Threading.AbandonedMutexException] {
    $owned = $true
  }
  if (-not $owned) {
    Show-Box "AIcoop はもう開いています。確かめの窓が、ほかの窓の後ろに隠れていないか見てください。" | Out-Null
    exit 0
  }

  $wsl = Join-Path $env:SystemRoot "System32\wsl.exe"
  if (-not (Test-Path $wsl)) {
    Show-Box "WSL（wsl.exe）が見つかりません。管理者の PowerShell で wsl --install を実行してから、もう一度開いてください。" -Icon Error | Out-Null
    exit 1
  }

  # 作業フォルダは WSL の中のホーム（Windows のフォルダに移ろうとして警告が出ないように）
  $wslArgs = @("--cd", "~")
  if ($Distro -ne "") { $wslArgs += @("-d", $Distro) }
  if ($User -ne "") { $wslArgs += @("-u", $User) }
  $wslArgs += @("-e", $Command, "open", "--launcher")

  $utf8 = New-Object System.Text.UTF8Encoding($false)
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $wsl
  $psi.Arguments = ($wslArgs | ForEach-Object { ConvertTo-Argument $_ }) -join " "
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = $utf8
  $psi.StandardErrorEncoding = $utf8
  # wsl.exe 自身のメッセージ（ディストリがない など）も UTF-8 にする
  $psi.EnvironmentVariables["WSL_UTF8"] = "1"

  $proc = [System.Diagnostics.Process]::Start($psi)
  $stderrTask = $proc.StandardError.ReadToEndAsync()
  $shown = $false   # 終わりの知らせ（done・cancelled・error）を受けたか

  while ($null -ne ($line = $proc.StandardOutput.ReadLine())) {
    try {
      $ev = $line | ConvertFrom-Json
    } catch {
      continue   # JSON でない行は読み飛ばす
    }
    switch ([string]$ev.event) {
      "open" {
        $url = [string]$ev.url
        # 承認アプリの URL だけを開く（ほかのもの・ファイル・プログラムは開かない）
        if ($url -match '^http://localhost:\d{1,5}/app/[A-Za-z0-9/#?=&%._~-]*$') {
          try {
            Start-Process $url
          } catch {
            Show-Box ("ブラウザを開けませんでした。次の URL を、ブラウザで開いてください。`n`n" + $url) -Icon Warning | Out-Null
          }
        }
      }
      "confirm" {
        $code = [string]$ev.code
        $answer = "no"
        if ($code -match '^\d{6}$') {
          $name = Get-CleanText ([string]$ev.device_name)
          $spaced = $code.Substring(0, 3) + " " + $code.Substring(3)
          $text = "ブラウザに出ている6桁の確認コードは、次の数字と同じですか？`n`n" +
            "    確認コード：$spaced`n" +
            "    端末の名前：$name`n`n" +
            "同じなら「はい」を押してください。このブラウザが、承認アプリの端末として有効になります。`n`n" +
            "違うとき・覚えのないときは「いいえ」を押してください（ほかのだれかが登録しようとしているかもしれません）。"
          $result = Show-Box $text -Buttons YesNo -Icon Question -Default Button2
          if ($result -eq [System.Windows.Forms.DialogResult]::Yes) { $answer = "yes" }
        }
        $bytes = $utf8.GetBytes("$answer`n")
        $proc.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
        $proc.StandardInput.BaseStream.Flush()
      }
      "cancelled" {
        $shown = $true
        Show-Box (Get-CleanText ([string]$ev.message)) | Out-Null
      }
      "error" {
        $shown = $true
        $hints = @($ev.hints | ForEach-Object { "  " + (Get-CleanText ([string]$_)) }) | Select-Object -First 20
        $text = (Get-CleanText ([string]$ev.message))
        if ($hints.Count -gt 0) { $text += "`n`n" + ($hints -join "`n") }
        Show-Box $text -Icon Error | Out-Null
      }
      "done" {
        $shown = $true
      }
    }
  }
  $proc.WaitForExit()

  if (-not $shown) {
    # aicoop が JSON を出す前に終わった（WSL がない・aicoop が PATH にない など）
    $tail = (($stderrTask.Result -split "`r?`n") | ForEach-Object { Get-CleanText $_ } |
        Where-Object { $_ -ne "" } | Select-Object -Last 8) -join "`n"
    $text = "AIcoop を開けませんでした（終了コード $($proc.ExitCode)）。"
    if ($tail -ne "") { $text += "`n`n" + $tail }
    $text += "`n`nWSL の中に aicoop コマンドがあるか確かめてください（README の「Windows」の節）。"
    Show-Box $text -Icon Error | Out-Null
  }
  exit $proc.ExitCode
} finally {
  if ($owned) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
