import { createHash } from 'node:crypto';

export const PHASE_ISA_VERSION = 1;
export const PHASE_RECORD_BYTES = 32;
export const PHASE_HEADER_BYTES = 64;

export const STREAM = Object.freeze({ CONTROL: 1, SIGNAL: 2, STATE: 3 });

export const OPCODE = Object.freeze({
  BOOT: 0x01,
  FORK: 0x10,
  ROUTE: 0x11,
  ALLOC: 0x12,
  GRANT: 0x13,
  MAPCTX: 0x14,
  RUN: 0x15,
  GATE: 0x16,
  BLOCK: 0x17,
  COMPLETE: 0x18,
  FAIL: 0x19,
  RELEASE: 0x1a,
  HALT: 0x1f,

  STATE_FEATURE: 0x40,
  STATE_REPO: 0x41,

  SIG_START: 0x80,
  SIG_WORKER_OK: 0x81,
  SIG_WORKER_FAIL: 0x82,
  SIG_VALID_PASS: 0x83,
  SIG_VALID_FAIL: 0x84,
  SIG_WALL_MS: 0x85,
  SIG_CTX_ALLOC: 0x86,
  SIG_TOOL_BUDGET: 0x87,
  SIG_TOKEN_BUDGET: 0x88,
  SIG_CONTEXT_MISS: 0x89,
  SIG_RETRY: 0x8a,
  SIG_HUMAN_REQ: 0x8b,
  SIG_ERROR: 0x8c,
  SIG_PROGRESS: 0x8d,
  SIG_STOP: 0x8f
});

export const RESOURCE = Object.freeze({
  NONE: 0,
  CONTEXT_TOKENS: 1,
  TOKENS: 2,
  WALL_MS: 3,
  TOOL_CALLS: 4,
  MONEY_MICROUNITS: 5,
  HUMAN_ATTENTION_MICROUNITS: 6,
  PARALLEL_SLOTS: 7,
  RETRY_BUDGET: 8
});

export const STAGE = Object.freeze({
  QUEUED: 0,
  ALLOCATED: 1,
  CONTEXT: 2,
  RUNNING: 3,
  VALIDATING: 4,
  DONE: 5,
  FAILED: 6,
  BLOCKED: 7
});

const opcodeName = new Map(Object.entries(OPCODE).map(([k,v])=>[v,k]));
const resourceName = new Map(Object.entries(RESOURCE).map(([k,v])=>[v,k]));
const stageName = new Map(Object.entries(STAGE).map(([k,v])=>[v,k]));

export function opcodeLabel(code){return opcodeName.get(Number(code))??`OP_0x${Number(code).toString(16).padStart(2,'0')}`;}
export function resourceLabel(code){return resourceName.get(Number(code))??`R${code}`;}
export function stageLabel(code){return stageName.get(Number(code))??`STAGE_${code}`;}

export function symbol32(text){
  const b=createHash('sha256').update(String(text)).digest();
  return b.readUInt32LE(0);
}

export function fiberNumber(id, workflow=null){
  if(workflow){const i=workflow.fibers.findIndex(x=>x.id===id);if(i>=0)return i+1;}
  const m=String(id??'').match(/^(?:F)?(\d+)$/i);if(m)return Math.max(0,Math.min(0xffff,Number(m[1])));
  return symbol32(id)&0xffff;
}

export function formatPacket(packet,{symbols=null}={}){
  const op=opcodeLabel(packet.opcode);const fiber=packet.fiber?`F${packet.fiber}`:'SYS';
  const sym=(kind,id)=>symbols?.[kind]?.[String(id)]??null;
  let detail='';
  switch(packet.opcode){
    case OPCODE.ROUTE: detail=`agent=${sym('agent',packet.a)??`0x${packet.a.toString(16)}`}`;break;
    case OPCODE.ALLOC: detail=`${resourceLabel(packet.a)}=${packet.value}`;break;
    case OPCODE.GRANT: detail=`tool=${sym('tool',packet.a)??`0x${packet.a.toString(16)}`}`;break;
    case OPCODE.MAPCTX: detail=`items=${packet.value}`;break;
    case OPCODE.GATE: detail=`checks=${packet.value}`;break;
    case OPCODE.BLOCK: detail=`dependency=${packet.a}`;break;
    case OPCODE.STATE_FEATURE: detail=`feature[${packet.a}/${packet.b}]=${Number(packet.value)/1000000}`;break;
    case OPCODE.STATE_REPO: detail=`repository=${sym('repository',packet.a)??`0x${packet.a.toString(16)}`}`;break;
    case OPCODE.SIG_PROGRESS: detail=`stage=${stageLabel(packet.a)}`;break;
    case OPCODE.SIG_WALL_MS: detail=`wall_ms=${packet.value}`;break;
    case OPCODE.SIG_CTX_ALLOC: detail=`context_tokens=${packet.value}`;break;
    case OPCODE.SIG_TOOL_BUDGET: detail=`tool_calls=${packet.value}`;break;
    case OPCODE.SIG_TOKEN_BUDGET: detail=`tokens=${packet.value}`;break;
    case OPCODE.SIG_CONTEXT_MISS: detail=`count=${packet.value}`;break;
    case OPCODE.SIG_RETRY: detail=`count=${packet.value}`;break;
    case OPCODE.SIG_HUMAN_REQ: detail=`count=${packet.value}`;break;
    case OPCODE.SIG_ERROR: detail=`code=${packet.a} value=${packet.value}`;break;
    default: if(packet.value!==0n)detail=`value=${packet.value}`;
  }
  return `${String(packet.seq).padStart(6,'0')}  +${String(packet.mono_ms).padStart(8)}ms  ${fiber.padEnd(6)} ${op.padEnd(18)} ${detail}`.trimEnd();
}
