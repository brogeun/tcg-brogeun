#Requires -Version 5.1
<#
Windows-only contract checks. Parse the installer, load its two pure helpers,
construct (but never register) a Task Scheduler definition, and round-trip
arguments through a real Python process. No browser, login or task is started.
#>
[CmdletBinding()]
param(
    [string]$InstallerPath = (Join-Path $PSScriptRoot 'install_kream_local.ps1')
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

function Assert-KreamCheck {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

$kreamTokens = $null
$kreamParseErrors = $null
$kreamAst = [Management.Automation.Language.Parser]::ParseFile($InstallerPath, [ref]$kreamTokens, [ref]$kreamParseErrors)
Assert-KreamCheck ($kreamParseErrors.Count -eq 0) 'The installer has PowerShell syntax errors.'

foreach ($kreamHelperName in @('Quote-KreamTaskArgument', 'New-KreamLocalTaskDefinition')) {
    $kreamFunctions = @($kreamAst.FindAll({
        param($Node)
        $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq $kreamHelperName
    }, $true))
    Assert-KreamCheck ($kreamFunctions.Count -eq 1) "Missing pure helper: $kreamHelperName"
    . ([ScriptBlock]::Create($kreamFunctions[0].Extent.Text))
}

# Verify a branch name cannot reach the installer body or any network action.
$kreamValidateErrors = @()
try {
    & $InstallerPath -SourceRef 'main'
    throw 'An unpinned source ref was accepted.'
} catch [Management.Automation.ParameterBindingValidationException] {
    $kreamValidateErrors += $_
}
Assert-KreamCheck ($kreamValidateErrors.Count -eq 1) 'Unpinned source validation did not stop installation.'

$kreamPythonCommand = Get-Command python -CommandType Application -ErrorAction Stop | Select-Object -First 1
$kreamPython = $kreamPythonCommand.Source
$kreamExpected = @(
    'C:\Temp\owner name\run.py',
    'C:\Temp\special & dollar$() and tick`\state',
    ('C:\Temp\' + [char]0xd55c + [char]0xae00 + '\gh.exe')
)
$kreamQuoted = @($kreamExpected | ForEach-Object { Quote-KreamTaskArgument $_ }) -join ' '
$kreamProcessInfo = New-Object Diagnostics.ProcessStartInfo
$kreamProcessInfo.FileName = $kreamPython
$kreamProcessInfo.UseShellExecute = $false
$kreamProcessInfo.RedirectStandardOutput = $true
$kreamProcessInfo.RedirectStandardError = $true
$kreamProcessInfo.CreateNoWindow = $true
$kreamProcessInfo.Arguments = '-c "import json,sys;print(json.dumps(sys.argv[1:]))" ' + $kreamQuoted
$kreamProbeProcess = [Diagnostics.Process]::Start($kreamProcessInfo)
if (-not $kreamProbeProcess.WaitForExit(10000)) {
    $kreamProbeProcess.Kill()
    throw 'The Python argument probe timed out.'
}
$kreamProbeOutput = $kreamProbeProcess.StandardOutput.ReadToEnd()
Assert-KreamCheck ($kreamProbeProcess.ExitCode -eq 0) 'The Python argument probe failed.'
$kreamActual = @($kreamProbeOutput | ConvertFrom-Json)
Assert-KreamCheck ($kreamActual.Count -eq $kreamExpected.Count) 'Task arguments changed count.'
for ($kreamIndex = 0; $kreamIndex -lt $kreamExpected.Count; $kreamIndex++) {
    Assert-KreamCheck ($kreamActual[$kreamIndex] -ceq $kreamExpected[$kreamIndex]) 'Task argument quoting changed a path.'
}

foreach ($kreamInvalid in @('C:\bad"name\file.py', "C:\bad`nname\file.py", 'C:\trailing\')) {
    $kreamRejected = $false
    try { Quote-KreamTaskArgument $kreamInvalid | Out-Null } catch { $kreamRejected = $true }
    Assert-KreamCheck $kreamRejected 'An unsupported task argument was accepted.'
}

# These cmdlets construct local CIM objects only. Register-ScheduledTask is not called.
$kreamSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$kreamFixture = New-KreamLocalTaskDefinition -Python $kreamPython -Runner 'C:\Temp\code release\scripts\run.py' -StateRoot 'C:\Temp\local data' -GhPath 'C:\Program Files\GitHub CLI\gh.exe' -UserSid $kreamSid -Now ([datetime]'2026-11-03T20:00:00')
Assert-KreamCheck ($kreamFixture.TaskName -eq ('TCGHUB-KREAM-Local-' + $kreamSid)) 'Task name is not scoped to this user.'
Assert-KreamCheck ($kreamFixture.NextDaily -eq [datetime]'2026-11-04T09:00:00') 'The first daily trigger is not the next future 09:00.'
Assert-KreamCheck (([string]$kreamFixture.Task.Principal.LogonType) -in @('Interactive', '3')) 'The task can run outside the interactive user session.'
Assert-KreamCheck (([string]$kreamFixture.Task.Principal.RunLevel) -in @('Limited', '0')) 'The task requests elevation.'
Assert-KreamCheck $kreamFixture.Task.Settings.StartWhenAvailable 'Missed task starts are not preserved.'
Assert-KreamCheck (([string]$kreamFixture.Task.Settings.MultipleInstances) -in @('IgnoreNew', '2')) 'Overlapping scheduled executions are allowed.'
Assert-KreamCheck (@($kreamFixture.Task.Triggers).Count -eq 2) 'Daily and logon triggers were not both configured.'
Assert-KreamCheck ($kreamFixture.Task.Actions.Execute -eq $kreamPython) 'Task execution depends on a relative Python path.'
Assert-KreamCheck ($kreamFixture.Task.Actions.Arguments.Contains('--gh-path "C:\Program Files\GitHub CLI\gh.exe"')) 'Task does not retain an absolute GitHub CLI path.'
Assert-KreamCheck (-not $kreamFixture.Task.Actions.Arguments.Contains('powershell')) 'Task execution unexpectedly uses a shell.'

$kreamMorning = New-KreamLocalTaskDefinition -Python $kreamPython -Runner 'C:\Temp\run.py' -StateRoot 'C:\Temp\data' -GhPath 'C:\Temp\gh.exe' -UserSid $kreamSid -Now ([datetime]'2026-11-03T08:00:00')
Assert-KreamCheck ($kreamMorning.NextDaily -eq [datetime]'2026-11-03T09:00:00') 'A future morning trigger was skipped.'
Write-Host 'KREAM installer contract checks passed; no task was registered.'
