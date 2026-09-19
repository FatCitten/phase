import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function acceptKey(key) { return createHash('sha1').update(String(key) + MAGIC).digest('base64'); }
function frameText(text) {
  const body = Buffer.from(String(text));
  if (body.length < 126) return Buffer.concat([Buffer.from([0x81, body.length]), body]);
  if (body.length < 65536) { const h=Buffer.alloc(4); h[0]=0x81;h[1]=126;h.writeUInt16BE(body.length,2);return Buffer.concat([h,body]); }
  const h=Buffer.alloc(10);h[0]=0x81;h[1]=127;h.writeBigUInt64BE(BigInt(body.length),2);return Buffer.concat([h,body]);
}
function parseFrames(buffer) {
  const frames=[]; let off=0;
  while (off + 2 <= buffer.length) {
    const b0=buffer[off], b1=buffer[off+1]; const opcode=b0&0x0f; const masked=Boolean(b1&0x80); let len=b1&0x7f; let head=2;
    if (len===126) { if(off+4>buffer.length)break; len=buffer.readUInt16BE(off+2);head=4; }
    else if (len===127) { if(off+10>buffer.length)break; const n=buffer.readBigUInt64BE(off+2); if(n>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('frame too large'); len=Number(n);head=10; }
    const maskBytes=masked?4:0; if(off+head+maskBytes+len>buffer.length)break;
    let pos=off+head; let mask=null;if(masked){mask=buffer.subarray(pos,pos+4);pos+=4;}
    const payload=Buffer.from(buffer.subarray(pos,pos+len)); if(mask)for(let i=0;i<payload.length;i++)payload[i]^=mask[i%4];
    frames.push({opcode,payload}); off=pos+len;
  }
  return {frames,rest:buffer.subarray(off)};
}
function normalizeKeys(keys) {
  if (keys instanceof Map) return keys;
  const map=new Map();
  for (const [key,val] of Object.entries(keys??{})) map.set(key, typeof val==='object'?val:{account:String(val),premium:true});
  return map;
}

export function startPhaseCloudServer({ host='127.0.0.1', port=0, apiKeys={}, privateLog=null, productLog=null, onEvent=null }={}) {
  const keys=normalizeKeys(apiKeys); const events=[];
  if(privateLog)mkdirSync(dirname(resolve(privateLog)),{recursive:true}); if(productLog)mkdirSync(dirname(resolve(productLog)),{recursive:true});
  const server=createServer((req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({service:'phase-cloud',protocol:'phase-cloud-v1'}));});
  server.on('upgrade',(req,socket)=>{
    const key=req.headers['sec-websocket-key']; if(!key){socket.destroy();return;}
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
    let buf=Buffer.alloc(0), auth=null;
    const send=(obj)=>socket.write(frameText(JSON.stringify(obj)));
    socket.on('data',(chunk)=>{
      buf=Buffer.concat([buf,chunk]); let parsed; try{parsed=parseFrames(buf);}catch{socket.destroy();return;} buf=parsed.rest;
      for(const f of parsed.frames){
        if(f.opcode===0x8){socket.end();return;} if(f.opcode!==0x1)continue;
        let msg;try{msg=JSON.parse(f.payload.toString('utf8'));}catch{send({type:'error',error:'invalid json'});continue;}
        if(msg.type==='hello'){
          const ent=keys.get(String(msg.apiKey??''));
          if(!ent){send({type:'hello.ack',replyTo:msg.id,ok:false,error:'invalid api key'});continue;}
          auth={account:ent.account??msg.account??'account',premium:ent.premium!==false};
          send({type:'hello.ack',replyTo:msg.id,ok:true,entitlements:{premium:auth.premium,cloudSync:true,benchmarkNetwork:true},account:auth.account});
          continue;
        }
        if(msg.type==='event'){
          if(!auth){send({type:'ack',replyTo:msg.id,ok:false,error:'not authenticated'});continue;}
          const base={account:auth.account,event:msg.event,at:msg.at,context:msg.context,consent:msg.consent};
          if(msg.private!=null&&privateLog)appendFileSync(privateLog,JSON.stringify({...base,payload:msg.private})+'\n');
          if(msg.product!=null&&msg.consent?.dataProduct==='aggregate'&&productLog){
            const runFingerprint=createHash('sha256').update(`${auth.account}:${msg.context?.runId??''}`).digest('hex').slice(0,24);
            const productBase={event:msg.event,at:msg.at,runFingerprint,clientVersion:msg.context?.clientVersion??null,consent:{dataProduct:'aggregate'}};
            appendFileSync(productLog,JSON.stringify({...productBase,payload:msg.product})+'\n');
          }
          events.push({...base,private:msg.private,product:msg.product}); onEvent?.(events.at(-1));
          send({type:'ack',replyTo:msg.id,ok:true});
        }
      }
    });
  });
  return new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,()=>{const a=server.address();resolve({server,url:`ws://${host}:${a.port}`,events,close:()=>new Promise(r=>server.close(r))});});});
}
