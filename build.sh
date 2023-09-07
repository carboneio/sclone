# Get current package version
PACKAGE_VERSION=$(cat package.json | grep "version" | head -1 | awk -F: '{ print $2 }' | sed 's/[",]//g' | tr -d '[[:space:]]')

# Build target
BUILD_TARGET="latest-linux-x64,latest-macos-x64"

pkg -t $BUILD_TARGET -o "sclone-$PACKAGE_VERSION" .