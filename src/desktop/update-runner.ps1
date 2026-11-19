param([Parameter(Mandatory = $true)][string]$Config)
$ErrorActionPreference = 'Stop'
$updateDirectory = [IO.Path]::GetFullPath((Split-Path -Parent $Config))
$temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
if ([IO.Path]::GetDirectoryName($updateDirectory).TrimEnd('\') -ne $temporaryRoot -or
    [IO.Path]::GetFileName($updateDirectory) -notmatch '^ai-taskboard-update-[a-zA-Z0-9]+$' -or
    ([IO.File]::GetAttributes($updateDirectory) -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'The update cache must be a direct temporary directory created by AI Taskboard.'
}
try {
    $update = Get-Content -LiteralPath $Config -Raw -Encoding UTF8 | ConvertFrom-Json
    $parent = Get-Process -Id $update.parentId -ErrorAction SilentlyContinue
    if ($parent -and -not $parent.WaitForExit(120000)) {
        throw 'The application did not finish normal shutdown; installation cancelled.'
    }
    $stream = [IO.File]::OpenRead($update.installer)
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $actual = [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha256.Dispose()
        $stream.Dispose()
    }
    if ($actual -ne $update.digest) {
        throw 'Installer changed after verification.'
    }
    $processName = [IO.Path]::GetFileNameWithoutExtension($update.executable)
    if (Get-Process -Name $processName -ErrorAction SilentlyContinue) {
        throw 'Another application instance is still running; installation cancelled.'
    }
    # /D= must be last: NSIS consumes the remaining text as the directory, including spaces.
    $installer = Start-Process -FilePath $update.installer -ArgumentList @('/S', '--updated', '/currentuser', "/D=$($update.installDirectory)") -WindowStyle Hidden -PassThru -Wait
    if ($installer.ExitCode -ne 0) {
        throw "NSIS failed with exit code $($installer.ExitCode)."
    }
    $arguments = @($update.args | ForEach-Object {
        '"' + [regex]::Replace([regex]::Replace([string]$_, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
    })
    Start-Process -FilePath $update.executable -ArgumentList $arguments -WorkingDirectory $update.installDirectory -WindowStyle Normal
} catch {
    # Keep only a small error report; never keep downloaded packages after a failure.
    $_.Exception.Message | Set-Content -LiteralPath (Join-Path ([IO.Path]::GetTempPath()) 'ai-taskboard-update-error.txt') -Encoding UTF8
} finally {
    Set-Location -LiteralPath ([IO.Path]::GetTempPath())
    Remove-Item -LiteralPath $updateDirectory -Recurse -ErrorAction SilentlyContinue
}
