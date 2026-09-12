precision highp float;
uniform vec2 resolution;
uniform float time;
uniform float count;
uniform float rows;
uniform sampler2D stars;
uniform vec4 habits;   // textShare, switches, reversals, immersion
uniform vec4 flow;     // scroll direction, activity, return impulse, textShare
uniform vec4 climate;  // sin/cos solar longitude, sin/cos local day
uniform vec4 seed;
uniform vec4 live;     // x, y, strength, revisits
uniform vec4 focus;    // selected, hovered, compact, volume
uniform float annotation;
/* ECHO_COMMON */
// 潮光：每一处停留是一颗星在夜海上的倒影。水在动，光随水而动。
void main(){
  vec2 uv=gl_FragCoord.xy/resolution;
  uv.y=1.-uv.y;
  float aspect=resolution.x/resolution.y;
  float t=time;
  float horizon=.22+.10*focus.w;
  vec3 moon=vec3(.84,.91,1.), sun=vec3(1.,.90,.70);
  float nowDay=.5-.5*climate.w;                 // midnight is cool, noon is warm
  vec3 ambientTint=mix(moon,sun,.35*nowDay);
  float swell=.0025+.009*flow.y;                 // scrolling roughens the water, then it settles
  float wind=flow.x;                             // and leans the swell one way for a while
  float complexity=.6+.6*habits.y;
  vec3 col=vec3(0.); float alpha=0.;
  // The sea itself: almost nothing, a breathing sheen that knows the hour.
  float below=smoothstep(horizon-.02,horizon+.28,uv.y);
  float long1=sin(uv.x*2.6*aspect+uv.y*2.2+t*.09+seed.x*6.283);
  float long2=sin(uv.x*4.9*aspect-uv.y*3.6-t*.06+seed.y*6.283);
  float sheen=below*(.007+.008*habits.w)*(.6+.28*long1+.12*long2*complexity);
  col+=ambientTint*sheen; alpha+=sheen;
  for(int i=0;i<160;i++){
    if(float(i)>=count) break;
    vec4 A=starA(i), B=starB(i), C=starC(i);
    float x=A.x, y0=A.y, mag=A.z, warmth=A.w;
    float phase=B.x*6.2831853, depth=B.y, age=B.z, hour=B.w;
    float breadth=C.x, sharp=C.y, visits=C.z, kind=C.w;
    float gain=gainFor(i);
    float near=clamp((uv.y-horizon)/.5,.12,1.);
    float len=.07+.30*mag;
    float dy=uv.y-y0;
    float vertical=dy>0.?exp(-dy/len*1.9):exp(-dy*dy/.0004);
    // A gentle lean, not a squiggle: the swell is long and slow.
    float wave=swell*near*(sin(uv.y*13.+t*.27+phase)+.4*sin(uv.y*23.-t*.19*complexity+phase*1.7))
      +wind*.008*near*sin(uv.y*7.+t*.11+seed.z*6.283);
    float width=(.009+.014*visits+.007*breadth)*near*(1.+.3*(gain-1.));
    float dx=(uv.x-x-wave)*aspect;
    float across=exp(-dx*dx/(width*width));
    // Glitter: the reflection breaks into drifting dashes; a steadier reader leaves a steadier one.
    float bands=pow(.5+.5*sin(uv.y*(70.+40.*sharp)-t*(.5+.25*kind)+phase),2.5+2.*(1.-sharp));
    float glitter=mix(1.,.28+.72*bands,.85*near);
    float body=across*vertical*glitter*mag*gain*(1.-.6*age)*(1.+.25*focus.z)*(1.1-.15*annotation);
    body*=1.+flow.z*age*.7;                      // turning back relights older reflections for a moment
    vec3 tint=mix(moon,sun,clamp(.55*warmth+.45*dayness(hour),0.,1.));
    col+=tint*body*.5; alpha+=body*.5;
    // A bright stop also keeps its star above the water.
    if(mag>.5){
      vec2 sp=vec2(x,horizon-.03-.10*depth);
      vec2 d=(uv-sp)*vec2(aspect,1.);
      float s=exp(-dot(d,d)/(.00003+.00004*(mag-.5)))*(mag-.5)*1.5*gain*(.85+.30*annotation);
      col+=tint*s; alpha+=s;
    }
  }
  // The stop that is forming right now: a reflection not yet anchored, moonlight walking toward sun.
  if(live.z>0.001){
    float near=clamp((uv.y-horizon)/.5,.12,1.);
    float dy=uv.y-live.y;
    float vertical=dy>0.?exp(-dy/(.06+.24*live.z)*1.9):exp(-dy*dy/.0005);
    float wave=swell*near*sin(uv.y*13.+t*.27+seed.w*6.283);
    float width=(.014+.010*live.w)*near;
    float dx=(uv.x-live.x-wave)*aspect;
    float body=exp(-dx*dx/(width*width))*vertical*live.z*.75;
    vec3 tint=mix(moon,sun,live.z);
    col+=tint*body; alpha+=body;
  }
  float fade=edgeFade(uv);
  float a=knee(alpha)*fade;
  vec3 c=alpha>0.?col/alpha:vec3(0.);
  gl_FragColor=vec4(c*a,a);
}
