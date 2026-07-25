[CmdletBinding()]
param(
    [string]$RepositoryRoot = "",
    [string]$DatabasePath = "",
    [string]$Python = "python",
    [int]$Days = 30,
    [string]$TimeZone = "Asia/Shanghai",
    [switch]$Publish,
    [string]$Remote = "origin",
    [string]$Branch = "main"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) {
    $RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
} else {
    $RepositoryRoot = [IO.Path]::GetFullPath($RepositoryRoot)
}

if ([string]::IsNullOrWhiteSpace($DatabasePath)) {
    $DatabasePath = Join-Path $env:USERPROFILE ".cc-switch\cc-switch.db"
}

$generator = Join-Path $RepositoryRoot "tools\ai-usage-dashboard\generate.py"
$outputDirectory = Join-Path $RepositoryRoot "assets\ai-usage"
$logDirectory = Join-Path $RepositoryRoot ".local"
$logPath = Join-Path $logDirectory "ai-usage-dashboard.log"
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

function Write-UpdateLog {
    param([string]$Message)
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
    Write-Host $line
}

try {
    $pythonCommand = Get-Command $Python -ErrorAction Stop
    if (-not (Test-Path -LiteralPath $generator)) {
        throw "Generator not found: $generator"
    }

    if ($Publish) {
        $status = @(git -C $RepositoryRoot status --porcelain --untracked-files=no)
        if ($LASTEXITCODE -ne 0) {
            throw "Unable to inspect the profile repository"
        }
        if ($status.Count -gt 0) {
            throw "Repository has local tracked changes; refusing to publish over them"
        }

        git -C $RepositoryRoot fetch $Remote $Branch
        if ($LASTEXITCODE -ne 0) { throw "git fetch failed" }
        git -C $RepositoryRoot merge --ff-only "$Remote/$Branch"
        if ($LASTEXITCODE -ne 0) { throw "git fast-forward failed" }
    }

    Write-UpdateLog "Generating a $Days-day snapshot from $DatabasePath"
    & $pythonCommand.Source $generator `
        --database $DatabasePath `
        --output-dir $outputDirectory `
        --days $Days `
        --timezone $TimeZone
    if ($LASTEXITCODE -ne 0) {
        throw "Dashboard generator failed with exit code $LASTEXITCODE"
    }

    if ($Publish) {
        git -C $RepositoryRoot add -- `
            "assets/ai-usage/ai-usage-light.svg" `
            "assets/ai-usage/ai-usage-dark.svg"
        if ($LASTEXITCODE -ne 0) { throw "git add failed" }

        git -C $RepositoryRoot diff --cached --quiet -- `
            "assets/ai-usage/ai-usage-light.svg" `
            "assets/ai-usage/ai-usage-dark.svg"
        if ($LASTEXITCODE -eq 0) {
            Write-UpdateLog "No SVG changes; nothing to publish"
            exit 0
        }
        if ($LASTEXITCODE -ne 1) { throw "Unable to inspect staged SVG changes" }

        $commitDate = Get-Date -Format "yyyy-MM-dd"
        git -C $RepositoryRoot commit -m "chore: update AI usage dashboard ($commitDate)" -- `
            "assets/ai-usage/ai-usage-light.svg" `
            "assets/ai-usage/ai-usage-dark.svg"
        if ($LASTEXITCODE -ne 0) { throw "git commit failed" }
        git -C $RepositoryRoot push $Remote "HEAD:$Branch"
        if ($LASTEXITCODE -ne 0) { throw "git push failed" }
        Write-UpdateLog "Published the dashboard to $Remote/$Branch"
    } else {
        Write-UpdateLog "Generated local SVG assets (publish was not requested)"
    }
} catch {
    Write-UpdateLog "ERROR: $($_.Exception.Message)"
    exit 1
}
