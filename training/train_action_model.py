#!/usr/bin/env python3
"""Fine-tune a small coding model on validator-approved Phase action traces.

Default base: Qwen2.5-Coder-0.5B-Instruct. The model learns one next-action JSON object
per state; Phase memory remains external and auditable at runtime.
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


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("dataset", type=Path, help="accepted.json-action.jsonl from phase forge")
    ap.add_argument("--base-model", default="Qwen/Qwen2.5-Coder-0.5B-Instruct")
    ap.add_argument("--output", type=Path, default=Path("phase-student-qwen05b"))
    ap.add_argument("--epochs", type=float, default=3.0)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--max-length", type=int, default=2048)
    ap.add_argument("--batch-size", type=int, default=1)
    ap.add_argument("--grad-accum", type=int, default=8)
    ap.add_argument("--full", action="store_true", help="full fine-tune instead of LoRA")
    ap.add_argument("--eval-fraction", type=float, default=0.1)
    args = ap.parse_args()

    dataset_path = args.dataset.resolve()
    ds = load_dataset("json", data_files=str(dataset_path), split="train")
    if len(ds) < 2:
        raise SystemExit("need at least 2 training examples")
    eval_fraction = min(0.4, max(0.01, args.eval_fraction)) if len(ds) >= 10 else 0.2
    split = ds.train_test_split(test_size=eval_fraction, shuffle=True, seed=42)

    tokenizer = AutoTokenizer.from_pretrained(args.base_model)
    dtype = torch.bfloat16 if torch.cuda.is_available() and torch.cuda.is_bf16_supported() else (torch.float16 if torch.cuda.is_available() else torch.float32)
    model = AutoModelForCausalLM.from_pretrained(args.base_model, torch_dtype=dtype, device_map="auto" if torch.cuda.is_available() else None)

    peft_config = None
    if not args.full:
        from peft import LoraConfig
        peft_config = LoraConfig(
            r=16,
            lora_alpha=32,
            lora_dropout=0.05,
            bias="none",
            task_type="CAUSAL_LM",
            target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        )

    args.output.mkdir(parents=True, exist_ok=True)
    config = SFTConfig(
        output_dir=str(args.output),
        max_length=args.max_length,
        packing=False,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch_size,
        per_device_eval_batch_size=args.batch_size,
        gradient_accumulation_steps=args.grad_accum,
        learning_rate=args.lr if not args.full else min(args.lr, 5e-5),
        logging_steps=5,
        eval_strategy="epoch",
        save_strategy="epoch",
        report_to=[],
        bf16=dtype == torch.bfloat16,
        fp16=dtype == torch.float16,
        gradient_checkpointing=False,
    )
    trainer = SFTTrainer(
        model=model,
        args=config,
        train_dataset=split["train"],
        eval_dataset=split["test"],
        processing_class=tokenizer,
        peft_config=peft_config,
    )
    trainer.train()
    trainer.save_model(str(args.output))
    tokenizer.save_pretrained(str(args.output))

    manifest = {
        "schema": "phase-student-training-v1",
        "base_model": args.base_model,
        "dataset": str(dataset_path),
        "dataset_sha256": sha256(dataset_path),
        "examples": len(ds),
        "epochs": args.epochs,
        "learning_rate": args.lr,
        "max_length": args.max_length,
        "lora": not args.full,
        "dtype": str(dtype),
    }
    (args.output / "phase-training-manifest.json").write_text(json.dumps(manifest, indent=2))
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
