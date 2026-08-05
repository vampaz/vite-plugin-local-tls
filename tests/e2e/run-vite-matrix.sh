#!/usr/bin/env bash
set -euo pipefail

versions=(
  '3.2.11'
  '4.5.14'
  '5.4.21'
  '6.4.3'
  '7.3.6'
  '8.2.0'
)

for version in "${versions[@]}"; do
  echo "Running installed-package smoke with Vite ${version}"
  VITE_E2E_VITE_VERSION="${version}" npm run test:e2e -- tests/e2e/smoke.spec.ts
done
