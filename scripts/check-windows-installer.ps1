param(
    [Parameter(Mandatory)]
    [ValidateSet('x64', 'arm64')]
    [string] $Architecture,
    [Parameter(Mandatory)]
    [string] $Installer,
    [string] $IncompatibleInstaller,
    [Parameter(Mandatory)]
    [string] $ReportDir
)

$ErrorActionPreference = 'Stop'

# The published installer uses the real application ID and modifies the current
# user's registry and shortcuts. Run only in a disposable hosted runner.
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'This check requires a disposable GitHub-hosted Windows runner.'
}
if ([string] [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ine $Architecture) {
    throw "Expected a native Windows $Architecture runner."
}

$Installer = (Resolve-Path -LiteralPath $Installer).Path
if ($Architecture -eq 'x64') {
    $IncompatibleInstaller = (Resolve-Path -LiteralPath $IncompatibleInstaller).Path
}
$report = Join-Path (New-Item -ItemType Directory -Path $ReportDir -Force).FullName 'windows-installer-architecture-check.txt'
$tempRoot = (Resolve-Path -LiteralPath $env:RUNNER_TEMP).Path
$scratch = Join-Path $tempRoot "AI Taskboard installer $([Guid]::NewGuid())"
$installDir = Join-Path $scratch 'installed application'
$app = Join-Path $installDir 'AI Taskboard.exe'
$uninstaller = Join-Path $installDir 'Uninstall AI Taskboard.exe'
$appArchive = Join-Path $installDir 'resources/app.asar'
$profile = Join-Path $scratch 'app data'
$publishedVersion = '0.1.3-alpha'
$publishedHashes = @{
    x64 = 'bfcaab95f9ec0e64192fa0861fe25739294cc6daed0981295d3d8d83cc75d7b2'
    arm64 = '543e1f2396bc928d1983fea13f0ef74e597d4dd253126f036a0b0fa083144e23'
}

function Write-Result([string] $Text) {
    Add-Content -LiteralPath $report -Value $Text
    Write-Host $Text
}

function Assert-Check([bool] $Condition, [string] $Message) {
    if (-not $Condition) {
        throw $Message
    }
}

function Get-Digest([string] $Path) {
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-PublishedInstaller([string] $Arch) {
    $name = "ai-taskboard-${publishedVersion}-windows-${Arch}.exe"
    $url = "https://github.com/edwardgushchin/AI-Taskboard/releases/download/v$publishedVersion/$name"
    $path = Join-Path $scratch $name
    Invoke-WebRequest -Uri $url -OutFile $path -MaximumRetryCount 2
    $digest = Get-Digest $path
    Assert-Check ($digest -eq $publishedHashes[$Arch]) "Published installer checksum mismatch ($url)"
    Write-Result "Published installer: $url SHA-256 $digest"
    $path
}

function Invoke-Installer([string] $Path, [string] $Flags = '/S /currentuser') {
    # NSIS requires /D= last, with no quotes even when the path contains spaces.
    $arguments = "$Flags /D=$installDir"
    Write-Result "Command: $([IO.Path]::GetFileName($Path)) $arguments"
    $process = Start-Process -FilePath $Path -ArgumentList $arguments -WindowStyle Hidden -PassThru
    try {
        if (-not $process.WaitForExit(120000)) {
            $process.Kill($true)
            throw 'Installer timed out.'
        }
        Write-Result "Exit code: $($process.ExitCode)"
        $process.ExitCode
    } finally {
        $process.Dispose()
    }
}

function Get-UninstallState {
    foreach ($root in 'HKCU:', 'HKLM:') {
        foreach ($view in 'SOFTWARE', 'SOFTWARE/WOW6432Node') {
            $key = Join-Path $root "$view/Microsoft/Windows/CurrentVersion/Uninstall"
            foreach ($entry in (Get-ChildItem -LiteralPath $key -ErrorAction SilentlyContinue | Sort-Object Name)) {
                if ($entry.GetValue('DisplayName') -like 'AI Taskboard*') {
                    $values = [ordered] @{}
                    foreach ($name in ($entry.GetValueNames() | Sort-Object)) {
                        $values[$name] = [ordered] @{
                            kind = $entry.GetValueKind($name).ToString()
                            value = $entry.GetValue($name, $null, 'DoNotExpandEnvironmentNames')
                        }
                    }
                    [ordered] @{ key = $entry.Name; values = $values }
                }
            }
        }
    }
}

function Get-FileState([string] $Path) {
    if (Test-Path -LiteralPath $Path) {
        [ordered] @{
            path = $Path
            files = @(
                Get-ChildItem -LiteralPath $Path -File -Recurse -Force |
                    Sort-Object FullName |
                    ForEach-Object { "$($_.FullName) $(Get-Digest $_.FullName)" }
            )
        }
    }
}

function Get-Shortcuts {
    foreach ($folder in 'DesktopDirectory', 'StartMenu', 'CommonDesktopDirectory', 'CommonStartMenu') {
        $path = [Environment]::GetFolderPath($folder)
        if ($path -and (Test-Path -LiteralPath $path)) {
            Get-ChildItem -LiteralPath $path -File -Filter '*AI Taskboard*.lnk' -Recurse |
                Sort-Object FullName |
                ForEach-Object { "$($_.FullName) $(Get-Digest $_.FullName)" }
        }
    }
}

function Get-InstallState {
    [ordered] @{
        install = Get-FileState $installDir
        shortcuts = @(Get-Shortcuts)
        uninstall = @(Get-UninstallState)
        profile = Get-FileState $profile
        defaultProfiles = @(
            Get-FileState (Join-Path $env:APPDATA 'AI Taskboard')
            Get-FileState (Join-Path $env:APPDATA 'ai-taskboard')
        )
        path = [Environment]::GetEnvironmentVariable('Path', 'User')
        pathOwner = Get-ItemPropertyValue -LiteralPath 'HKCU:/Software/AI Taskboard' -Name CliPath -ErrorAction SilentlyContinue
    } | ConvertTo-Json -Depth 12 -Compress
}

function Assert-ArchitectureRejection([string] $Scenario) {
    $before = Get-InstallState
    foreach ($flags in '/S /currentuser', '/S /currentuser --updated') {
        $code = Invoke-Installer $IncompatibleInstaller $flags
        Assert-Check ($code -eq 1) "Expected architecture rejection, got exit $code ($Scenario, $flags)."
        Assert-Check ((Get-InstallState) -ceq $before) "Architecture rejection modified installation state ($Scenario, $flags)."
        Write-Result "PASS: $Scenario ($flags), installation files, shortcuts, uninstall registry, profiles, user PATH and ownership unchanged."
    }
}

function Assert-Installed {
    Assert-Check ((Test-Path -LiteralPath $app) -and (Test-Path -LiteralPath $uninstaller)) 'Application or uninstaller missing.'
    Assert-Check (@(Get-UninstallState).Count -eq 1) 'Expected exactly one uninstall registration.'
    Assert-Check (@(Get-Shortcuts).Count -eq 2) 'Expected a desktop and a Start menu shortcut.'
}

function Assert-AppLaunch([string] $Scenario) {
    $portFile = Join-Path $profile 'DevToolsActivePort'
    if (Test-Path -LiteralPath $portFile) {
        Remove-Item -LiteralPath $portFile
    }
    $process = Start-Process -FilePath $app `
        -ArgumentList "--user-data-dir=`"$profile`" --remote-debugging-port=0" -PassThru
    try {
        $deadline = [DateTime]::UtcNow.AddSeconds(45)
        $page = $null
        do {
            Start-Sleep -Milliseconds 250
            if (Test-Path -LiteralPath $portFile) {
                $port = Get-Content -LiteralPath $portFile -TotalCount 1
                if ($port -match '^\d{1,5}$') {
                    try {
                        $pages = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/list" -TimeoutSec 2
                        $page = $pages | Where-Object {
                            $_.type -eq 'page' -and $_.url -like 'file:*/app.asar/*' -and $_.webSocketDebuggerUrl
                        } | Select-Object -First 1
                    } catch [System.Net.Http.HttpRequestException] {
                        # The DevTools port can appear before the HTTP endpoint is ready.
                    } catch [System.Threading.Tasks.TaskCanceledException] {
                        # Retry until the startup deadline if the request times out.
                    }
                }
            }
        } until ($process.HasExited -or $page -or [DateTime]::UtcNow -ge $deadline)
        Assert-Check (-not $process.HasExited -and $null -ne $page) "The installed application did not load its window ($Scenario)."
        Write-Result "PASS: $Scenario loaded the installed application window through DevTools."
    } finally {
        if (-not $process.HasExited) {
            if (-not $process.CloseMainWindow() -or -not $process.WaitForExit(15000)) {
                $process.Kill($true)
                $process.WaitForExit()
            }
        }
        $process.Dispose()
    }
}

function Remove-TestInstall {
    if (Test-Path -LiteralPath $uninstaller) {
        $process = Start-Process -FilePath $uninstaller -ArgumentList '/S /currentuser' -WindowStyle Hidden -PassThru -Wait
        try {
            Assert-Check ($process.ExitCode -eq 0) "Uninstaller returned $($process.ExitCode)."
        } finally {
            $process.Dispose()
        }
    }
    Assert-Check (@(Get-UninstallState).Count -eq 0) 'Uninstall registration remains after cleanup.'
    Assert-Check (@(Get-Shortcuts).Count -eq 0) 'Shortcuts remain after cleanup.'
}

function Remove-TemporaryDirectory([string] $Path, [string] $Parent) {
    if (Test-Path -LiteralPath $Path) {
        $resolved = (Resolve-Path -LiteralPath $Path).Path
        Assert-Check ((Split-Path -Parent $resolved) -eq $Parent) "Unexpected test directory path: $resolved"
        Remove-Item -LiteralPath $resolved -Recurse
    }
}

Assert-Check (@(Get-UninstallState).Count -eq 0 -and @(Get-Shortcuts).Count -eq 0) 'The runner already has an AI Taskboard installation.'
$initialPath = [string] [Environment]::GetEnvironmentVariable('Path', 'User')
New-Item -ItemType Directory -Path $scratch | Out-Null
try {
    Write-Result "Source commit: $(git rev-parse HEAD); Windows $([Environment]::OSVersion.Version); $Architecture; PowerShell $($PSVersionTable.PSVersion)"
    Write-Result "Built installer: $([IO.Path]::GetFileName($Installer)) SHA-256 $(Get-Digest $Installer)"
    if ($Architecture -eq 'x64') {
        Write-Result "Built incompatible installer: $([IO.Path]::GetFileName($IncompatibleInstaller)) SHA-256 $(Get-Digest $IncompatibleInstaller)"
        Assert-ArchitectureRejection 'Clean x64 runner rejected rebuilt ARM64'

        $publishedArm = Get-PublishedInstaller 'arm64'
        $publishedResult = Invoke-Installer $publishedArm
        $installedFiles = @(Get-ChildItem -LiteralPath $installDir -File -Recurse)
        Assert-Check ($installedFiles.Count -eq 1 -and $installedFiles[0].FullName -eq $uninstaller) 'Published ARM64 package did not reproduce the uninstall-only installation on x64.'
        Write-Result "PASS: published ARM64 reproduced the uninstall-only installation on x64 (exit $publishedResult)."
        Remove-TestInstall
        Remove-TemporaryDirectory $installDir $scratch
    }

    Assert-Check ((Invoke-Installer $Installer) -eq 0) 'Compatible installer failed on a clean runner.'
    Assert-Installed
    $builtArchiveHash = Get-Digest $appArchive
    Assert-AppLaunch 'Clean compatible installation'
    Remove-TestInstall

    $published = Get-PublishedInstaller $Architecture
    Assert-Check ((Invoke-Installer $published) -eq 0) 'Published compatible installer failed.'
    Assert-Installed
    Assert-AppLaunch 'Published compatible installation'
    New-Item -ItemType Directory -Path $profile -Force | Out-Null
    $marker = Join-Path $profile 'fixture.txt'
    Set-Content -LiteralPath $marker -Value 'installer profile fixture'
    $markerHash = Get-Digest $marker
    Assert-Check ((Get-Digest $appArchive) -ne $builtArchiveHash) 'Expected distinct published and rebuilt application contents.'
    if ($Architecture -eq 'x64') {
        Assert-ArchitectureRejection 'Existing x64 installation rejected rebuilt ARM64'
    }

    Assert-Check ((Invoke-Installer $Installer '/S /currentuser --updated') -eq 0) 'Compatible update failed.'
    Assert-Installed
    Assert-Check ((Get-Digest $appArchive) -eq $builtArchiveHash) 'The update did not install the rebuilt application.'
    Assert-Check ((Get-Digest $marker) -eq $markerHash) 'The update modified the profile fixture.'
    Assert-AppLaunch 'Compatible update'
    Write-Result 'PASS: compatible update installed the rebuilt app.asar, preserved the profile fixture and retained the uninstaller.'
} catch {
    Write-Result "FAIL: $_"
    throw
} finally {
    try {
        Remove-TestInstall
        Assert-Check ([string] [Environment]::GetEnvironmentVariable('Path', 'User') -ceq $initialPath) 'User PATH differs after cleanup.'
        Write-Result 'PASS: uninstall registration, shortcuts and user PATH match the pre-test state.'
    } finally {
        Remove-TemporaryDirectory $scratch $tempRoot
        Assert-Check (-not (Test-Path -LiteralPath $scratch)) 'Temporary installer test directory remains.'
        Write-Result 'PASS: removed test installers, application and profile from the runner temporary directory.'
    }
}
