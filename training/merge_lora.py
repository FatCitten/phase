#!/usr/bin/env python3
from __future__ import annotations
import argparse
from pathlib import Path
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import PeftModel

ap = argparse.ArgumentParser()
ap.add_argument("adapter", type=Path)
ap.add_argument("--base-model", default="Qwen/Qwen2.5-Coder-0.5B-Instruct")
ap.add_argument("--output", type=Path, default=Path("phase-student-merged"))
args = ap.parse_args()

base = AutoModelForCausalLM.from_pretrained(args.base_model, device_map="cpu")
model = PeftModel.from_pretrained(base, str(args.adapter)).merge_and_unload()
args.output.mkdir(parents=True, exist_ok=True)
model.save_pretrained(args.output, safe_serialization=True)
AutoTokenizer.from_pretrained(args.base_model).save_pretrained(args.output)
print(args.output)
