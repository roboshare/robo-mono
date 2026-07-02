#!/bin/bash
set -euo pipefail

# Find workspace root relative to this script
WORKSPACE_ROOT=$(git rev-parse --show-toplevel)
cd "$WORKSPACE_ROOT/protocols/evm"

echo "======================"
echo "EVM: Running Coverage"
echo "======================"

forge cleanup || true
forge coverage --ir-minimum --report lcov

echo "Checking coverage thresholds..."
awk -v min_lines=80 -v min_branches=80 -v min_functions=75 '
  BEGIN{FS=":"}
  /^SF:/ {file=$2; in_contract=(index(file,"contracts/")==1);}
  in_contract && /^LH:/ {lh+=$2}
  in_contract && /^LF:/ {lf+=$2}
  in_contract && /^BRH:/ {brh+=$2}
  in_contract && /^BRF:/ {brf+=$2}
  in_contract && /^FNH:/ {fnh+=$2}
  in_contract && /^FNF:/ {fnf+=$2}
  END{
    if (lf==0){print "No contract lines found in coverage"; exit 1}
    lines=100*lh/lf; branches=(brf?100*brh/brf:100); functions=(fnf?100*fnh/fnf:100)
    printf("Contracts/* coverage -> lines: %.2f%% (%d/%d), branches: %.2f%% (%d/%d), functions: %.2f%% (%d/%d)\n", lines, lh, lf, branches, brh, brf, functions, fnh, fnf)
    if (lines+1e-9 < min_lines) {printf("Lines coverage below threshold %.2f%%\n", min_lines); exit 2}
    if (branches+1e-9 < min_branches) {printf("Branch coverage below threshold %.2f%%\n", min_branches); exit 3}
    if (functions+1e-9 < min_functions) {printf("Function coverage below threshold %.2f%%\n", min_functions); exit 4}
  }
' lcov.info

echo "======================"
echo "Coverage checks passed! ✅"
echo "======================"
