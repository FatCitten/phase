import { appendFileSync, writeFileSync } from 'node:fs';
let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{
  if(s.includes('FIBER F1')) writeFileSync('artifact.txt','foundation\n');
  else if(s.includes('FIBER F2')) appendFileSync('artifact.txt','integration\n');
  else process.exitCode=2;
  console.log('fixture fiber complete');
});
