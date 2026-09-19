struct Params {
  camera: vec4f,
  viewport: vec4f,
  enemy0: vec4f,
  enemy1: vec4f,
  enemy2: vec4f,
  enemy3: vec4f,
}
@group(0) @binding(0) var<uniform> p: Params;

fn wallAt(c: vec2i) -> bool {
  if (c.x <= 0 || c.y <= 0 || c.x >= 15 || c.y >= 15) { return true; }
  if (c.x == 5 && c.y >= 2 && c.y <= 11 && c.y != 7) { return true; }
  if (c.y == 9 && c.x >= 8 && c.x <= 13 && c.x != 11) { return true; }
  if (c.x >= 9 && c.x <= 11 && c.y == 4) { return true; }
  return false;
}

fn castRay(origin: vec2f, dir0: vec2f) -> vec2f {
  let dir = normalize(dir0);
  var cell = vec2i(floor(origin));
  let dd = abs(vec2f(1.0 / select(dir.x, 0.0001, abs(dir.x) < 0.0001), 1.0 / select(dir.y, 0.0001, abs(dir.y) < 0.0001)));
  let step = vec2i(select(-1, 1, dir.x >= 0.0), select(-1, 1, dir.y >= 0.0));
  var sideDist = vec2f(
    select((origin.x - f32(cell.x)) * dd.x, (f32(cell.x + 1) - origin.x) * dd.x, dir.x >= 0.0),
    select((origin.y - f32(cell.y)) * dd.y, (f32(cell.y + 1) - origin.y) * dd.y, dir.y >= 0.0)
  );
  var side = 0.0;
  var dist = 30.0;
  for (var i=0; i<64; i=i+1) {
    if (sideDist.x < sideDist.y) { cell.x += step.x; dist = sideDist.x; sideDist.x += dd.x; side = 0.0; }
    else { cell.y += step.y; dist = sideDist.y; sideDist.y += dd.y; side = 1.0; }
    if (wallAt(cell)) { break; }
  }
  return vec2f(max(dist, 0.001), side);
}

fn enemyPixel(enemy: vec4f, origin: vec2f, dir: vec2f, wallDist: f32, screenY: f32) -> vec4f {
  if (enemy.z <= 0.0) { return vec4f(0.0); }
  let rel = enemy.xy - origin;
  let along = dot(rel, dir);
  let lateral = abs(rel.x * dir.y - rel.y * dir.x);
  let radius = 0.28;
  let halfH = 0.72 / max(along, 0.1);
  if (along > 0.15 && along < wallDist && lateral < radius && abs(screenY) < halfH) {
    let edge = 1.0 - smoothstep(radius * 0.72, radius, lateral);
    let body = vec3f(0.66, 0.08, 0.055) * (0.55 + 0.45 * edge);
    let eye = select(0.0, 0.9, abs(screenY + halfH * 0.28) < halfH * 0.10 && lateral < radius * 0.55);
    return vec4f(body + vec3f(eye, eye * 0.55, 0.05), 1.0);
  }
  return vec4f(0.0);
}

@vertex fn vs(@builtin(vertex_index) i:u32) -> @builtin(position) vec4f {
  var pos = array<vec2f,3>(vec2f(-1.0,-1.0), vec2f(3.0,-1.0), vec2f(-1.0,3.0));
  return vec4f(pos[i],0.0,1.0);
}

@fragment fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let size = max(p.viewport.xy, vec2f(1.0));
  var uv = frag.xy / size * 2.0 - vec2f(1.0);
  uv.y = -uv.y;
  let aspect = size.x / size.y;
  let forward = vec2f(cos(p.camera.z), sin(p.camera.z));
  let right = vec2f(-forward.y, forward.x);
  let ray = normalize(forward + right * uv.x * aspect * 0.58);
  let hit = castRay(p.camera.xy, ray);
  let corrected = hit.x * max(dot(ray, forward), 0.2);
  let wallHalf = min(1.25, 0.92 / corrected);

  var color = select(vec3f(0.055,0.065,0.09), vec3f(0.11,0.095,0.075) * (0.65 + 0.2 / max(corrected,1.0)), uv.y < 0.0);
  if (abs(uv.y) < wallHalf) {
    let fog = clamp(1.0 - corrected / 18.0, 0.12, 1.0);
    let sideShade = select(0.82, 0.60, hit.y > 0.5);
    color = vec3f(0.24,0.30,0.36) * sideShade * fog;
  }

  let e0 = enemyPixel(p.enemy0,p.camera.xy,ray,hit.x,uv.y);
  let e1 = enemyPixel(p.enemy1,p.camera.xy,ray,hit.x,uv.y);
  let e2 = enemyPixel(p.enemy2,p.camera.xy,ray,hit.x,uv.y);
  let e3 = enemyPixel(p.enemy3,p.camera.xy,ray,hit.x,uv.y);
  if (e0.a > 0.0) { color=e0.rgb; }
  if (e1.a > 0.0) { color=e1.rgb; }
  if (e2.a > 0.0) { color=e2.rgb; }
  if (e3.a > 0.0) { color=e3.rgb; }

  let attack = p.viewport.z;
  let hand = smoothstep(0.48,0.0,distance(uv,vec2f(0.34,-0.72)));
  color += vec3f(0.15,0.11,0.07) * hand * 0.9;
  if (attack > 0.001) {
    let sweep = mix(-0.95,0.78,attack);
    let bladeLine = abs((uv.y + 0.13) - (uv.x - sweep) * 0.72);
    let blade = smoothstep(0.055,0.008,bladeLine) * smoothstep(1.15,0.20,abs(uv.x-sweep));
    color += vec3f(1.15,0.82,0.36) * blade;
  }
  let vignette = 1.0 - 0.24 * dot(uv,uv);
  return vec4f(color * vignette,1.0);
}
