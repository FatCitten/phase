#!/usr/bin/env python3
"""Fine-tune FunctionGemma 270M on Phase's validated function-call traces.

The dataset format follows Google's FunctionGemma fine-tuning format: messages + tools,
with an assistant tool_call target. This is the ultra-small edge-agent track.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import torch
from datasets import load_dataset
from transformers import AutoModelForCausalLM, AutoTokenizer
from trl import SFTConfig, SFTTrainer


def digest(path: Path) -> str:
    h = hashlib.sha256(path.read_bytes()).hexdigest()
    return h


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("dataset", type=Path, help="accepted.functiongemma.jsonl from phase forge")
    ap.add_argument("--base-model", default="google/functiongemma-270m-it")
    ap.add_argument("--output", type=Path, default=Path("phase-student-functiongemma-270m"))
    ap.add_argument("--epochs", type=float, default=5.0)
    ap.add_argument("--lr", type=float, default=5e-5)
    ap.add_argument("--max-length", type=int, default=2048)
    args = ap.parse_args()

    path = args.dataset.resolve()
    ds = load_dataset("json", data_files=str(path), split="train")
    if len(ds) < 2:
        raise SystemExit("need at least 2 examples")
    split = ds.train_test_split(test_size=0.1 if len(ds) >= 20 else 0.2, shuffle=True, seed=42)

    tokenizer = AutoTokenizer.from_pretrained(args.base_model)
    dtype = torch.bfloat16 if torch.cuda.is_available() and torch.cuda.is_bf16_supported() else (torch.float16 if torch.cuda.is_available() else torch.float32)
    model = AutoModelForCausalLM.from_pretrained(
        args.base_model,
        torch_dtype=dtype,
        device_map="auto" if torch.cuda.is_available() else None,
        attn_implementation="eager",
    )
    args.output.mkdir(parents=True, exist_ok=True)
    cfg = SFTConfig(
        output_dir=str(args.output),
        max_length=args.max_length,
        packing=False,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=2 if torch.cuda.is_available() else 1,
        gradient_accumulation_steps=4,
        learning_rate=args.lr,
        logging_steps=5,
        eval_strategy="epoch",
        save_strategy="epoch",
        report_to=[],
        bf16=dtype == torch.bfloat16,
        fp16=dtype == torch.float16,
    )
    trainer = SFTTrainer(
        model=model,
        args=cfg,
        train_dataset=split["train"],
        eval_dataset=split["test"],
        processing_class=tokenizer,
    )
    trainer.train()
    trainer.save_model(str(args.output))
    tokenizer.save_pretrained(str(args.output))
    manifest = {
        "schema": "phase-student-training-v1",
        "base_model": args.base_model,
        "dataset": str(path),
        "dataset_sha256": digest(path),
        "examples": len(ds),
        "epochs": args.epochs,
        "learning_rate": args.lr,
        "dtype": str(dtype),
    }
    (args.output / "phase-training-manifest.json").write_text(json.dumps(manifest, indent=2))
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
