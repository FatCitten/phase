#!/usr/bin/env bash
set -euo pipefail
if [[ $# -lt 2 ]]; then
  echo "usage: scripts/export-gguf.sh MERGED_HF_DIR LLAMA_CPP_DIR [OUT_BASENAME]" >&2
  exit 64
fi
MODEL_DIR="$(realpath "$1")"
LLAMA_CPP="$(realpath "$2")"
NAME="${3:-phase-student}"
F16="${MODEL_DIR}/${NAME}-f16.gguf"
Q4="${MODEL_DIR}/${NAME}-Q4_K_M.gguf"
python3 "${LLAMA_CPP}/convert_hf_to_gguf.py" --outfile "$F16" --outtype f16 "$MODEL_DIR"
QUANT="${LLAMA_CPP}/build/bin/llama-quantize"
[[ -x "$QUANT" ]] || QUANT="${LLAMA_CPP}/llama-quantize"
"$QUANT" "$F16" "$Q4" Q4_K_M
echo "$Q4"
