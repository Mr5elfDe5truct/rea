# Adds or removes one directory on the current user's PATH.
# The raw registry value is edited so REG_EXPAND_SZ entries such as
# %USERPROFILE%\bin keep their unexpanded form.
param(
  [Parameter(Mandatory = $true)][ValidateSet('add', 'remove')][string]$Action,
  [Parameter(Mandatory = $true)][string]$Directory
)

$ErrorActionPreference = 'Stop'
$target = $Directory.TrimEnd('\')
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
try {
  $current = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $entries = @($current -split ';' | Where-Object { $_ -ne '' -and $_.TrimEnd('\') -ine $target })
  if ($Action -eq 'add') { $entries += $target }
  $updated = $entries -join ';'
  if ($updated -ne $current) {
    $key.SetValue('Path', $updated, [Microsoft.Win32.RegistryValueKind]::ExpandString)
  }
} finally {
  $key.Close()
}
