precision highp float;
uniform vec2 resolution;
uniform vec2 pointer;
uniform float time;
uniform float chosen;
uniform float density;
/* CAUSTIC_LIGHT */
void main() {
  vec2 uv=gl_FragCoord.xy/resolution;
  vec2 p=(uv-.5)*vec2(resolution.x/resolution.y,1.)*2.35;
  p+=pointer*vec2(.018,.024);
  vec4 light=causticLight(p,time,chosen,density);
  light.a*=smoothstep(0.,.15,uv.y)*(1.-smoothstep(.85,1.,uv.y));
  gl_FragColor=light;
}
