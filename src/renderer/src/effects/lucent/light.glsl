// Lucent flagship: an unseen emitter and continuously changing refractive air.
float lucentRoll(float x){return x<.88?x:.88+.115*(1.-exp(-(x-.88)/.115));}
vec3 lucentRoll(vec3 x){return vec3(lucentRoll(x.r),lucentRoll(x.g),lucentRoll(x.b));}
float lucentProfile(float across,float width){return exp(-pow(abs(across)/max(.012,width),1.65)*1.5);}
vec3 glass(vec2 uv){
  float aspect=resolution.x/resolution.y;
  vec2 p=vec2(uv.x*aspect,1.-uv.y);
  float t=time;
  vec4 seed=encounterSeed*6.283185;
  float inherited=structure.w*6.283185;
  float immersion=readingState.x,volume=readingState.z,annotation=readingState.w;
  float hover=attention.x,depth=topology.x,density=topology.y;
  vec4 nav=navigationMemory;
  // Slow, independent phases vary the actual emitter geometry, not just brightness.
  float wander=.66*sin(t*.047+seed.x)+.34*sin(t*.019+seed.y);
  float aperture=.5+.5*sin(t*.061+seed.z+.32*sin(t*.013+seed.w));
  float veilPhase=sin(t*.039+seed.w);
  vec2 origin=vec2(aspect*(1.08+.055*climate.y+.035*sin(seed.x)+.055*wander),
                   -.40+.035*climate.x+.035*sin(t*.033+seed.z));
  float slope=-.64+.10*sin(seed.y)+.115*wander+.043*climate.z
    +.024*nav.x+.015*readingState.y+.018*hover*(attention.z-.5);
  vec2 direction=normalize(vec2(slope,1.));
  vec2 q=p-origin;
  float along=dot(q,direction),across=dot(q,vec2(direction.y,-direction.x));
  float angle=across/max(.3,along);
  float width=.042+along*(.10+.055*aperture+.023*immersion+.014*volume+.010*structure.x+.012*nav.y);
  float medium=fbm(vec2(angle*(6.+structure.y*3.)+t*.052+seed.z,along*.45-t*.042+seed.x));
  float fibres=noise(vec2(angle*(49.+annotation*35.)-t*.071+seed.y,along*.25+t*.03));
  float weave=.52+.32*medium+.16*fibres;
  float refract=(.012+.014*annotation+.008*depth+.005*nav.z)*sin(along*2.5+medium*2.2+t*.087+inherited);
  float dispersion=.004+.006*annotation+.005*(.5+.5*veilPhase)+.003*readingHabits.w;
  vec3 ray=vec3(lucentProfile(across+refract+dispersion,width*1.025),
                 lucentProfile(across+refract,width),lucentProfile(across+refract-dispersion,width*.972));
  float broad=lucentProfile(across+refract*.4,width*(2.5+.3*readingHabits.z+.2*nav.w));
  float reach=exp(-max(along,0.)*(.22-.04*volume));
  vec3 energy=(ray*weave+vec3(broad*.28))*reach;
  // Tyndall shafts share one emitter outside the page, without physical bodies or dots.
  for(int i=0;i<4;i++){
    float k=float(i);
    float gap=-.23+k*.135+.040*sin(t*.043+k*2.1+seed.w);
    gap+=.024*topology.z*sin(k+along*.7)+.018*topology.w*cos(k*1.7);
    float fan=angle-gap-.018*sin(along*1.1+t*.055+seed.z+k);
    float opening=.016+.014*(.5+.5*sin(t*.067+k*2.3+seed.y))+.012*depth;
    float shaft=lucentProfile(fan,opening);
    float transmission=.30+.30*(.5+.5*sin(t*.052+k*1.9+seed.x));
    transmission*=.75+.25*cos(along*.6+t*.035+k+structure.z);
    energy+=shaft*reach*transmission*.20*vec3(.88,.96,1.);
  }
  float sky=exp(-dot(q*vec2(.75,.68),q*vec2(.75,.68))*1.7);
  float air=fbm(p*.87+vec2(t*.016,-t*.019)+seed.zw);
  vec3 col=vec3(.773,.829,.887)+(air-.45)*vec3(.024,.028,.037);
  col+=climate.w*vec3(.007,.002,-.005)+climate.x*vec3(.004,-.001,.007);
  float irradiance=.84+.10*sin(t*.051+seed.w)+.06*cos(t*.022+seed.y);
  col+=energy*vec3(.29,.31,.325)*irradiance+sky*vec3(.078,.09,.11);
  vec2 reflected=vec2(aspect*(.16+.12*sin(t*.025+seed.z)),.79+.11*cos(t*.029+seed.y));
  float bounce=exp(-dot(p-reflected,p-reflected)*1.8);
  col+=bounce*vec3(.025,.005,.035)*(1.+.25*readingHabits.x);
  col=lucentRoll(col);
  // Refraction sheets cross letter gaps: uneven fronts, not regular ocean waves.
  vec2 flow=rot(-.22+.035*nav.x)*(p-vec2(aspect*.45,.5));
  flow.y+=.12*sin(flow.x*1.8+t*.092+seed.z)+.05*sin(flow.x*4.2-t*.071+seed.x);
  flow.x+=.035*sin(p.y*2.1+t*.064+seed.w);
  for(int j=0;j<4;j++){
    float k=float(j);
    float spacing=.25+.022*structure.x;
    float fold=flow.y-(-.48+k*spacing)-.08*sin(flow.x*(2.+k*.12)-t*.097+k*2.1+seed.y);
    fold+=.027*topology.w*sin(flow.x*3.+k)+.017*topology.z*cos(flow.x*1.7-k);
    float opening=.013+.018*(.5+.5*sin(flow.x*2.4+t*.061+k+seed.z))+.006*immersion;
    float crest=exp(-pow(fold/opening,2.));
    float skirt=exp(-pow((fold-.028)/(.052+.012*depth),2.));
    float availability=.30+.70*pow(.5+.5*sin(flow.x*2.2+k*1.7-t*.064+seed.w+structure.z),2.);
    availability*=.78+.22*cos(t*.045+seed.x+k+readingHabits.y*.4);
    col+=crest*availability*vec3(.043,.048,.045);
    col-=skirt*availability*vec3(.033,.024,.018);
    col+=exp(-pow((fold+.014)/.014,2.))*availability*vec3(.015,-.003,.019);
  }
  float filigree=sin(angle*(91.+density*43.)+medium*3.2+t*.075+seed.x);
  float fine=pow(.5+.5*filigree,7.)*broad*(.4+.6*medium);
  col+=fine*vec3(.009,.013,.018)*(1.+.18*readingHabits.w);
  float encounter=p.y-attention.w-.075*sin(p.x*1.8-t*.051+seed.x);
  float localAir=exp(-pow(encounter/(.11+.075*attention.y),2.));
  col+=hover*localAir*(.35+.65*broad)*vec3(.025,.027,.031);
  col+=hover*localAir*attention.y*vec3(.012,-.002,.016);
  // Immediate scrolling is weak. Its smoothed history controls the broader geometry above.
  col+=navigationFlow.y*broad*vec3(.002,.003,.004);
  col+=navigationFlow.z*vec3(.002,-.001,.003);
  col+=navigationFlow.x*ray*vec3(.001,.002,.003);
  col+=(navigationFlow.w-.5)*bounce*vec3(.004,.001,.005);
  vec2 cursor=vec2(pointer.x*aspect,1.-pointer.y);
  col+=exp(-dot(p-cursor,p-cursor)*35.)*vec3(.004,.007,.009);
  col+=(hash(gl_FragCoord.xy)-.5)/560.;
  return clamp(col,vec3(.765,.807,.868),vec3(.995));
}
