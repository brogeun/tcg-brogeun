#Requires -Version 5.1
<#
Install the current user's KREAM collector from one reviewed immutable commit.
The dedicated Edge profile remains in LOCALAPPDATA; only validated price JSON
is published by the Python runner. Windows may require administrator approval
to register the Limited task; collection always runs as the signed-in user.
#>
[CmdletBinding(DefaultParameterSetName = 'Install')]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'Install')]
    [Parameter(Mandatory = $true, ParameterSetName = 'ScheduleOnly')]
    [ValidatePattern('\A[0-9a-fA-F]{40}\z')]
    [string]$SourceRef,
    [Parameter(Mandatory = $true, ParameterSetName = 'ScheduleOnly')]
    [switch]$ScheduleOnly,
    [Parameter(Mandatory = $true, ParameterSetName = 'ScheduleOnly')]
    [ValidatePattern('\AS-1-[0-9]+(?:-[0-9]+)+\z')]
    [string]$OwnerSid
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
        [string[]]$PythonArguments = @(),
        [datetime]$Now = (Get-Date)
    )
    $taskArguments = (@($PythonArguments) + @(
        (Quote-KreamTaskArgument $Runner), '--run', '--scheduled',
        '--state-root', (Quote-KreamTaskArgument $StateRoot),
        '--gh-path', (Quote-KreamTaskArgument $GhPath)
    )) -join ' '
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

function Register-KreamLocalSchedule {
    param([hashtable]$Install, $Definition, [string]$InstallPath)
    $status = 'registered'
    try {
        Register-ScheduledTask -TaskName $Definition.TaskName -InputObject $Definition.Task -Force -ErrorAction Stop | Out-Null
    } catch {
        $status = 'registration_failed'
        Write-Warning 'Windows did not register the daily task. The saved KREAM login remains available; collection can run independently.'
    }
    $Install.scheduleStatus = $status
    [IO.File]::WriteAllText($InstallPath, ($Install | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
    return $status
}

function Invoke-KreamFirstCollection {
    param([hashtable]$Install, $Definition, [string]$InstallPath, [string]$StateRoot)
    $status = Register-KreamLocalSchedule -Install $Install -Definition $Definition -InstallPath $InstallPath
    Write-Host ('Schedule status: ' + $status)
    Write-Host ('Log: ' + $Install.log)
    Write-Host 'Starting the first full collection now. This can take about ten minutes.'
    & $Install.python $Install.runner --run --state-root $StateRoot --gh-path $Install.gh | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw ('Local collection did not complete. Saved login retained. Log: ' + $Install.log)
    }
    return $status
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

# Repair scheduling without executing Python, gh, browser, login or downloads.
# Refuse alternate administrator credentials so registration targets the owner.
if ($ScheduleOnly) {
    $kreamIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if ($kreamIdentity.User.Value -ne $OwnerSid) {
        throw 'Schedule repair must run under the same Windows account as the KREAM owner.'
    }
    foreach ($kreamFile in $kreamFiles) {
        if (-not (Test-Path -LiteralPath (Join-Path (Join-Path $kreamRelease 'scripts') $kreamFile) -PathType Leaf)) {
            throw 'The specified installed KREAM release is missing. Schedule repair did not change anything.'
        }
    }
    $kreamSchedulePython = Get-Command py -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $kreamSchedulePythonArguments = @('-3.11')
    if (-not $kreamSchedulePython) {
        $kreamSchedulePython = Get-Command python -CommandType Application -ErrorAction Stop | Select-Object -First 1
        $kreamSchedulePythonArguments = @()
    }
    $kreamScheduleGh = Get-Command gh -CommandType Application -ErrorAction Stop | Select-Object -First 1
    $kreamScheduleRunner = Join-Path (Join-Path $kreamRelease 'scripts') 'run_kream_local.py'
    $kreamDefinition = New-KreamLocalTaskDefinition -Python $kreamSchedulePython.Source -PythonArguments $kreamSchedulePythonArguments -Runner $kreamScheduleRunner -StateRoot $kreamRoot -GhPath $kreamScheduleGh.Source -UserSid $OwnerSid
    $kreamInstall = @{
        schemaVersion = 1; sourceRef = $SourceRef; taskName = $kreamDefinition.TaskName
        python = $kreamSchedulePython.Source; pythonArguments = $kreamSchedulePythonArguments
        gh = $kreamScheduleGh.Source; runner = $kreamScheduleRunner; ownerSid = $OwnerSid
        log = (Join-Path $kreamRoot 'logs\latest.log')
        schedule = '09:00 local time and current-user logon'
    }
    $kreamScheduleStatus = Register-KreamLocalSchedule -Install $kreamInstall -Definition $kreamDefinition -InstallPath (Join-Path $kreamRoot 'install.json')
    if ($kreamScheduleStatus -ne 'registered') {
        throw 'Task registration is still unavailable. Windows task permissions must be checked; collection remains available in the normal user window.'
    }
    Write-Host ('Task registered: ' + $kreamDefinition.TaskName)
    Write-Host 'Daily 09:00 local time and owner logon. Task runs with Limited privileges.'
    return
}

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

$kreamInstall = @{
    schemaVersion = 1
    sourceRef = $SourceRef
    taskName = $kreamTaskName
    python = $script:KreamPython
    gh = $kreamGh
    runner = $kreamRunner
    ownerSid = $kreamIdentity.User.Value
    log = $kreamLog
    schedule = '09:00 local time and current-user logon'
}
$kreamScheduleStatus = Invoke-KreamFirstCollection -Install $kreamInstall -Definition $kreamDefinition -InstallPath (Join-Path $kreamRoot 'install.json') -StateRoot $kreamRoot
Write-Host 'The first local run finished. Check its publication result before treating website prices as updated.'
if ($kreamScheduleStatus -ne 'registered') {
    Write-Warning 'Collection finished, but the daily schedule is NOT installed. Use -ScheduleOnly to repair registration without signing in again.'
    exit 3
}
Write-Host ('Task installed: ' + $kreamTaskName)
Write-Host 'Schedule: daily 09:00 local time and owner logon. The PC must be on and the owner signed in.'
