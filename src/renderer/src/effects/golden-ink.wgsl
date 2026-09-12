// Gold lives inside the measured letter silhouette. The narrow glints illuminate
// nearby air, without a rectangular highlight or a shaft projected out of the line.
struct Light { size: vec4f, motion: vec4f }
@group(0) @binding(0) var letters: texture_2d<f32>;
@group(0) @binding(1) var filtering: sampler;
@group(0) @binding(2) var<uniform> u: Light;
struct Vertex { @builtin(position) position: vec4f, @location(0) uv: vec2f }
@vertex fn vertex(@builtin(vertex_index) i:u32)->Vertex {
  let points=array<vec2f,3>(vec2f(-1.,-1.),vec2f(3.,-1.),vec2f(-1.,3.));
  let p=points[i];return Vertex(vec4f(p,0.,1.),vec2f(p.x*.5+.5,.5-p.y*.5));
}
fn alpha(p:vec2f)->f32 { return textureSampleLevel(letters,filtering,p/u.size.xy,0.).a; }
fn glint(p:vec2f)->f32 {
  let t=u.motion.x;
  let ripple=sin(p.x*.080+p.y*.13-t*.68+.26*sin(p.x*.032+t*.24));
  let ridge=exp(-37.*ripple*ripple);
  let travelling=.35+.65*pow(.5+.5*sin(p.x*.017-t*.34),3.);
  return ridge*travelling;
}
@fragment fn fragment(v:Vertex)->@location(0)vec4f {
  let p=v.uv*u.size.xy;let a=alpha(p);
  let t=u.motion.x;let shine=glint(p);
  let foil=.5+.5*sin(p.y*.20+p.x*.022-t*.22+.28*sin(p.x*.035+t*.21));
  var gold=mix(vec3f(.48,.255,.055),vec3f(.89,.61,.16),smoothstep(.12,.72,foil));
  gold=mix(gold,vec3f(1.,.90,.57),shine*.82);
  var near=0.;var air=0.;
  for(var i=0;i<8;i++) {
    let theta=f32(i)*.785398;
    let direction=vec2f(cos(theta),sin(theta));
    let q=p+direction*2.2;
    near+=alpha(q)*(.20+.80*glint(q))*.125;
    let far=p+direction*7.5;
    air+=alpha(far)*(.10+.90*glint(far))*.125;
  }
  let strength=u.motion.y*u.motion.z;
  let outside=1.-a;
  let glow=(near*.34+air*.12)*outside;
  let coverage=clamp((a*.97+glow)*strength,0.,1.);
  if(coverage<.001){discard;}
  let hdr=u.motion.w;
  let peak=mix(1.,2.65,hdr);
  gold+=vec3f(1.,.88,.48)*shine*hdr*1.4;
  let color=(gold*a*.97+vec3f(1.,.79,.29)*glow*peak)*strength;
  return vec4f(color,coverage);
}
