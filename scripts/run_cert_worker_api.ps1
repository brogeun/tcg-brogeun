param([switch]$ConfigureToken,[switch]$Check,[switch]$Verify,[string]$PythonPath='python')
$ErrorActionPreference='Stop'
if (@($ConfigureToken,$Check,$Verify|Where-Object {$_}).Count -gt 1) {throw 'Choose one operation.'}
$taskRepository=Split-Path $PSScriptRoot -Parent
$taskPreviousMode=$env:PSA_LOOKUP_MODE
$taskPreviousState=$env:CERT_WORKER_STATE_DIR
$taskPreviousToken=$env:PSA_API_TOKEN
$taskState=if ($env:CERT_WORKER_STATE_DIR) {$env:CERT_WORKER_STATE_DIR} else {Join-Path $env:LOCALAPPDATA 'TCGHub\CertWorker'}
$taskTokenFile=Join-Path $taskState 'psa-api-token.dpapi'
try {
 $env:CERT_WORKER_STATE_DIR=$taskState
 $env:PSA_LOOKUP_MODE='api'
 if ($ConfigureToken) {
  $taskSecure=Read-Host 'PSA Access Token (hidden input)' -AsSecureString
  $taskPointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($taskSecure)
  try {$taskPlain=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskPointer)} finally {[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskPointer);$taskSecure.Dispose()}
  $taskPlain=($taskPlain.Trim() -replace '(?i)^Bearer\s+','') -replace '\s',''
  if ($taskPlain.Length -lt 32 -or $taskPlain.Length -gt 3072 -or $taskPlain -notmatch '^[A-Za-z0-9._~+/=-]+$') {throw 'Token format is invalid; no file changed.'}
  $taskSecure=ConvertTo-SecureString $taskPlain -AsPlainText -Force
  try {$taskEncrypted=ConvertFrom-SecureString $taskSecure} finally {$taskSecure.Dispose()}
  [IO.Directory]::CreateDirectory($taskState)|Out-Null
  $taskTemporary=Join-Path $taskState ('psa-token-'+[guid]::NewGuid().ToString('N')+'.tmp')
  try {
   [IO.File]::WriteAllText($taskTemporary,$taskEncrypted,[Text.Encoding]::ASCII)
   $taskRecovered=Get-Content -LiteralPath $taskTemporary -Raw|ConvertTo-SecureString
   $taskPointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($taskRecovered)
   try {if ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskPointer) -cne $taskPlain) {throw 'Token storage verification failed.'}} finally {[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskPointer);$taskRecovered.Dispose()}
   if (Test-Path -LiteralPath $taskTokenFile) {Copy-Item -LiteralPath $taskTokenFile -Destination (Join-Path $taskState ('psa-api-token.backup-'+[guid]::NewGuid().ToString('N')+'.dpapi'))}
   Move-Item -LiteralPath $taskTemporary -Destination $taskTokenFile -Force
   Write-Output 'Token encrypted and saved. Actual PSA lookup has not been verified.'
  } finally {if (Test-Path -LiteralPath $taskTemporary) {Remove-Item -LiteralPath $taskTemporary -Force}}
  $taskPlain=$null;$taskEncrypted=$null
  return
 }
 if (-not $env:PSA_API_TOKEN) {
  if (-not (Test-Path -LiteralPath $taskTokenFile)) {throw 'Configure the API token first.'}
  $taskSecure=Get-Content -LiteralPath $taskTokenFile -Raw|ConvertTo-SecureString
  $taskPointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($taskSecure)
  try {$env:PSA_API_TOKEN=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskPointer)} finally {[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskPointer);$taskSecure.Dispose()}
 }
 if ($Verify) {& $PythonPath -B (Join-Path $PSScriptRoot 'verify_psa_api.py')}
 elseif ($Check) {& $PythonPath -B (Join-Path $PSScriptRoot 'psa_worker.py') --check}
 else {& $PythonPath -B (Join-Path $PSScriptRoot 'psa_worker.py')}
 $taskResult=$LASTEXITCODE
} finally {
 $env:PSA_API_TOKEN=$taskPreviousToken
 $env:PSA_LOOKUP_MODE=$taskPreviousMode
 $env:CERT_WORKER_STATE_DIR=$taskPreviousState
}
if (-not $ConfigureToken) {exit $taskResult}
