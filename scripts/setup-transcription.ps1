[CmdletBinding()]
param()

# Download/install only into this repository's ignored .local directory.
# Does not enable transcription, modify .env, install global tools or start services.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$localRoot = Join-Path $repoRoot '.local'
$runtimeRoot = Join-Path $localRoot 'speech-runtime'
$zipName = 'whisper-bin-x64.zip'
$zipHash = '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb'
$modelHash = '921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f'

function Assert-ScopedPath([string]$Path) {
    $absolute = [IO.Path]::GetFullPath($Path)
    $prefix = $localRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $absolute.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Installation path escaped the repository .local directory.'
    }
    return $absolute
}

foreach ($directory in @($localRoot, $runtimeRoot)) {
    if (Test-Path -LiteralPath $directory) {
        $existing = Get-Item -LiteralPath $directory -Force
        # OneDrive placeholders carry ReparsePoint too, but do not redirect
        # paths. PowerShell's LinkType identifies junctions/symbolic links.
        if (-not $existing.PSIsContainer -or $existing.LinkType) {
            throw 'The local runtime directory must be a normal directory, not a link.'
        }
    } else {
        New-Item -ItemType Directory -Path $directory | Out-Null
    }
}

function Get-VerifiedFile([string]$Url, [string]$Destination, [string]$Hash, [long]$Size) {
    $destinationPath = Assert-ScopedPath $Destination
    if (Test-Path -LiteralPath $destinationPath) {
        $existing = Get-Item -LiteralPath $destinationPath -Force
        if ($existing.LinkType -or $existing.PSIsContainer -or
            $existing.Length -ne $Size -or (Get-FileHash -LiteralPath $destinationPath -Algorithm SHA256).Hash -ne $Hash) {
            throw 'An existing local download differs from the pinned release; it has been preserved.'
        }
        return
    }
    $temporaryPath = Assert-ScopedPath ($destinationPath + '.partial-' + [Guid]::NewGuid().ToString('N'))
    try {
        Invoke-WebRequest -Uri $Url -OutFile $temporaryPath -TimeoutSec 180 -UseBasicParsing
        if ((Get-Item -LiteralPath $temporaryPath).Length -ne $Size -or
            (Get-FileHash -LiteralPath $temporaryPath -Algorithm SHA256).Hash -ne $Hash) {
            throw 'Downloaded speech file failed the pinned size/checksum check.'
        }
        Move-Item -LiteralPath $temporaryPath -Destination $destinationPath
    } finally {
        if (Test-Path -LiteralPath $temporaryPath) {
            Remove-Item -LiteralPath (Assert-ScopedPath $temporaryPath) -Force
        }
    }
}

$archivePath = Join-Path $runtimeRoot $zipName
Get-VerifiedFile 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip' `
    $archivePath $zipHash 8928640
Get-VerifiedFile 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin' `
    (Join-Path $runtimeRoot 'ggml-tiny.en.bin') $modelHash 77704715

$installPath = Assert-ScopedPath (Join-Path $runtimeRoot 'whisper-b5454')
if (Test-Path -LiteralPath $installPath) {
    $existing = Get-Item -LiteralPath $installPath -Force
    if (-not $existing.PSIsContainer -or $existing.LinkType) {
        throw 'The installed runtime must be a normal directory.'
    }
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
try {
    [long]$expandedSize = 0
    $entries = @($archive.Entries)
    if ($entries.Count -gt 1000) { throw 'Unexpected archive entry count.' }
    foreach ($entry in $entries) {
        $expandedSize += $entry.Length
        $entryPath = $entry.FullName.Replace('/', [IO.Path]::DirectorySeparatorChar)
        if ([IO.Path]::IsPathRooted($entryPath) -or $entryPath.Contains(':') -or
            $expandedSize -gt 134217728) { throw 'Unexpected archive layout or size.' }
        $destination = Assert-ScopedPath (Join-Path $installPath $entryPath)
        $installPrefix = $installPath + [IO.Path]::DirectorySeparatorChar
        if (-not $destination.StartsWith($installPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Archive member escaped the installation directory.'
        }
        # Validate every existing parent to avoid following a local junction.
        $parent = Split-Path -Parent $destination
        while ($parent.Length -ge $installPath.Length) {
            if ((Test-Path -LiteralPath $parent) -and
                (Get-Item -LiteralPath $parent -Force).LinkType) {
                throw 'Archive destination contains a linked directory.'
            }
            $parent = Split-Path -Parent $parent
        }
        if ($entry.FullName.EndsWith('/')) { continue }
        if (Test-Path -LiteralPath $destination) {
            $existing = Get-Item -LiteralPath $destination -Force
            if ($existing.PSIsContainer -or $existing.LinkType) {
                throw 'Existing runtime file is not an ordinary file.'
            }
            $stream = $entry.Open()
            $hasher = [Security.Cryptography.SHA256]::Create()
            try {
                $expected = [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '')
            } finally { $stream.Dispose(); $hasher.Dispose() }
            if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne $expected) {
                throw 'An existing runtime file differs from the verified archive; it has been preserved.'
            }
        }
    }
    # Full layout and existing-file validation completed before extraction.
    foreach ($entry in $entries) {
        if ($entry.FullName.EndsWith('/')) { continue }
        $destination = Assert-ScopedPath (Join-Path $installPath $entry.FullName.Replace('/', [IO.Path]::DirectorySeparatorChar))
        if (-not (Test-Path -LiteralPath $destination)) {
            New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination, $false)
        }
    }
} finally { $archive.Dispose() }

$executable = Assert-ScopedPath (Join-Path $installPath 'Release/whisper-cli.exe')
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw 'Verified archive lacks whisper-cli.exe.' }
Write-Host 'Verified local CPU speech runtime installed. No service was enabled or restarted.'
Write-Host "Executable: $executable"
Write-Host "Model: $(Join-Path $runtimeRoot 'ggml-tiny.en.bin')"
Write-Host 'Next: configure explicit local TRANSCRIPTION_* settings; see deploy/local-speech/README.md.'
