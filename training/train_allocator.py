#!/usr/bin/env python3
"""Train the Phase TPM allocator on architecture seeds + measured fiber outcomes.

The target is allocation JSON only. Project source, patches, and canonical project facts
must not be targets; those remain external Phase state.
"""
from __future__ import annotations
import argparse, hashlib, json
from pathlib import Path
import torch
from datasets import load_dataset
from transformers import AutoModelForCausalLM, AutoTokenizer
from trl import SFTConfig, SFTTrainer
from peft import LoraConfig

def digest(path: Path) -> str:
    h=hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda:f.read(1024*1024), b''): h.update(chunk)
    return h.hexdigest()

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('dataset',type=Path,help='allocator-chat.jsonl')
    ap.add_argument('--base-model',default='Qwen/Qwen2.5-0.5B-Instruct')
    ap.add_argument('--output',type=Path,default=Path('phase-tpm-allocator'))
    ap.add_argument('--epochs',type=float,default=3.0)
    ap.add_argument('--lr',type=float,default=2e-4)
    ap.add_argument('--max-length',type=int,default=1024)
    args=ap.parse_args(); path=args.dataset.resolve(); ds=load_dataset('json',data_files=str(path),split='train')
    if len(ds)<8: raise SystemExit('need at least 8 allocation examples (seeds + measured runs)')
    test_n=max(2,min(len(ds)//4,32)); split=ds.train_test_split(test_size=test_n,shuffle=True,seed=42)
    tok=AutoTokenizer.from_pretrained(args.base_model)
    dtype=torch.bfloat16 if torch.cuda.is_available() and torch.cuda.is_bf16_supported() else (torch.float16 if torch.cuda.is_available() else torch.float32)
    model=AutoModelForCausalLM.from_pretrained(args.base_model,torch_dtype=dtype,device_map='auto' if torch.cuda.is_available() else None)
    peft=LoraConfig(r=8,lora_alpha=16,lora_dropout=0.05,bias='none',task_type='CAUSAL_LM',target_modules=['q_proj','k_proj','v_proj','o_proj','gate_proj','up_proj','down_proj'])
    args.output.mkdir(parents=True,exist_ok=True)
    cfg=SFTConfig(output_dir=str(args.output),max_length=args.max_length,packing=False,num_train_epochs=args.epochs,per_device_train_batch_size=2,per_device_eval_batch_size=2,gradient_accumulation_steps=4,learning_rate=args.lr,logging_steps=5,eval_strategy='epoch',save_strategy='epoch',report_to=[],bf16=dtype==torch.bfloat16,fp16=dtype==torch.float16)
    trainer=SFTTrainer(model=model,args=cfg,train_dataset=split['train'],eval_dataset=split['test'],processing_class=tok,peft_config=peft)
    trainer.train();trainer.save_model(str(args.output));tok.save_pretrained(str(args.output))
    manifest={'schema':'phase-tpm-training-v1','base_model':args.base_model,'dataset':str(path),'dataset_sha256':digest(path),'examples':len(ds),'target':'resource allocation JSON only; never project truth or code','lora':True}
    (args.output/'phase-tpm-training-manifest.json').write_text(json.dumps(manifest,indent=2));print(json.dumps(manifest,indent=2))
if __name__=='__main__':main()
