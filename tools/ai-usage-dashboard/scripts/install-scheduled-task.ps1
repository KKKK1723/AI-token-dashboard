[CmdletBinding()]
param(
    [string]$RepositoryRoot = "",
    [string]$TaskName = "AI-token Dashboard",
    [string]$At = "03:10",
    [switch]$Publish
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) {
    $RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
} else {
    $RepositoryRoot = [IO.Path]::GetFullPath($RepositoryRoot)
}

$time = [DateTime]::ParseExact($At, "HH:mm", [Globalization.CultureInfo]::InvariantCulture)
$runAt = (Get-Date).Date.AddHours($time.Hour).AddMinutes($time.Minute)
$updateScript = Join-Path $RepositoryRoot "tools\ai-usage-dashboard\scripts\update-dashboard.ps1"
if (-not (Test-Path -LiteralPath $updateScript)) {
    throw "Update script not found: $updateScript"
}

$arguments = @(
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    "`"$updateScript`"",
    "-RepositoryRoot",
    "`"$RepositoryRoot`""
)
if ($Publish) { $arguments += "-Publish" }

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument ($arguments -join " ")
$trigger = New-ScheduledTaskTrigger -Daily -At $runAt
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
$principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Limited

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Generate the AI-token monitoring dashboard from CCSwitch" `
    -Force | Out-Null

Write-Host "Registered '$TaskName' for daily execution at $At."
if ($Publish) {
    Write-Host "Mode: generate and publish to the dashboard repository."
} else {
    Write-Host "Mode: generate local SVG files only. Add -Publish to enable git push."
}
