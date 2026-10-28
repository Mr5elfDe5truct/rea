#!/usr/bin/env bash
# Builds the per-user Windows x64 installer (with uninstaller) for REA.
#
# Requires Linux with: node/npm (see .nvmrc), curl, unzip, tar, makensis (NSIS),
# and MinGW-w64 (x86_64-w64-mingw32-g++, x86_64-w64-mingw32-dlltool) for the
# Windows native addon. Output: build/windows-installer/REA-Setup-<version>-x64.exe
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
node_version="${REA_WINDOWS_NODE_VERSION:-v24.22.1}"
work="$repo/build/windows-installer"
stage="$work/stage"

cd "$repo"
version="$(node -p "require('./package.json').version")"
frida_version="$(node -p "require('./package.json').optionalDependencies.frida")"

echo "==> Building REA $version"
npm ci --no-audit --no-fund
npm run build:cached
npm run build:windows-native
npm run verify:windows-native:artifact

rm -rf "$work"
mkdir -p "$work/dl" "$work/app" "$stage/bin"
npm pack --pack-destination "$work"
tarball="$work/rea-agents-$version.tgz"

echo "==> Installing Windows x64 production dependencies"
(
  cd "$work/app"
  echo '{"name":"rea-windows-bundle","private":true}' > package.json
  # Install scripts would run on this Linux host, so prebuilt Windows
  # binaries are fetched explicitly below instead.
  npm install --no-audit --no-fund --ignore-scripts --omit=dev \
    --os=win32 --cpu=x64 "$tarball"
)

echo "==> Fetching Node.js $node_version (win-x64) and Frida $frida_version binding"
(
  cd "$work/dl"
  curl -fsSLO "https://nodejs.org/dist/$node_version/node-$node_version-win-x64.zip"
  curl -fsSLO "https://nodejs.org/dist/$node_version/SHASUMS256.txt"
  grep " node-$node_version-win-x64.zip\$" SHASUMS256.txt | sha256sum -c -
  frida_archive="frida-v$frida_version-napi-v8-win32-x64.tar.gz"
  curl -fsSLO "https://github.com/frida/frida/releases/download/$frida_version/$frida_archive"
  tar xzf "$frida_archive" -C "$work/app/node_modules/frida"
  unzip -q "node-$node_version-win-x64.zip"
)

echo "==> Staging"
mv "$work/dl/node-$node_version-win-x64" "$stage/node"
# REA only needs the runtime; npm, npx and corepack are not shipped.
rm -rf "$stage/node/node_modules" "$stage/node/"{npm,npx,corepack}* \
  "$stage/node/install_tools.bat" "$stage/node/nodevars.bat" "$stage/node/CHANGELOG.md"
mv "$stage/node/LICENSE" "$stage/NODE_LICENSE.txt"
rm -f "$work/app/package-lock.json"
find "$work/app" -name '*.pdb' -delete
mv "$work/app" "$stage/app"
cp LICENSE "$stage/LICENSE.txt"
cp THIRD_PARTY_NOTICES.md "$stage/"

entry='"%~dp0..\node\node.exe" "%~dp0..\app\node_modules\rea-agents\scripts\rea.mjs" %*'
for name in rea rea-agents; do
  printf '@echo off\r\nsetlocal\r\n%s\r\nexit /b %%ERRORLEVEL%%\r\n' "$entry" > "$stage/bin/$name.cmd"
done
printf '@echo off\r\nset "PATH=%%~dp0;%%PATH%%"\r\necho REA %s - type "rea --help" to list commands, "rea setup" to configure agents.\r\n' \
  "$version" > "$stage/bin/rea-shell.cmd"

echo "==> Compiling installer"
cd "$here"
makensis -V2 -DVERSION="$version" -DSTAGE_DIR="$stage" \
  -DOUT_FILE="$work/REA-Setup-$version-x64.exe" rea.nsi
sha256sum "$work/REA-Setup-$version-x64.exe" | tee "$work/REA-Setup-$version-x64.exe.sha256"
