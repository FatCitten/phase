import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, writeSync } from 'node:fs';
import { PHASE_HEADER_BYTES, PHASE_ISA_VERSION, PHASE_RECORD_BYTES } from './isa.mjs';

const MAGIC=Buffer.from('PHB1');

function crc32Table(){const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?(0xedb88320^(c>>>1)):(c>>>1);t[n]=c>>>0;}return t;}
const CRC=crc32Table();
export function crc32(buf){let c=0xffffffff;for(const byte of buf)c=CRC[(c^byte)&0xff]^(c>>>8);return (c^0xffffffff)>>>0;}
const sha256=(b)=>createHash('sha256').update(b).digest('hex');

function runFingerprint(runId){return createHash('sha256').update(String(runId)).digest().subarray(0,16);}
function seedFingerprint(seedHash){return Buffer.from(String(seedHash??'').padEnd(32,'0').slice(0,32),'hex');}

export function encodeHeader({stream,runId=randomUUID(),seedHash='',createdMs=Date.now()}){
  const b=Buffer.alloc(PHASE_HEADER_BYTES);MAGIC.copy(b,0);b.writeUInt16LE(PHASE_ISA_VERSION,4);b.writeUInt16LE(PHASE_RECORD_BYTES,6);b.writeUInt8(Number(stream),8);b.writeUInt8(1,9);b.writeUInt16LE(PHASE_HEADER_BYTES,10);b.writeBigUInt64LE(BigInt(Math.max(0,Math.floor(createdMs))),12);runFingerprint(runId).copy(b,20);seedFingerprint(seedHash).copy(b,36);b.writeUInt32LE(crc32(b.subarray(0,60)),60);return b;
}

export function decodeHeader(buf){if(buf.length<PHASE_HEADER_BYTES)throw new Error('truncated phasebin header');if(!buf.subarray(0,4).equals(MAGIC))throw new Error('invalid phasebin magic');const got=buf.readUInt32LE(60),expected=crc32(buf.subarray(0,60));return{magic:'PHB1',version:buf.readUInt16LE(4),record_bytes:buf.readUInt16LE(6),stream:buf.readUInt8(8),endian:buf.readUInt8(9),header_bytes:buf.readUInt16LE(10),created_ms:Number(buf.readBigUInt64LE(12)),header_crc32:got,header_crc_ok:got===expected};}

export function encodePacket({opcode,flags=0,fiber=0,seq=0,mono_ms=0,a=0,b=0,value=0}){
  const r=Buffer.alloc(PHASE_RECORD_BYTES);r.writeUInt8(Number(opcode)&0xff,0);r.writeUInt8(Number(flags)&0xff,1);r.writeUInt16LE(Number(fiber)&0xffff,2);r.writeUInt32LE(Number(seq)>>>0,4);r.writeUInt32LE(Math.max(0,Math.floor(Number(mono_ms)))>>>0,8);r.writeUInt32LE(Number(a)>>>0,12);r.writeUInt32LE(Number(b)>>>0,16);r.writeBigInt64LE(BigInt(Math.trunc(Number(value))),20);r.writeUInt32LE(crc32(r.subarray(0,28)),28);return r;
}
export function decodePacket(r){if(r.length!==PHASE_RECORD_BYTES)throw new Error('invalid phase packet length');const got=r.readUInt32LE(28),expected=crc32(r.subarray(0,28));return{opcode:r.readUInt8(0),flags:r.readUInt8(1),fiber:r.readUInt16LE(2),seq:r.readUInt32LE(4),mono_ms:r.readUInt32LE(8),a:r.readUInt32LE(12),b:r.readUInt32LE(16),value:r.readBigInt64LE(20),crc32:got,crc_ok:got===expected};}

export class PhaseBinWriter{
  constructor(path,{stream,runId,seedHash='',onPacket=null,clockStart=null}={}){this.path=path;this.fd=openSync(path,'wx');this.stream=stream;this.seq=0;this.started=clockStart??performance.now();this.onPacket=onPacket;writeSync(this.fd,encodeHeader({stream,runId,seedHash}));}
  packet(packet){const p={...packet,seq:++this.seq,mono_ms:packet.mono_ms??Math.round(performance.now()-this.started)};const bytes=encodePacket(p);writeSync(this.fd,bytes);const decoded=decodePacket(bytes);this.onPacket?.(decoded,{stream:this.stream,path:this.path});return decoded;}
  close(){if(this.fd!==null){closeSync(this.fd);this.fd=null;}}
}

export function readPhaseBin(path,{strict=true}={}){const buf=readFileSync(path);const header=decodeHeader(buf.subarray(0,PHASE_HEADER_BYTES));if(strict&&!header.header_crc_ok)throw new Error('phasebin header CRC mismatch');if((buf.length-PHASE_HEADER_BYTES)%PHASE_RECORD_BYTES!==0)throw new Error('phasebin contains partial record');const packets=[];for(let o=PHASE_HEADER_BYTES;o<buf.length;o+=PHASE_RECORD_BYTES){const p=decodePacket(buf.subarray(o,o+PHASE_RECORD_BYTES));if(strict&&!p.crc_ok)throw new Error(`phasebin record CRC mismatch at seq ${p.seq}`);packets.push(p);}return{header,packets,bytes:buf.length,sha256:sha256(buf)};}

export function verifyPhaseBin(path){const failures=[];if(!existsSync(path))return{passed:false,path,failures:['missing file']};let parsed;try{parsed=readPhaseBin(path,{strict:false});}catch(e){return{passed:false,path,failures:[String(e)]};}if(!parsed.header.header_crc_ok)failures.push('header CRC mismatch');if(parsed.header.version!==PHASE_ISA_VERSION)failures.push(`unsupported ISA version ${parsed.header.version}`);if(parsed.header.record_bytes!==PHASE_RECORD_BYTES)failures.push(`record size ${parsed.header.record_bytes}`);let prev=0;for(const p of parsed.packets){if(!p.crc_ok)failures.push(`record ${p.seq} CRC mismatch`);if(p.seq!==prev+1)failures.push(`record sequence expected ${prev+1}, got ${p.seq}`);if(p.mono_ms<0)failures.push(`record ${p.seq} negative time`);prev=p.seq;}return{passed:failures.length===0,path,stream:parsed.header.stream,records:parsed.packets.length,bytes:parsed.bytes,sha256:parsed.sha256,failures};}

export function phaseBinTail(path,{fromRecord=0}={}){const fd=openSync(path,'r');try{const size=fstatSync(fd).size;if(size<PHASE_HEADER_BYTES)return{packets:[],next:fromRecord};const total=Math.floor((size-PHASE_HEADER_BYTES)/PHASE_RECORD_BYTES);const start=Math.min(fromRecord,total);const count=total-start;if(count<=0)return{packets:[],next:total};const b=Buffer.alloc(count*PHASE_RECORD_BYTES);readSync(fd,b,0,b.length,PHASE_HEADER_BYTES+start*PHASE_RECORD_BYTES);const packets=[];for(let o=0;o<b.length;o+=PHASE_RECORD_BYTES)packets.push(decodePacket(b.subarray(o,o+PHASE_RECORD_BYTES)));return{packets,next:total};}finally{closeSync(fd);}}
