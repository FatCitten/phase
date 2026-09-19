const canvas=document.querySelector('#game');
const status=document.querySelector('#status');
const stats=document.querySelector('#stats');

if(!navigator.gpu){status.textContent='WebGPU unavailable. Use a current WebGPU-capable browser over HTTPS or localhost.';throw new Error('WebGPU unavailable');}
const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
if(!adapter){status.textContent='No WebGPU adapter available.';throw new Error('No WebGPU adapter');}
const device=await adapter.requestDevice();
const context=canvas.getContext('webgpu');
const format=navigator.gpu.getPreferredCanvasFormat();
context.configure({device,format,alphaMode:'opaque'});
const shaderCode=await (await fetch('./src/shader.wgsl')).text();
const shader=device.createShaderModule({code:shaderCode});
const pipeline=device.createRenderPipeline({layout:'auto',vertex:{module:shader,entryPoint:'vs'},fragment:{module:shader,entryPoint:'fs',targets:[{format}]},primitive:{topology:'triangle-list'}});
const uniform=device.createBuffer({size:96,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
const bindGroup=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:uniform}}]});

const player={x:2.5,y:2.5,a:0,health:100,score:0};
const enemies=[{x:8.5,y:2.5,hp:2},{x:12.5,y:6.5,hp:2},{x:3.5,y:12.5,hp:2},{x:11.5,y:12.5,hp:2}];
const keys=new Set(); let attack=0,last=performance.now(),hurtCooldown=0;
const wallAt=(x,y)=>x<=0||y<=0||x>=15||y>=15||(x===5&&y>=2&&y<=11&&y!==7)||(y===9&&x>=8&&x<=13&&x!==11)||(y===4&&x>=9&&x<=11);
const blocked=(x,y)=>wallAt(Math.floor(x),Math.floor(y));
const wrap=a=>Math.atan2(Math.sin(a),Math.cos(a));
function resize(){const d=Math.min(devicePixelRatio||1,2);const w=Math.max(1,Math.floor(innerWidth*d)),h=Math.max(1,Math.floor(innerHeight*d));if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}}
addEventListener('resize',resize);resize();
addEventListener('keydown',e=>keys.add(e.code));addEventListener('keyup',e=>keys.delete(e.code));
canvas.addEventListener('click',()=>{if(document.pointerLockElement!==canvas){canvas.requestPointerLock();return;} /* TODO: melee attack */});
addEventListener('mousemove',e=>{if(document.pointerLockElement===canvas)player.a+=e.movementX*0.0025;});

function update(dt){
  attack=Math.max(0,attack-dt*3.4);hurtCooldown=Math.max(0,hurtCooldown-dt);
  const f=(keys.has('KeyW')?1:0)-(keys.has('KeyS')?1:0),s=(keys.has('KeyD')?1:0)-(keys.has('KeyA')?1:0),speed=3.2;
  const dx=(Math.cos(player.a)*f-Math.sin(player.a)*s)*speed*dt,dy=(Math.sin(player.a)*f+Math.cos(player.a)*s)*speed*dt;
  if(!blocked(player.x+dx,player.y))player.x+=dx;if(!blocked(player.x,player.y+dy))player.y+=dy;
  for(const e of enemies){
    if(e.hp<=0)continue;const dxp=player.x-e.x,dyp=player.y-e.y,d=Math.hypot(dxp,dyp);
    if(d>0.7){const k=Math.min(0.75*dt,d-0.65),nx=e.x+dxp/d*k,ny=e.y+dyp/d*k;if(!blocked(nx,e.y))e.x=nx;if(!blocked(e.x,ny))e.y=ny;}
    if(d<0.72&&hurtCooldown<=0){player.health=Math.max(0,player.health-8);hurtCooldown=0.65;}
  }
}
function render(t){
  resize();const data=new Float32Array(24);data.set([player.x,player.y,player.a,t/1000,canvas.width,canvas.height,attack,player.health],0);
  enemies.forEach((e,i)=>data.set([e.x,e.y,e.hp,i],8+i*4));device.queue.writeBuffer(uniform,0,data);
  const encoder=device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[{view:context.getCurrentTexture().createView(),clearValue:{r:0.02,g:0.025,b:0.04,a:1},loadOp:'clear',storeOp:'store'}]});
  pass.setPipeline(pipeline);pass.setBindGroup(0,bindGroup);pass.draw(3);pass.end();device.queue.submit([encoder.finish()]);
}
function frame(now){const dt=Math.min((now-last)/1000,0.05);last=now;update(dt);render(now);status.textContent=player.health>0?'Hunt the crimson shades.':'You fell — refresh to restart.';stats.textContent=`HP ${player.health} · KILLS ${player.score}/4`;requestAnimationFrame(frame);}
status.textContent='WebGPU ready.';requestAnimationFrame(frame);
