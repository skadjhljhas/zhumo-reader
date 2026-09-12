precision highp float;
uniform sampler2D previous;
uniform vec2 grid;
uniform vec4 stroke;
uniform float force;

float distanceToStroke(vec2 p, vec2 a, vec2 b) {
  vec2 delta=b-a;
  float t=clamp(dot(p-a,delta)/max(dot(delta,delta),.0001),0.,1.);
  return length(p-a-t*delta);
}
void main() {
  vec2 uv=gl_FragCoord.xy/grid;
  vec2 e=1./grid;
  vec4 center=texture2D(previous,uv);
  vec4 north=texture2D(previous,clamp(uv+vec2(0,e.y),e*.5,1.-e*.5));
  vec4 south=texture2D(previous,clamp(uv-vec2(0,e.y),e*.5,1.-e*.5));
  vec4 east=texture2D(previous,clamp(uv+vec2(e.x,0),e*.5,1.-e*.5));
  vec4 west=texture2D(previous,clamp(uv-vec2(e.x,0),e*.5,1.-e*.5));
  float laplacian=north.r+south.r+east.r+west.r-4.*center.r;
  float velocity=(center.g+laplacian*.22)*.991;
  float distance=distanceToStroke(gl_FragCoord.xy,stroke.xy*grid,stroke.zw*grid);
  float core=exp(-distance*distance/9.);
  float shoulder=exp(-distance*distance/36.);
  float strokeLength=length((stroke.zw-stroke.xy)*grid);
  // The broad negative shoulder offsets displaced water instead of steadily
  // adding a mound under every passage. Capsule integrals set its weight.
  float balance=(strokeLength+2.65868)/(2.*strokeLength+10.63472);
  float pressure=(core-shoulder*balance)*force;
  velocity+=pressure*.0035;
  float border=min(min(gl_FragCoord.x,grid.x-gl_FragCoord.x),min(gl_FragCoord.y,grid.y-gl_FragCoord.y));
  float absorb=mix(.76,1.,smoothstep(0.,16.,border));
  velocity=clamp(velocity*absorb,-.08,.08);
  float height=clamp((center.r+velocity)*.998*absorb,-.15,.15);
  float neighbors=(north.b+south.b+east.b+west.b)*.25;
  float residue=clamp(mix(center.b,neighbors,.16)*.986+core*force*.22,0.,1.);
  gl_FragColor=vec4(height,velocity,residue,1.);
}
