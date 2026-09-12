struct Scene { screen: vec4f, clip: vec4f, mask: vec4f, sky: vec4f, light: vec4f, wave: vec4f, attention: vec4f }
@group(0) @binding(0) var<uniform> u: Scene;
@group(0) @binding(1) var letters: texture_2d<f32>;
@group(0) @binding(2) var filtering: sampler;
struct Vertex { @builtin(position) position: vec4f, @location(0) world: vec2f }
@vertex fn vertex(@builtin(vertex_index) index:u32) -> Vertex {
  let points=array<vec2f,6>(vec2f(0.,0.),vec2f(1.,0.),vec2f(0.,1.),vec2f(0.,1.),vec2f(1.,0.),vec2f(1.,1.));
  let world=u.clip.xy+points[index]*u.clip.zw;
  let p=world/u.screen.xy;
  return Vertex(vec4f(p.x*2.-1.,1.-p.y*2.,0.,1.),world);
}
fn alphaAt(p:vec2f)->f32 {
  let uv=(p-u.mask.xy)/u.mask.zw;
  if(any(uv<vec2f(0.))||any(uv>vec2f(1.))){return 0.;}
  return textureSampleLevel(letters,filtering,uv,0.).a;
}
fn caustic(p:vec2f)->f32 {
  let t=u.screen.z;
  let flow=p.x*.02831+p.y*.0367+.68*sin(p.x*.011-t*.17)+.43*sin(p.y*.013+t*.12)+.28*sin((p.x+p.y)*.01873+t*.071)+u.light.y;
  let ridge=exp(-32.*pow(sin(flow-t*.23),2.));
  let second=exp(-55.*pow(sin(flow*.79+p.x*.008+t*.09+1.2),2.));
  return min(1.2,ridge*.94+second*.52);
}
fn reflection(p:vec2f)->f32 {let alpha=alphaAt(p);if(alpha<.01){return 0.;}return alpha*caustic(p);}
fn softened(p:vec2f,radius:f32)->f32 {
  let uv=(p-u.mask.xy)/u.mask.zw;
  if(any(uv<vec2f(0.))||any(uv>vec2f(1.))){return 0.;}
  let scale=f32(textureDimensions(letters).x)/u.mask.z;
  return textureSampleLevel(letters,filtering,uv,clamp(log2(radius*scale),0.,4.)).a;
}
fn illumination(p:vec2f)->f32 {
  let origin=u.sky.xy/u.screen.y;let aim=u.sky.zw/u.screen.y;let q=p/u.screen.y-origin;
  let focal=length(aim-origin);let direction=normalize(aim-origin);
  let along=dot(q,direction);let across=dot(q,vec2f(direction.y,-direction.x));
  let footprint=max(.45,along/max(.5,focal));
  var light=0.;
  for(var i=0u;i<2u;i++){
    let k=f32(i);let gap=(-.12+k*.40+.028*sin(u.screen.z*.009+k*2.1+u.light.y))*footprint;
    let fan=across-gap-.028*sin((along-focal)*1.1+u.screen.z*.009+u.wave.x+k);
    let opening=(.15+.035*(.5+.5*sin(u.screen.z*.011+k*2.3+u.wave.y))+.012*u.wave.z)*footprint;
    light+=exp(-1.5*pow(abs(fan)/opening,1.65))*select(.38,.86,i==0u);
  }
  let attention=1.+.16*u.attention.x*exp(-dot(p-u.attention.zw,p-u.attention.zw)/62500.);
  return clamp(light*u.light.x*attention,0.,1.);
}
@fragment fn fragment(input:Vertex)->@location(0)vec4f {
  let p=input.world;let strength=illumination(p);
  if(strength<.025){discard;}
  let ink=alphaAt(p);let towards=normalize(u.sky.xy-p);
  let outside=(1.-ink)*(1.-ink);
  let core=reflection(p-towards*1.05)*outside;
  let wave=caustic(p);
  let near=softened(p,1.8)*wave*outside;
  let halo=softened(p,6.)*wave*outside;
  let close=near*.60;let spread=halo*1.20;
  let energy=(core*.80+close+spread)*strength;
  let alpha=clamp(energy*select(1.,.40,u.screen.w>.5),0.,.85);
  if(alpha<.001){discard;}
  let temperature=clamp(u.light.z*.25+.04*sin(u.screen.z*.014+u.light.y),-.2,.2);
  let cool=vec3f(2.55,2.88,3.15)+temperature*vec3f(.6,.05,-.6);let warm=vec3f(3.05,2.76,2.25);let violet=vec3f(2.62,2.47,3.12);
  var color=(cool*core*.80+warm*close+violet*spread)*strength;
  if(u.screen.w<.5){color=(vec3f(1.,.995,.96)*core*.80+vec3f(1.,.94,.82)*close+vec3f(.86,.94,1.)*spread)*strength*min(1.,.85/max(.001,energy));}
  return vec4f(color,alpha);
}
