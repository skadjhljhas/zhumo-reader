precision highp float;
uniform vec2 resolution;
uniform vec2 pointer;
uniform vec4 hero;
uniform vec4 reader;
uniform vec4 ripples[8];
uniform float time;
uniform float progress;
uniform float depth;
uniform float presence;
uniform sampler2D heightField;
uniform vec2 fieldSize;
uniform float hasField;
uniform vec4 navigationFlow;

const float PI = 3.14159265359;
mat2 turn(float a) { float c=cos(a),s=sin(a); return mat2(c,-s,s,c); }
float hash(vec2 p) { return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453123); }
float noise(vec2 p) {
  vec2 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
}
float land(vec2 p) {
  float value=0.0, weight=.5;
  for(int i=0;i<4;i++) {
    value+=weight*noise(p);
    p=mat2(1.62,1.18,-1.18,1.62)*p+2.8;
    weight*=.5;
  }
  return value;
}
float wake(vec2 p) {
  float value=0.0;
  for(int i=0;i<8;i++) {
    float age=time-ripples[i].z;
    if(age<0. || age>8.) continue;
    vec2 delta=p-ripples[i].xy;
    delta.x*=resolution.x/resolution.y;
    float radius=length(delta);
    float envelope=exp(-age*.65)*exp(-pow((radius-age*.062)*20.,2.));
    value+=sin(radius*110.-age*5.5)*envelope*ripples[i].w*.014*step(0.,age);
  }
  return value;
}
vec3 field(vec2 uv) {
  vec2 q=uv*fieldSize-.5;
  vec2 base=(floor(q)+.5)/fieldSize, f=fract(q), e=1./fieldSize;
  vec3 a=texture2D(heightField,base).rgb;
  vec3 b=texture2D(heightField,base+vec2(e.x,0)).rgb;
  vec3 c=texture2D(heightField,base+vec2(0,e.y)).rgb;
  vec3 d=texture2D(heightField,base+e).rgb;
  return mix(mix(a,b,f.x),mix(c,d,f.x),f.y)*hasField;
}
float tide(vec2 uv) {
  vec2 p=uv*vec2(resolution.x/resolution.y,1.);
  float a=land(p*2.4+vec2(time*.006,-time*.003));
  float b=land(p*5.3+vec2(a*.7,time*.004));
  return uv.y-.29-.20*sin(uv.x*3.8+.4)+a*.29+b*.05
    +(hasField>.5 ? field(uv).r*.48 : wake(uv))+progress*.05;
}
/* OCEAN */
vec3 water(vec2 uv) {
  float aspect=resolution.x/resolution.y;
  vec2 p=vec2(uv.x*aspect,1.-uv.y);
  float air=land(p*.85+vec2(time*.001,-time*.002));
  vec3 col=mix(vec3(.060,.115,.205),vec3(.075,.150,.270),smoothstep(0.,1.,p.y));
  col+=air*vec3(.018,.030,.045);
  vec2 offscreen=p-vec2(aspect*.88,-.48);
  float moon=exp(-pow(offscreen.x/(.55+offscreen.y*.48),2.))*exp(-offscreen.y*.44);
  col+=moon*vec3(.055,.085,.120);
  float openAir=exp(-pow((p.x-aspect*.28)/.75,2.)-pow((p.y-.25)/.70,2.));
  col+=openAir*vec3(.025,.043,.067);
  float disturbance=hasField>.5?field(uv).r*.19:wake(uv)*.5;
  vec2 sea=p;
  sea.y+=disturbance;
  float phase=oceanPhase(sea,time,.16+.045*navigationFlow.y,.7);
  float swell=oceanCrest(phase);
  float sheen=pow(clamp(.5+.5*cos(phase-.38),0.,1.),17.);
  float broken=.46+.54*pow(clamp(.5+.5*sin(p.x*10.4+phase*.43-time*.068),0.,1.),3.);
  col+=swell*vec3(.030,.060,.100);
  col+=sheen*(.42+moon)*broken*vec3(.060,.085,.115)*(1.+navigationFlow.z*.06);
  float farther=oceanPhase(vec2(p.x*.85,p.y*1.34+.2),time*.74,.24,2.1);
  float distant=oceanCrest(farther);
  col+=distant*vec3(.020,.037,.060);
  float crossing=exp(-pow((p.x-aspect*.56-.16*sin(p.y*2.1-time*.018))/.30,2.));
  col+=crossing*(.35+.65*distant)*vec3(.018,.029,.043);
  float sun=exp(-pow((p.x-aspect*.11)/.44,2.)-pow((p.y-.86)/.40,2.));
  col+=sun*swell*vec3(.019,.011,.003);
  // Broad, unbroken reflected light replaces isolated spark points.
  float silver=pow(clamp(.5+.5*cos(phase*.73+p.x*.82+sin(time*.016)*.12),0.,1.),14.);
  col+=silver*moon*vec3(.018,.033,.052);
  col+=swell*navigationFlow.x*vec3(.004,.002,-.002);
  vec3 memory=field(uv);
  vec2 texel=1./fieldSize;
  vec2 gradient=vec2(field(uv+vec2(texel.x,0)).r-field(uv-vec2(texel.x,0)).r,
    field(uv+vec2(0,texel.y)).r-field(uv-vec2(0,texel.y)).r);
  float crest=smoothstep(.001,.008,length(gradient));
  col+=crest*vec3(.008,.019,.037);
  float lingering=pow(clamp(memory.b,0.,1.),.65);
  col+=lingering*vec3(.009,.018,.032);
  return col;
}

/* CAUSTIC_LIGHT */
void main() {
  vec2 uv=gl_FragCoord.xy/resolution;
  vec3 col=water(uv);
  // The whole field has readable luminance; no opaque island follows the text column.
  // The title's individual light is rendered by ManuscriptLight, not a fixed hero formula.
  vec2 near=uv-pointer;
  near.x*=resolution.x/resolution.y;
  float halo=exp(-dot(near,near)*130.)*presence;
  col+=halo*vec3(.009,.017,.030);
  // A soft highlight shoulder protects moon-white ink across the entire field,
  // without flattening the text column or cutting off the chromatic gradients.
  float luminance=dot(pow(max(col,vec3(0.)),vec3(2.2)),vec3(.2126,.7152,.0722));
  float mapped=luminance<.10?luminance:.10+.023*(1.-exp(-(luminance-.10)/.023));
  col*=pow(mapped/max(luminance,.00001),1./2.2);
  float grain=(hash(gl_FragCoord.xy)-.5)*.0025;
  gl_FragColor=vec4(clamp(col+grain,0.,1.),1.);
}
