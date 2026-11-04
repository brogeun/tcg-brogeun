#Requires -Version 5.1
<#
Windows-only contract checks. Parse the installer, load its helpers, construct
a Task Scheduler definition, and round-trip arguments through real Python.
Registration failure checks use a mocked cmdlet. No browser, login or task starts.
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

foreach ($kreamHelperName in @('Quote-KreamTaskArgument', 'New-KreamLocalTaskDefinition', 'Register-KreamLocalSchedule', 'Invoke-KreamFirstCollection')) {
    $kreamFunctions = @($kreamAst.FindAll({
        param($Node)
        $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq $kreamHelperName
    }, $true))
    Assert-KreamCheck ($kreamFunctions.Count -eq 1) "Missing installer helper: $kreamHelperName"
    . ([ScriptBlock]::Create($kreamFunctions[0].Extent.Text))
}

# Verify a branch name cannot reach the installer body or any network action.
$kreamValidateErrors = @()
foreach ($kreamInvalidRef in @('main', ('a' * 39), (('a' * 40) + "`n"))) {
    try {
        & $InstallerPath -SourceRef $kreamInvalidRef
        throw 'An unpinned source ref was accepted.'
    } catch {
        # PowerShell 5.1 does not expose the internal validation exception type
        # for typed catch clauses. Its public error identifier is stable.
        if ($_.FullyQualifiedErrorId -notlike 'ParameterArgumentValidationError*') {
            throw
        }
        $kreamValidateErrors += $_
    }
}
Assert-KreamCheck ($kreamValidateErrors.Count -eq 3) 'Unpinned source validation did not stop installation.'

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
$kreamProcessInfo.Arguments = '-c "import json,sys;print(json.dumps(dict(arguments=sys.argv[1:])))" ' + $kreamQuoted
$kreamProbeProcess = [Diagnostics.Process]::Start($kreamProcessInfo)
if (-not $kreamProbeProcess.WaitForExit(10000)) {
    $kreamProbeProcess.Kill()
    throw 'The Python argument probe timed out.'
}
$kreamProbeOutput = $kreamProbeProcess.StandardOutput.ReadToEnd()
Assert-KreamCheck ($kreamProbeProcess.ExitCode -eq 0) 'The Python argument probe failed.'
# ConvertFrom-Json enumerates a top-level JSON array differently in Windows
# PowerShell 5.1 and PowerShell 7. Keep the array inside one JSON object instead
# of wrapping the pipeline output and accidentally creating a nested array.
$kreamProbeResult = ConvertFrom-Json -InputObject $kreamProbeOutput
$kreamActual = $kreamProbeResult.arguments
Write-Host ('Synthetic task argument probe: count={0}; data={1}' -f $kreamActual.Count, $kreamProbeOutput.Trim())
Assert-KreamCheck ($kreamActual.Count -eq $kreamExpected.Count) ('Task arguments changed count: expected={0}; actual={1}.' -f $kreamExpected.Count, $kreamActual.Count)
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

$kreamLauncherFixture = New-KreamLocalTaskDefinition -Python 'C:\Windows\py.exe' -PythonArguments @('-3.11') -Runner 'C:\Temp\run.py' -StateRoot 'C:\Temp\data' -GhPath 'C:\Temp\gh.exe' -UserSid $kreamSid
Assert-KreamCheck ($kreamLauncherFixture.Task.Actions.Arguments.StartsWith('-3.11 "C:\Temp\run.py" ')) 'Schedule repair lost the Python version argument.'

# Only the mocked registration function runs. The fake collector creates a
# marker and prints JSON, proving that denial neither stops collection nor
# captures its progress as a schedule status array.
$kreamTestRoot = Join-Path ([IO.Path]::GetTempPath()) ('kream-install-check-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $kreamTestRoot | Out-Null
try {
    # Execute the actual repair branch with isolated paths. Tool discovery is
    # blocked, so a broken guard fails safely before any task can be registered.
    $kreamRepairBranches = @($kreamAst.FindAll({
        param($Node)
        $Node -is [Management.Automation.Language.IfStatementAst] -and
        $Node.Clauses.Count -eq 1 -and
        $Node.Clauses[0].Item1.Extent.Text -eq '$ScheduleOnly'
    }, $true))
    Assert-KreamCheck ($kreamRepairBranches.Count -eq 1) 'Missing schedule-only repair branch.'
    $kreamRepairBranch = [ScriptBlock]::Create($kreamRepairBranches[0].Extent.Text)
    $ScheduleOnly = $true
    $kreamRelease = Join-Path $kreamTestRoot 'release-not-installed'
    $kreamFiles = @('collect_kream_promos.py', 'setup_kream_session.py', 'run_kream_local.py')
    $kreamOtherSid = 'S-1-5-18'
    if ($kreamOtherSid -eq $kreamSid) { $kreamOtherSid = 'S-1-5-19' }
    $kreamGuardCases = @(
        @{ Sid=$kreamOtherSid; Message='Schedule repair must run under the same Windows account as the KREAM owner.' },
        @{ Sid=$kreamSid; Message='The specified installed KREAM release is missing. Schedule repair did not change anything.' }
    )
    function Get-Command { throw 'Schedule repair performed tool discovery before rejecting invalid owner or missing release.' }
    try {
        foreach ($kreamGuardCase in $kreamGuardCases) {
            $OwnerSid = $kreamGuardCase.Sid
            try {
                & $kreamRepairBranch
                throw 'Schedule repair accepted an invalid owner or missing release.'
            } catch {
                Assert-KreamCheck ($_.Exception.Message -eq $kreamGuardCase.Message) ('Schedule repair guard failed: ' + $_.Exception.Message)
            }
        }
    } finally {
        Remove-Item Function:\Get-Command -ErrorAction SilentlyContinue
    }

    $kreamFakeRunner = Join-Path $kreamTestRoot 'fake_runner.py'
    $kreamFakeSource = @'
import pathlib,sys
root=pathlib.Path(sys.argv[sys.argv.index('--state-root')+1])
(root/'collected').write_text('yes')
print('{"code":"publication_requested"}')
'@
    [IO.File]::WriteAllText($kreamFakeRunner, $kreamFakeSource, [Text.UTF8Encoding]::new($false))
    $kreamMetadata = @{python=$kreamPython; runner=$kreamFakeRunner; gh='unused'; log='safe-test-log'}
    $kreamInstallPath = Join-Path $kreamTestRoot 'install.json'
    $kreamFakeDefinition = @{TaskName='NEVER_REGISTER'; Task='mock'}
    function Register-ScheduledTask { throw [UnauthorizedAccessException]::new('Simulated registration denial') }
    $kreamResult = Invoke-KreamFirstCollection -Install $kreamMetadata -Definition $kreamFakeDefinition -InstallPath $kreamInstallPath -StateRoot $kreamTestRoot
    Assert-KreamCheck ($kreamResult -is [string] -and $kreamResult -eq 'registration_failed') 'Registration denial did not return one explicit failed status.'
    Assert-KreamCheck (Test-Path -LiteralPath (Join-Path $kreamTestRoot 'collected')) 'Registration denial stopped the first collection.'
    $kreamSaved = Get-Content -LiteralPath $kreamInstallPath -Raw | ConvertFrom-Json
    Assert-KreamCheck ($kreamSaved.scheduleStatus -eq 'registration_failed') 'Registration failure was not persisted for repair.'
    function Register-ScheduledTask { param($TaskName, $InputObject, [switch]$Force, $ErrorAction); return 'mock success' }
    $kreamResult = Register-KreamLocalSchedule -Install $kreamMetadata -Definition $kreamFakeDefinition -InstallPath $kreamInstallPath
    Assert-KreamCheck ($kreamResult -eq 'registered') 'Successful registration was not reported.'
    $kreamSaved = Get-Content -LiteralPath $kreamInstallPath -Raw | ConvertFrom-Json
    Assert-KreamCheck ($kreamSaved.scheduleStatus -eq 'registered') 'Successful repair was not persisted.'
} finally {
    Remove-Item Function:\Register-ScheduledTask -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $kreamTestRoot -Recurse -Force
}
Write-Host 'KREAM installer contract checks passed; no task was registered.'
