import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhaseBinWriter, readPhaseBin, verifyPhaseBin } from '../src/phasebin.mjs';
import { OPCODE, RESOURCE, STREAM } from '../src/isa.mjs';

test('phasebin is fixed width, round-trippable, and CRC protected',()=>{
  const root=mkdtempSync(join(tmpdir(),'phase-bin-')),p=join(root,'control.phasebin');const w=new PhaseBinWriter(p,{stream:STREAM.CONTROL,runId:'test',seedHash:'00'.repeat(32)});w.packet({opcode:OPCODE.ALLOC,fiber:1,a:RESOURCE.CONTEXT_TOKENS,value:8192});w.packet({opcode:OPCODE.RUN,fiber:1,value:1});w.close();
  const x=readPhaseBin(p);assert.equal(x.header.record_bytes,32);assert.equal(x.packets.length,2);assert.equal(x.packets[0].value,8192n);assert.equal(verifyPhaseBin(p).passed,true);
  const b=readFileSync(p);b[b.length-10]^=0xff;writeFileSync(p,b);assert.equal(verifyPhaseBin(p).passed,false);
});
