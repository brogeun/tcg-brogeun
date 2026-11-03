#Requires -Version 5.1
<#
Install the current user's KREAM collector from one reviewed immutable commit.
The dedicated Edge profile remains in LOCALAPPDATA; only validated price JSON
is published by the Python runner. No Windows password or administrator role
is requested, and this machine is not registered as a GitHub Actions runner.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('\A[0-9a-fA-F]{40}\z')]
    [string]$SourceRef
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

function Invoke-KreamPython {
    param([string[]]$PythonArguments)
    & $script:KreamPython @PythonArguments
    if ($LASTEXITCODE -ne 0) {
        throw "Python preparation failed (exit $LASTEXITCODE)."
    }
}

function Quote-KreamTaskArgument {
    param([Parameter(Mandatory = $true)][string]$Value)
    # Paths used here are files or a fixed directory without a trailing slash.
    # Task Scheduler invokes Python directly; no shell interprets these values.
    if ($Value.IndexOfAny([char[]]@([char]0, [char]10, [char]13, [char]34)) -ge 0 -or $Value.EndsWith('\')) {
        throw 'A scheduled-task path contains unsupported characters.'
    }
    return '"' + $Value + '"'
}

function New-KreamLocalTaskDefinition {
    param(
        [string]$Python,
        [string]$Runner,
        [string]$StateRoot,
        [string]$GhPath,
        [string]$UserSid,
        [datetime]$Now = (Get-Date)
    )
    $taskArguments = @(
        (Quote-KreamTaskArgument $Runner), '--run', '--scheduled',
        '--state-root', (Quote-KreamTaskArgument $StateRoot),
        '--gh-path', (Quote-KreamTaskArgument $GhPath)
    ) -join ' '
    $action = New-ScheduledTaskAction -Execute $Python -Argument $taskArguments -WorkingDirectory (Split-Path -Parent $Runner)
    $principal = New-ScheduledTaskPrincipal -UserId $UserSid -LogonType Interactive -RunLevel Limited
    # A future boundary avoids an overdue daily trigger racing the first run.
    $nextDaily = $Now.Date.AddHours(9)
    if ($nextDaily -le $Now) {
        $nextDaily = $nextDaily.AddDays(1)
    }
    $daily = New-ScheduledTaskTrigger -Daily -At $nextDaily
    $logon = New-ScheduledTaskTrigger -AtLogOn -User $UserSid
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RunOnlyIfNetworkAvailable
    $task = New-ScheduledTask -Action $action -Trigger @($daily, $logon) -Principal $principal -Settings $settings -Description 'Collect KREAM Korean promos daily at 09:00 local time and after this user logs on; publish validated price data only.'
    return @{
        TaskName = 'TCGHUB-KREAM-Local-' + $UserSid
        Task = $task
        NextDaily = $nextDaily
    }
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'This installer requires Windows.'
}
if (-not $env:LOCALAPPDATA) {
    throw 'LOCALAPPDATA is unavailable for the current user.'
}
$SourceRef = $SourceRef.ToLowerInvariant()
$kreamRoot = Join-Path $env:LOCALAPPDATA 'TCGHUB\kream-local'
$kreamRoot = [IO.Path]::GetFullPath($kreamRoot).TrimEnd([char[]]@([char]92, [char]47))
$kreamReleases = Join-Path $kreamRoot 'releases'
$kreamRelease = Join-Path $kreamReleases $SourceRef
$kreamFiles = @('collect_kream_promos.py', 'setup_kream_session.py', 'run_kream_local.py')
$kreamRepository = 'brogeun/tcg-brogeun'

# Resolve the interpreter once; scheduled tasks do not rely on an interactive PATH.
$kreamLauncher = Get-Command py -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($kreamLauncher) {
    $kreamPythonResult = & $kreamLauncher.Source -3.11 -c 'import sys; print(sys.executable)'
} else {
    $kreamPythonCommand = Get-Command python -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $kreamPythonCommand) {
        throw 'Python 3.11 is required. Install Python from python.org, then retry.'
    }
    $kreamPythonResult = & $kreamPythonCommand.Source -c 'import sys; print(sys.executable)'
}
if ($LASTEXITCODE -ne 0 -or -not $kreamPythonResult) {
    throw 'Python could not be started.'
}
$script:KreamPython = ([string]($kreamPythonResult | Select-Object -Last 1)).Trim()
if (-not [IO.Path]::IsPathRooted($script:KreamPython) -or -not (Test-Path -LiteralPath $script:KreamPython -PathType Leaf)) {
    throw 'The resolved Python executable is unavailable.'
}

$kreamGhCommand = Get-Command gh -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $kreamGhCommand) {
    throw 'GitHub CLI is required. Install it from https://cli.github.com/ and run gh auth login.'
}
$kreamGh = [IO.Path]::GetFullPath($kreamGhCommand.Source)
& $kreamGh auth status --hostname github.com
if ($LASTEXITCODE -ne 0) {
    throw 'Sign in to the brogeun GitHub account with gh auth login, then retry.'
}

# These were already installed by the connection tool on the owner's PC.
# Avoid reinstalling or downloading Chromium when the supported packages exist.
$kreamDependencyProbe = @'
import importlib.metadata
import sys
try:
    import tzdata
    ready = importlib.metadata.version('playwright') == '1.56.0'
except Exception:
    ready = False
sys.exit(0 if ready else 1)
'@
& $script:KreamPython -c $kreamDependencyProbe
if ($LASTEXITCODE -ne 0) {
    Invoke-KreamPython -PythonArguments @('-m', 'pip', 'install', '--user', 'playwright==1.56.0', 'tzdata')
}
Invoke-KreamPython -PythonArguments @('-c', 'import playwright.sync_api, tzdata')

New-Item -ItemType Directory -Path $kreamReleases -Force | Out-Null
$kreamStaging = Join-Path $kreamReleases ('.download-' + [Guid]::NewGuid().ToString('N'))
$kreamStagingScripts = Join-Path $kreamStaging 'scripts'
New-Item -ItemType Directory -Path $kreamStagingScripts -Force | Out-Null
try {
    foreach ($kreamFile in $kreamFiles) {
        $kreamUri = "https://raw.githubusercontent.com/$kreamRepository/$SourceRef/scripts/$kreamFile"
        Invoke-WebRequest -UseBasicParsing -Uri $kreamUri -OutFile (Join-Path $kreamStagingScripts $kreamFile)
    }
    $kreamCompileFiles = @($kreamFiles | ForEach-Object { Join-Path $kreamStagingScripts $_ })
    Invoke-KreamPython -PythonArguments (@('-m', 'py_compile') + $kreamCompileFiles)
    # Validate imports in the exact standalone layout before saving a release
    # or asking the owner to sign in. --help never opens a browser or a profile.
    Invoke-KreamPython -PythonArguments @((Join-Path $kreamStagingScripts 'run_kream_local.py'), '--help') | Out-Null

    if (Test-Path -LiteralPath $kreamRelease) {
        foreach ($kreamFile in $kreamFiles) {
            $kreamExisting = Join-Path (Join-Path $kreamRelease 'scripts') $kreamFile
            $kreamDownloaded = Join-Path $kreamStagingScripts $kreamFile
            if (-not (Test-Path -LiteralPath $kreamExisting -PathType Leaf) -or
                (Get-FileHash -LiteralPath $kreamExisting -Algorithm SHA256).Hash -ne
                (Get-FileHash -LiteralPath $kreamDownloaded -Algorithm SHA256).Hash) {
                throw 'The installed release differs from this immutable commit; it was not overwritten.'
            }
        }
    } else {
        [IO.Directory]::Move($kreamStaging, $kreamRelease)
    }
} finally {
    if (Test-Path -LiteralPath $kreamStaging) {
        # This unique staging directory contains downloaded code only.
        Remove-Item -LiteralPath $kreamStaging -Recurse -Force
    }
}

$kreamScripts = Join-Path $kreamRelease 'scripts'
$kreamRunner = Join-Path $kreamScripts 'run_kream_local.py'
$kreamLog = Join-Path $kreamRoot 'logs\latest.log'
Write-Host 'Opening the dedicated KREAM Edge profile. Sign in in that window when requested.'
& $script:KreamPython $kreamRunner --setup --state-root $kreamRoot --gh-path $kreamGh
if ($LASTEXITCODE -ne 0) {
    throw "KREAM setup did not finish (exit $LASTEXITCODE). Existing scheduled tasks were not changed. Log: $kreamLog"
}

$kreamIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$kreamDefinition = New-KreamLocalTaskDefinition -Python $script:KreamPython -Runner $kreamRunner -StateRoot $kreamRoot -GhPath $kreamGh -UserSid $kreamIdentity.User.Value
$kreamTaskName = $kreamDefinition.TaskName
Register-ScheduledTask -TaskName $kreamTaskName -InputObject $kreamDefinition.Task -Force | Out-Null

$kreamInstall = @{
    schemaVersion = 1
    sourceRef = $SourceRef
    taskName = $kreamTaskName
    python = $script:KreamPython
    gh = $kreamGh
    runner = $kreamRunner
    log = $kreamLog
    schedule = '09:00 local time and current-user logon'
}
[IO.File]::WriteAllText((Join-Path $kreamRoot 'install.json'), ($kreamInstall | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
Write-Host "Task installed: $kreamTaskName"
Write-Host 'Schedule: daily 09:00 in Windows local time and current-user logon.'
Write-Host 'The PC must be on and this Windows user must remain signed in.'
Write-Host "Log: $kreamLog"
Write-Host 'Starting the first full collection now. This can take about ten minutes.'
& $script:KreamPython $kreamRunner --run --state-root $kreamRoot --gh-path $kreamGh
if ($LASTEXITCODE -ne 0) {
    throw "The task is installed, but the first collection did not complete (exit $LASTEXITCODE). Log: $kreamLog"
}
Write-Host 'The first local run finished. Check its publication result before treating website prices as updated.'
