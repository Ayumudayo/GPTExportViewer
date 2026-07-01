#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string[]] $Path,

    [Parameter()]
    [string] $OutputPath = "SHA256SUMS.txt"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$files = foreach ($item in $Path) {
    $resolved = Resolve-Path -LiteralPath $item
    foreach ($resolvedPath in $resolved) {
        $file = Get-Item -LiteralPath $resolvedPath.ProviderPath
        if ($file.PSIsContainer) {
            throw "Path is not a file: $($file.FullName)"
        }
        $file
    }
}

$lines = foreach ($file in $files) {
    $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    "{0}  {1}" -f $hash, $file.Name
}

if ([System.IO.Path]::IsPathRooted($OutputPath)) {
    $resolvedOutputPath = $OutputPath
} else {
    $resolvedOutputPath = Join-Path -Path (Get-Location) -ChildPath $OutputPath
}

$outputDirectory = Split-Path -Parent $resolvedOutputPath
if ($outputDirectory) {
    New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllLines($resolvedOutputPath, [string[]] $lines, $utf8NoBom)

Write-Output "Wrote $resolvedOutputPath"
