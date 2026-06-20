#!/bin/bash
# Compile the optional native helper that reads the real Finder sidebar.
# WebFinder runs fine without it (it falls back to default favourites), but
# building it lets the sidebar mirror your actual Finder favourites.
set -e
cd "$(dirname "$0")"
if ! command -v swiftc >/dev/null 2>&1; then
  echo "Skipping: swiftc not found, so the optional Finder-sidebar helper"
  echo "won't be built. WebFinder still runs - it just uses default favourites."
  echo "To enable it later, install the Xcode Command Line Tools"
  echo "(xcode-select --install) and re-run ./build.sh."
  exit 0
fi
echo "Compiling helper/webfinder-helper.swift ..."
swiftc -O -framework CoreServices helper/webfinder-helper.swift -o helper/webfinder-helper
echo "Built helper/webfinder-helper"
