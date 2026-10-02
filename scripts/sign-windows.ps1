[CmdletBinding()]
param([Parameter(Mandatory)][string]$LiteralPath)

$ErrorActionPreference = 'Stop'
$signingDirectory = $env:GRASBERG_OFFICE_SIGNING_DIR
if (-not $signingDirectory) {
    throw 'Set GRASBERG_OFFICE_SIGNING_DIR to Grasberg Office''s signing directory.'
}

# Bind Confirm inside PowerShell: Windows PowerShell 5.1 cannot receive a false
# SwitchParameter through powershell.exe -File. Packaging explicitly opts in.
& (Join-Path $signingDirectory 'Invoke-GrasbergSigning.ps1') `
    -LiteralPath $LiteralPath -Execute -Confirm:$false -Brief
