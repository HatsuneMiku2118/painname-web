﻿param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

Write-Host ""
Write-Host "  给痛苦一个名字 · 本地预览" -ForegroundColor DarkYellow
Write-Host "  ------------------------------------" -ForegroundColor DarkGray

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host ""
  Write-Host "  未找到 Node.js。" -ForegroundColor Red
  Write-Host "  请先安装 Node 18 或更高版本：https://nodejs.org" -ForegroundColor DarkGray
  Read-Host "  按回车退出"
  exit 1
}

$port = 8123
if ($env:PORT) {
  try { $port = [int]$env:PORT } catch { }
}

function Test-LocalPort {
  param([int]$Port)
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne(500)) { return $false }
    return $client.Connected
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

if (Test-LocalPort $port) {
  Write-Host ""
  Write-Host "  端口 $port 上已经有一个预览服务在运行。" -ForegroundColor Yellow
  Write-Host "  直接打开现有页面；如需更换模型 Key，请先关闭原来的窗口再运行本脚本。" -ForegroundColor DarkGray
  Write-Host ""
  if (-not $NoBrowser) {
    Start-Process "http://127.0.0.1:$port"
  }
  exit 0
}

$keyFile = Join-Path $root 'llm.key'
$key = ''
if (Test-Path $keyFile) {
  $line = Get-Content -Path $keyFile -TotalCount 1 -ErrorAction SilentlyContinue
  if ($line) { $key = $line.Trim() }
}

if (-not $key -and -not $env:LLM_API_KEY) {
  Write-Host ""
  Write-Host "  未检测到模型 Key。" -ForegroundColor Yellow
  Write-Host "  · 直接回车：使用本地规则引擎，离线也能完整演示" -ForegroundColor DarkGray
  Write-Host "  · 粘贴智谱 Key 后回车：自动保存到 llm.key，仅本机使用" -ForegroundColor DarkGray
  $entered = Read-Host "  API Key"
  if ($entered -and $entered.Trim().Length -gt 0) {
    $key = $entered.Trim()
    Set-Content -Path $keyFile -Value $key -Encoding ASCII
    Write-Host "  已保存到 llm.key（请勿上传或提交到代码仓库）" -ForegroundColor Green
  }
}

if ($key) { $env:LLM_API_KEY = $key }

# 可选：服务商地址与模型名也可以写在本地文件里，避免每次手设环境变量
$baseFile = Join-Path $root 'llm.base'
$modelFile = Join-Path $root 'llm.model'
if (-not $env:LLM_BASE_URL -and (Test-Path $baseFile)) {
  $line = Get-Content -Path $baseFile -TotalCount 1 -ErrorAction SilentlyContinue
  if ($line) { $env:LLM_BASE_URL = $line.Trim() }
}
if (-not $env:LLM_MODEL -and (Test-Path $modelFile)) {
  $line = Get-Content -Path $modelFile -TotalCount 1 -ErrorAction SilentlyContinue
  if ($line) { $env:LLM_MODEL = $line.Trim() }
}

if ($env:LLM_API_KEY) {
  if (-not $env:LLM_MODEL) { $env:LLM_MODEL = 'glm-4-flash' }
  Write-Host ("  模型：{0}（已配置 Key）" -f $env:LLM_MODEL) -ForegroundColor Green
} else {
  Write-Host "  模型：本地规则模式" -ForegroundColor Yellow
}

$env:PORT = "$port"
$url = "http://127.0.0.1:$port"
Write-Host ("  地址：{0}" -f $url) -ForegroundColor DarkGray
Write-Host "  关闭窗口或按 Ctrl+C 结束。" -ForegroundColor DarkGray
Write-Host ""

if (-not $NoBrowser) {
  Start-Job -ScriptBlock {
    param($target)
    Start-Sleep -Seconds 2
    Start-Process $target
  } -ArgumentList $url | Out-Null
}

node server.mjs
if ($LASTEXITCODE -ne 0) {
  Write-Host ""
  Write-Host "  服务未能启动，请检查上方错误信息。" -ForegroundColor Red
  Read-Host "  按回车退出"
}
