// Candidate 31 optics, preserved in HDR. Exposure is applied after the original composition.
struct Field {
  resolutionTime: vec4f, pointerProgress: vec4f, climate: vec4f, readingState: vec4f,
  attention: vec4f, structure: vec4f, topology: vec4f, encounterSeed: vec4f,
  readingHabits: vec4f, navigationMemory: vec4f, navigationFlow: vec4f,
  skylightSource: vec4f, skylightOptics: vec4f
}
@group(0) @binding(0) var<uniform> u: Field;
struct Vertex { @builtin(position) position: vec4f }
@vertex fn vertex(@builtin(vertex_index) index:u32)->Vertex {
  let points=array<vec2f,3>(vec2f(-1.,-1.),vec2f(3.,-1.),vec2f(-1.,3.));
  return Vertex(vec4f(points[index],0.,1.));
}
fn hash(p:vec2f)->f32{return fract(sin(dot(p,vec2f(127.1,311.7)))*43758.5453123);}
fn noise(p:vec2f)->f32{
  let i=floor(p);var f=fract(p);f=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2f(1.,0.)),f.x),mix(hash(i+vec2f(0.,1.)),hash(i+vec2f(1.,1.)),f.x),f.y);
}
fn fbm(point:vec2f)->f32{
  var p=point;var f=0.;var a=.5;
  for(var i=0;i<4;i++){f+=a*noise(p);p=mat2x2f(vec2f(1.6,1.2),vec2f(-1.2,1.6))*p+vec2f(3.7);a*=.5;}
  return f;
}
fn rot(a:f32)->mat2x2f{let c=cos(a);let s=sin(a);return mat2x2f(vec2f(c,-s),vec2f(s,c));}
fn roll(x:f32)->f32{if(x<.88){return x;}return .88+.115*(1.-exp(-(x-.88)/.115));}
fn square(x:f32)->f32{return x*x;}
fn profile(across:f32,width:f32)->f32{return exp(-pow(abs(across)/max(.012,width),1.65)*1.5);}
fn glass(uv:vec2f,pixel:vec2f)->vec4f{
  let climate=u.climate;let readingState=u.readingState;let attention=u.attention;let structure=u.structure;
  let topology=u.topology;let encounterSeed=u.encounterSeed;let readingHabits=u.readingHabits;
  let navigationMemory=u.navigationMemory;let navigationFlow=u.navigationFlow;

  var aspect=u.resolutionTime.xy.x/u.resolutionTime.xy.y;
  var p=vec2f(uv.x*aspect,1.-uv.y);
  var t=u.resolutionTime.z;
  var seed=encounterSeed*6.283185;
  var inherited=structure.w*6.283185;
  var immersion=readingState.x;
  var volume=readingState.z;
  var annotation=readingState.w;
  var hover=attention.x;
  var depth=topology.x;
  var density=topology.y;
  var nav=navigationMemory;
  // Slow, independent phases vary the actual emitter geometry, not just brightness.
  var wander=.66*sin(t*.047+seed.x)+.34*sin(t*.019+seed.y);
  var aperture=.5+.5*sin(t*.061+seed.z+.32*sin(t*.013+seed.w));
  var veilPhase=sin(t*.039+seed.w);
  var origin=vec2f(aspect*(1.08+.055*climate.y+.035*sin(seed.x)+.055*wander),
                   -.40+.035*climate.x+.035*sin(t*.033+seed.z));
  var slope=-.64+.10*sin(seed.y)+.115*wander+.043*climate.z
    +.024*nav.x+.015*readingState.y+.018*hover*(attention.z-.5);
  var direction=normalize(vec2f(slope,1.));
  var q=p-origin;
  var along=dot(q,direction);
  var across=dot(q,vec2f(direction.y,-direction.x));
  var angle=across/max(.3,along);
  var width=.042+along*(.10+.055*aperture+.023*immersion+.014*volume+.010*structure.x+.012*nav.y);
  var medium=fbm(vec2f(angle*(6.+structure.y*3.)+t*.052+seed.z,along*.45-t*.042+seed.x));
  var fibres=noise(vec2f(angle*(49.+annotation*35.)-t*.071+seed.y,along*.25+t*.03));
  var weave=.52+.32*medium+.16*fibres;
  var refract=(.012+.014*annotation+.008*depth+.005*nav.z)*sin(along*2.5+medium*2.2+t*.087+inherited);
  var dispersion=.004+.006*annotation+.005*(.5+.5*veilPhase)+.003*readingHabits.w;
  var ray=vec3f(profile(across+refract+dispersion,width*1.025),
                 profile(across+refract,width),profile(across+refract-dispersion,width*.972));
  var broad=profile(across+refract*.4,width*(2.5+.3*readingHabits.z+.2*nav.w));
  var reach=exp(-max(along,0.)*(.22-.04*volume));
  var energy=(ray*weave+vec3f(broad*.28))*reach;
  // Tyndall shafts share one emitter outside the page, without physical bodies or dots.
  for(var i=0;i<4;i++){
    var k=f32(i);
    var gap=-.23+k*.135+.040*sin(t*.043+k*2.1+seed.w);
    gap+=.024*topology.z*sin(k+along*.7)+.018*topology.w*cos(k*1.7);
    var fan=angle-gap-.018*sin(along*1.1+t*.055+seed.z+k);
    var opening=.016+.014*(.5+.5*sin(t*.067+k*2.3+seed.y))+.012*depth;
    var shaft=profile(fan,opening);
    var transmission=.30+.30*(.5+.5*sin(t*.052+k*1.9+seed.x));
    transmission*=.75+.25*cos(along*.6+t*.035+k+structure.z);
    energy+=shaft*reach*transmission*.20*vec3f(.88,.96,1.);
  }
  var sky=exp(-dot(q*vec2f(.75,.68),q*vec2f(.75,.68))*1.7);
  var air=fbm(p*.87+vec2f(t*.016,-t*.019)+seed.zw);
  var col=vec3f(.773,.829,.887)+(air-.45)*vec3f(.024,.028,.037);
  col+=climate.w*vec3f(.007,.002,-.005)+climate.x*vec3f(.004,-.001,.007);
  var irradiance=.84+.10*sin(t*.051+seed.w)+.06*cos(t*.022+seed.y);
  col+=energy*vec3f(.29,.31,.325)*irradiance+sky*vec3f(.078,.09,.11);
  var reflected=vec2f(aspect*(.16+.12*sin(t*.025+seed.z)),.79+.11*cos(t*.029+seed.y));
  var bounce=exp(-dot(p-reflected,p-reflected)*1.8);
  col+=bounce*vec3f(.025,.005,.035)*(1.+.25*readingHabits.x);
  col=vec3f(roll(col.r),roll(col.g),roll(col.b));
  // Refraction sheets cross letter gaps: uneven fronts, not regular ocean waves.
  var flow=rot(-.22+.035*nav.x)*(p-vec2f(aspect*.45,.5));
  flow.y+=.12*sin(flow.x*1.8+t*.092+seed.z)+.05*sin(flow.x*4.2-t*.071+seed.x);
  flow.x+=.035*sin(p.y*2.1+t*.064+seed.w);
  for(var j=0;j<4;j++){
    var k=f32(j);
    var spacing=.25+.022*structure.x;
    var fold=flow.y-(-.48+k*spacing)-.08*sin(flow.x*(2.+k*.12)-t*.097+k*2.1+seed.y);
    fold+=.027*topology.w*sin(flow.x*3.+k)+.017*topology.z*cos(flow.x*1.7-k);
    var opening=.013+.018*(.5+.5*sin(flow.x*2.4+t*.061+k+seed.z))+.006*immersion;
    var crest=exp(-square(fold/opening));
    var skirt=exp(-square((fold-.028)/(.052+.012*depth)));
    var availability=.30+.70*pow(.5+.5*sin(flow.x*2.2+k*1.7-t*.064+seed.w+structure.z),2.);
    availability*=.78+.22*cos(t*.045+seed.x+k+readingHabits.y*.4);
    col+=crest*availability*vec3f(.043,.048,.045);
    col-=skirt*availability*vec3f(.033,.024,.018);
    col+=exp(-square((fold+.014)/.014))*availability*vec3f(.015,-.003,.019);
  }
  var filigree=sin(angle*(91.+density*43.)+medium*3.2+t*.075+seed.x);
  var fine=pow(.5+.5*filigree,7.)*broad*(.4+.6*medium);
  col+=fine*vec3f(.009,.013,.018)*(1.+.18*readingHabits.w);
  var encounter=p.y-attention.w-.075*sin(p.x*1.8-t*.051+seed.x);
  var localAir=exp(-square(encounter/(.11+.075*attention.y)));
  col+=hover*localAir*(.35+.65*broad)*vec3f(.025,.027,.031);
  col+=hover*localAir*attention.y*vec3f(.012,-.002,.016);
  // Immediate scrolling is weak. Its smoothed history controls the broader geometry above.
  col+=navigationFlow.y*broad*vec3f(.002,.003,.004);
  col+=navigationFlow.z*vec3f(.002,-.001,.003);
  col+=navigationFlow.x*ray*vec3f(.001,.002,.003);
  col+=(navigationFlow.w-.5)*bounce*vec3f(.004,.001,.005);
  var cursor=vec2f(u.pointerProgress.xy.x*aspect,1.-u.pointerProgress.xy.y);
  col+=exp(-dot(p-cursor,p-cursor)*35.)*vec3f(.004,.007,.009);
  col+=(hash(pixel)-.5)/560.;
  return vec4f(clamp(col,vec3f(.765,.807,.868),vec3f(.995)),dot(energy,vec3f(.2126,.7152,.0722))*irradiance);

}
@fragment fn fragment(v:Vertex)->@location(0)vec4f{
  let pixel=vec2f(v.position.x,u.resolutionTime.y-v.position.y);
  let field=glass(pixel/u.resolutionTime.xy,pixel);
  // The original blue-violet air keeps its SDR luminance. Only the incoming light
  // gains headroom; this must never turn the entire reading room into a white sheet.
  let high=smoothstep(.12,.85,field.a);
  let gain=pow(1.+1.3*high*high,1./2.4);
  return vec4f((field.rgb+.055)*gain-.055,1.);
}
