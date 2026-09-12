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
// 琉璃：画外有一个看不见的发射体。每一处停留是它的光在空气中的一次聚焦，边缘有极细的色散。
void main(){
  vec2 uv=gl_FragCoord.xy/resolution;
  uv.y=1.-uv.y;
  float aspect=resolution.x/resolution.y;
  vec2 p=vec2(uv.x*aspect,uv.y);
  float t=time;
  vec2 emitter=vec2(aspect*(1.20+.05*sin(t*.041+seed.x*6.283)+.03*climate.y),
                    -.32+.05*cos(t*.029+seed.y*6.283)+.03*climate.x+.05*flow.x);
  float aperture=.5+.5*sin(t*(.045+.012*seed.z)+seed.w*6.283);   // where the unseen light rests now
  float opening=.22+.10*flow.y+.06*habits.w;                        // scrolling widens it, slowly
  vec3 cool=vec3(.93,.96,1.), warm=vec3(1.,.95,.86), night=vec3(.88,.90,1.);
  vec3 violet=vec3(.66,.58,.88), cyan=vec3(.58,.86,.90);
  float nowDay=.5-.5*climate.w; // cos(local day) is +1 at midnight, -1 at noon
  vec3 col=vec3(0.); float alpha=0.;
  // Air in the fan: barely there, but it moves, so the empty field is never a blank panel.
  vec2 q=p-emitter; float dist=length(q); vec2 dir=q/max(dist,.0001);
  float ang=atan(q.y,q.x);
  float air=.03*(.5+.5*sin(ang*(7.+4.*habits.y)+t*.05+seed.x*6.283))*exp(-dist*.55)*(.6+.4*habits.w);
  // A refraction front drifting across the fan every half minute or so.
  float sweep=fract(t*.021+seed.z);
  float front=exp(-pow((dot(p,vec2(.8,.6))-(-.2+1.6*sweep))/.025,2.))*.05*exp(-dist*.4);
  col+=mix(night,cool,nowDay)*(air+front); alpha+=air+front;
  for(int i=0;i<160;i++){
    if(float(i)>=count) break;
    vec4 A=starA(i), B=starB(i), C=starC(i);
    float x=A.x, y=A.y, mag=A.z, warmth=A.w;
    float phase=B.x*6.2831853, depth=B.y, age=B.z, hour=B.w;
    float breadth=C.x, sharp=C.y, visits=C.z, kind=C.w;
    float gain=gainFor(i);
    vec2 s=vec2(x*aspect,y);
    vec2 qs=s-emitter; float ds=length(qs); vec2 d=qs/max(ds,.0001);
    vec2 r=p-s;
    float along=dot(r,d), across=dot(r,vec2(d.y,-d.x));
    // Stops brighten in turn as the aperture passes their place in the reading order.
    float lit=.55+.45*exp(-pow((x-aperture)/opening,2.));
    lit*=.9+.1*sin(t*.23+phase);
    // Short caustic strokes, each pointing at the emitter; never one continuous beam.
    float la=(.028+.065*mag)*(1.+.25*age);
    float wc=(.007+.010*visits+.006*breadth)*(1.+.35*age)*(1.-.3*sharp*(1.-age));
    float disp=.0028+.004*flow.z+.002*habits.y+.001*kind+.002*annotation;
    float core=exp(-pow(along/la,2.));
    float g=exp(-pow(across/wc,2.));
    float rC=exp(-pow((across+disp)/wc,2.));
    float bC=exp(-pow((across-disp)/wc,2.));
    float halo=exp(-(along*along+across*across)/(.0022+.005*breadth+.005*age))*.3;
    // The small rail field may glow a little harder than the ledger's larger one.
    float body=mag*gain*lit*(1.-.35*age)*(1.-.15*depth)*(1.+.3*focus.z);
    vec3 tint=mix(mix(night,cool,dayness(hour)),warm,.6*warmth);
    float centre=g*core*body*.7;
    float vio=max(rC-g,0.)*core*body*.55;
    float cya=max(bC-g,0.)*core*body*.55;
    float soft=halo*body;
    col+=tint*(centre+soft)+violet*vio+cyan*cya;
    alpha+=centre+soft+vio+cya;
  }
  // The focus that is forming now, before it has an address.
  if(live.z>0.001){
    vec2 s=vec2(live.x*aspect,live.y);
    vec2 qs=s-emitter; vec2 d=qs/max(length(qs),.0001);
    vec2 r=p-s;
    float along=dot(r,d), across=dot(r,vec2(d.y,-d.x));
    float core=exp(-pow(along/(.03+.06*live.z),2.));
    float wc=.012+.006*live.w;
    float g=exp(-pow(across/wc,2.));
    float disp=.003+.002*live.w;
    float rC=exp(-pow((across+disp)/wc,2.)), bC=exp(-pow((across-disp)/wc,2.));
    vec3 tint=mix(cool,warm,live.z);
    float centre=g*core*live.z*.6, vio=max(rC-g,0.)*core*live.z*.5, cya=max(bC-g,0.)*core*live.z*.5;
    col+=tint*centre+violet*vio+cyan*cya; alpha+=centre+vio+cya;
  }
  float fade=edgeFade(uv);
  float a=knee(alpha)*fade;
  vec3 c=alpha>0.?col/alpha:vec3(0.);
  gl_FragColor=vec4(c*a,a);
}
