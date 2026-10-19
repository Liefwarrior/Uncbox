# Sets up https://unc.box for Uncbox on this PC, or removes it with -Remove.
# Run it through `npm run setup-domain` / `npm run remove-domain`, which ask Windows for the
# admin rights this needs (the hosts file and the machine's trusted certificates).
#
# Setting up:
#   1. Points unc.box at this PC (127.0.0.1) in the hosts file.
#   2. Makes a certificate for unc.box only, and has Windows trust it, so the browser shows a
#      padlock. HTTPS matters: browsers only allow camera and window capture on secure pages.
#   3. Saves the certificate where Uncbox reads it: <data>\tls\unc.box.pfx, with its password in
#      unc.box.json. The private key exists only in that file.
#
# Running it again replaces everything it made before, so it is safe to repeat.

param(
  [Parameter(Mandatory = $true)][string]$DataDir,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$Domain = 'unc.box'
$Marker = '# added by Uncbox'
$HostsFile = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
$TlsDir = Join-Path $DataDir 'tls'
$PfxFile = Join-Path $TlsDir "$Domain.pfx"
$InfoFile = Join-Path $TlsDir "$Domain.json"

function Get-UncboxCerts {
  # Only the self-signed unc.box certificates this script made.
  Get-ChildItem Cert:\LocalMachine\Root, Cert:\LocalMachine\My |
    Where-Object { $_.Subject -eq "CN=$Domain" -and $_.Issuer -eq "CN=$Domain" }
}

function Remove-Setup {
  foreach ($c in @(Get-UncboxCerts)) {
    if ($c.HasPrivateKey) { Remove-Item -Path $c.PSPath -DeleteKey } else { Remove-Item -Path $c.PSPath }
  }
  if (Test-Path $HostsFile) {
    # Only the line this script added; anything else in the hosts file is left alone.
    $kept = @([IO.File]::ReadAllLines($HostsFile) | Where-Object { -not $_.Contains($Marker) })
    [IO.File]::WriteAllLines($HostsFile, [string[]]$kept)
  }
  Remove-Item -Path $PfxFile, $InfoFile -ErrorAction SilentlyContinue
}

function Add-Setup {
  # 1. Hosts file.
  $text = [IO.File]::ReadAllText($HostsFile)
  if ($text.Length -gt 0 -and -not $text.EndsWith("`n")) { $text += "`r`n" }
  $text += "127.0.0.1 $Domain $Marker`r`n"
  [IO.File]::WriteAllText($HostsFile, $text)

  # 2. Certificate: unc.box only, for websites (the default type), never able to sign other
  #    certificates (ca=0), valid five years.
  $cert = New-SelfSignedCertificate -Subject "CN=$Domain" -DnsName $Domain -FriendlyName "Uncbox ($Domain)" `
    -CertStoreLocation Cert:\LocalMachine\My -KeyExportPolicy Exportable -KeyAlgorithm RSA -KeyLength 2048 `
    -HashAlgorithm SHA256 -NotAfter (Get-Date).AddYears(5) `
    -TextExtension @('2.5.29.19={critical}{text}ca=0')

  # 3. Save it for Uncbox with a random password. AES-256 so Node can read it (it rejects the
  #    older RC2 encryption some Windows versions default to).
  New-Item -ItemType Directory -Force -Path $TlsDir | Out-Null
  $bytes = New-Object byte[] 24
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $password = [Convert]::ToBase64String($bytes)
  $secure = ConvertTo-SecureString $password -AsPlainText -Force
  try {
    Export-PfxCertificate -Cert $cert -FilePath $PfxFile -Password $secure -CryptoAlgorithmOption AES256_SHA256 | Out-Null
  } catch [System.Management.Automation.ParameterBindingException] {
    # Windows versions before 10 1709 have no -CryptoAlgorithmOption; their default is TripleDES.
    Export-PfxCertificate -Cert $cert -FilePath $PfxFile -Password $secure | Out-Null
  }
  [IO.File]::WriteAllText($InfoFile, "{`"passphrase`":`"$password`"}")

  # 4. Trust it: the public part goes in the machine's trusted roots; the private key leaves the
  #    machine store, so it lives only in the file above.
  $cer = Join-Path ([IO.Path]::GetTempPath()) "uncbox-$Domain.cer"
  Export-Certificate -Cert $cert -FilePath $cer | Out-Null
  Import-Certificate -FilePath $cer -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
  Remove-Item -Path $cer
  Remove-Item -Path $cert.PSPath -DeleteKey
}

try {
  Remove-Setup
  if (-not $Remove) { Add-Setup }
  # Forget any old answer for unc.box so the new hosts entry takes effect right away.
  ipconfig /flushdns | Out-Null
  if ($Remove) { Write-Host "Removed $Domain." } else { Write-Host "Done. Restart Uncbox, then open https://$Domain" }
  Start-Sleep -Seconds 2
} catch {
  $why = $_.Exception.Message
  # Undo whatever got done before the failure, so nothing is left half set up.
  try { Remove-Setup } catch {}
  Write-Host ''
  Write-Host "Setting up $Domain failed: $why" -ForegroundColor Red
  Write-Host 'Nothing was changed. Uncbox still works at http://localhost:5170.'
  Read-Host 'Press Enter to close'
  exit 1
}
