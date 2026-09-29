<#
.SYNOPSIS
    把 module/ 打成可刷入 KernelSU 的模块 zip.

.DESCRIPTION
    模块 zip 的结构要求是 module.prop 位于 zip 根部 (不能多一层目录).
    所以这里先把 module/ 的内容拷到 staging, 再把 staging 的内容压成 zip.

    默认打本仓库里的 probe 模块. 打别的模块用 -ModuleDir.

    注意: 本脚本按 PowerShell 5.1 写 (Windows 自带的那版), 不用三元运算符等 7.x 语法.

.PARAMETER ModuleDir
    要打包的模块目录 (里面应当有 module.prop). 默认 <probe>/module.
    相对路径按当前工作目录解析.

.PARAMETER DistDir
    zip 输出目录. 默认是模块目录上一级下的 dist/.

.PARAMETER SkipRuntime
    不检查/不要求 usr/ 里有 Node 运行时. 用来快速验证打包结构.

.PARAMETER NoZip
    只做 staging, 不压缩. 用来肉眼检查目录结构.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File probe\tools\build-module.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File probe\tools\build-module.ps1 -ModuleDir dsh\module
#>
[CmdletBinding()]
param(
    [string]$ModuleDir = '',
    [string]$DistDir = '',
    [switch]$SkipRuntime,
    [switch]$NoZip
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrEmpty($ModuleDir)) { $ModuleDir = Join-Path $Root 'module' }
if (-not (Test-Path $ModuleDir)) { throw "模块目录不存在: $ModuleDir" }
$ModuleDir = (Resolve-Path $ModuleDir).Path

# staging 与 dist 都放在模块目录的上一级, 免得两个模块互相踩
$ModuleParent = Split-Path -Parent $ModuleDir
if ([string]::IsNullOrEmpty($DistDir)) { $DistDir = Join-Path $ModuleParent 'dist' }
$StageDir = Join-Path $ModuleParent '.stage'

Write-Host 'DSH Android Runtime Probe - 打包' -ForegroundColor Cyan
Write-Host '=========================================================='

if (-not (Test-Path $ModuleDir)) { throw "找不到 module 目录: $ModuleDir" }

# ── 读版本 ────────────────────────────────────────────────
$propPath = Join-Path $ModuleDir 'module.prop'
if (-not (Test-Path $propPath)) { throw "找不到 module.prop: $propPath" }

$prop = @{}
foreach ($line in (Get-Content $propPath)) {
    if ($line -match '^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$') { $prop[$Matches[1]] = $Matches[2].Trim() }
}
$modId      = $prop['id']
$modVersion = $prop['version']
if ([string]::IsNullOrEmpty($modId))      { throw 'module.prop 里没有 id' }
if ([string]::IsNullOrEmpty($modVersion)) { throw 'module.prop 里没有 version' }

Write-Host ("模块 id:      {0}" -f $modId)
Write-Host ("模块版本:     {0}" -f $modVersion)

# ── 运行时检查 ────────────────────────────────────────────
$usrDir  = Join-Path $ModuleDir 'usr'
$nodeBin = Join-Path $usrDir 'bin\node'

if ($SkipRuntime) {
    Write-Host '运行时检查:   已跳过 (-SkipRuntime)' -ForegroundColor Yellow
} elseif (Test-Path $nodeBin) {
    $sizeMiB = [math]::Round((Get-Item $nodeBin).Length / 1MB, 1)
    Write-Host ("运行时检查:   bin/node 存在 ({0} MiB)" -f $sizeMiB) -ForegroundColor Green
} else {
    Write-Host '运行时检查:   bin/node 不存在' -ForegroundColor Red
    Write-Host ''
    Write-Host '  先跑这个把运行时解出来:' -ForegroundColor Yellow
    Write-Host '    node tools/fetch-runtime.mjs --with-koffi' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '  只想验证打包结构的话, 加 -SkipRuntime.' -ForegroundColor Yellow
    throw '缺少 Node 运行时'
}

# ── staging ───────────────────────────────────────────────
if (Test-Path $StageDir) { Remove-Item -Recurse -Force $StageDir }
New-Item -ItemType Directory -Path $StageDir -Force | Out-Null

Write-Host ''
Write-Host '正在 staging...' -ForegroundColor Cyan
$copied = 0
Get-ChildItem -Path $ModuleDir -Force | ForEach-Object {
    Copy-Item -Path $_.FullName -Destination $StageDir -Recurse -Force
    $copied++
}
Write-Host ("  拷入 {0} 个顶层项" -f $copied)

# module.prop 必须在根部
if (-not (Test-Path (Join-Path $StageDir 'module.prop'))) {
    throw 'staging 后 module.prop 不在根部, 打包结构不对'
}

$fileCount = (Get-ChildItem -Path $StageDir -Recurse -File | Measure-Object).Count
Write-Host ("  staging 共 {0} 个文件" -f $fileCount)

if ($NoZip) {
    Write-Host ''
    Write-Host ("-NoZip 指定, staging 保留在: {0}" -f $StageDir) -ForegroundColor Yellow
    exit 0
}

# ── 打包 ──────────────────────────────────────────────────
if (-not (Test-Path $DistDir)) { New-Item -ItemType Directory -Path $DistDir -Force | Out-Null }
$zipName = "{0}-v{1}.zip" -f $modId, $modVersion
$zipPath = Join-Path $DistDir $zipName
if (Test-Path $zipPath) { Remove-Item -Force $zipPath }

Write-Host ''
Write-Host '正在压缩 (大文件会慢, 请耐心)...' -ForegroundColor Cyan

# 不用 Compress-Archive: 它在 Windows 上把 zip 条目名写成 "probe\probe.mjs" (反斜杠),
# 而 ZIP 规范要求 "/", Android 的解压器不认, 会解出一个名字里带反斜杠的文件.
# 这里手工建条目, 分隔符强制成 "/", 并顺手写上 Unix 权限位.
Add-Type -AssemblyName System.IO.Compression | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null

$stageFull = (Resolve-Path $StageDir).Path.TrimEnd('\')
$zipStream = [System.IO.File]::Open($zipPath, [System.IO.FileMode]::Create)
$archive = New-Object System.IO.Compression.ZipArchive($zipStream, [System.IO.Compression.ZipArchiveMode]::Create)

$entries = 0
try {
    Get-ChildItem -Path $StageDir -Recurse -File -Force | ForEach-Object {
        $full = $_.FullName
        $rel = $full.Substring($stageFull.Length + 1).Replace('\', '/')

        $entry = $archive.CreateEntry($rel, [System.IO.Compression.CompressionLevel]::Optimal)

        # Unix 模式位放在 external attributes 的高 16 位.
        # 0755 给 usr/ 下的东西 (bin/libexec 里的可执行文件) 以及 .sh
        $isExec = $false
        if ($rel -like 'usr/*') { $isExec = $true }
        if ($rel -like '*.sh')  { $isExec = $true }
        if ($isExec) { $entry.ExternalAttributes = (0x81ED -shl 16) }
        else         { $entry.ExternalAttributes = (0x81A4 -shl 16) }

        $entryStream = $entry.Open()
        try {
            $fileStream = [System.IO.File]::OpenRead($full)
            try { $fileStream.CopyTo($entryStream) } finally { $fileStream.Dispose() }
        } finally { $entryStream.Dispose() }

        $entries++
    }
} finally {
    $archive.Dispose()
    $zipStream.Dispose()
}
Write-Host ("  写入 {0} 个条目" -f $entries)

$zipMiB = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)
Write-Host ''
Write-Host '=========================================================='
Write-Host ("打包完成: {0}" -f $zipPath) -ForegroundColor Green
Write-Host ("大小:     {0} MiB" -f $zipMiB)
Write-Host ''
Write-Host '刷入方式:' -ForegroundColor Cyan
Write-Host '  1. 把 zip 传到手机'
Write-Host '  2. KernelSU 管理器 -> 模块 -> 从本地安装 -> 选这个 zip'
Write-Host '  3. 安装过程会直接在界面上跑探针, 结果就在安装日志里'
Write-Host '  4. 重启后 service.sh 会再跑一次, 日志在 /data/local/tmp/dsh-probe/boot-probe.log'
Write-Host ''
Write-Host '把安装日志或 boot-probe.log 贴回来即可.' -ForegroundColor Yellow

Remove-Item -Recurse -Force $StageDir -ErrorAction SilentlyContinue
