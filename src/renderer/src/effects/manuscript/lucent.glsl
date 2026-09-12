// Light moves THROUGH a slowly refracting opening. Brightness travels along it;
// the whole ornament does not wag back and forth as one rigid ribbon.
vec4 lucentMotion(vec2 p){
  float volume=structure.x,notes=sqrt(structure.y),depth=structure.z;
  float phase=encounter.y*6.28318;
  float tilt=.36+(encounter.x-.5)*.18+season.x*.025+season.z*.01;
  p=mat2(cos(tilt),-sin(tilt),sin(tilt),cos(tilt))*p;
  p.x/=.80+volume*.36;
  float u=p.x;
  float manuscript=moment(u*1.5+.7);
  float carrier=.08*sin(u*1.7+phase)+(.04+.10*notes)*manuscript;
  carrier+=.022*sin(u*2.1-time*.06+encounter.w*6.28);
  float opening=.08+structure.w*.06+(.10+notes*.15+depth*.09)*(.5+.5*sin(u*1.3+phase*.4));
  float count=3.2+volume*1.3+notes*2.5+depth*1.6+detail.z*1.2;
  vec3 pigment=vec3(0.);float energy=0.;
  float aperture=exp(-pow(abs(u)/(.84+volume*.44),4.));
  for(int i=0;i<10;i++){
    float order=float(i);
    float weight=1.-smoothstep(count-.8,count+.8,order);
    float lane=(order-(count-1.)*.5)/max(1.,count*.5);
    // Trigonometric offsets stay continuous and are independent of animation time.
    lane+=.045*sin(order*2.39+encounter.z*6.28);
    float path=carrier+lane*opening;
    path+=(.012+depth*.064+detail.y*.05)*sin(u*(2.2+detail.y*.9)+lane*2.2+phase);
    float distance=p.y-path;
    float travel=u*(3.2+detail.x*.5)-time*(.47+order*.014)+phase+order*1.14;
    float pulse=.5+.5*sin(travel);
    pulse=.20+.80*pulse*pulse;
    float spread=.009+.003*sin(order*1.7+phase);
    float white=band(distance,spread)*.56;
    float cyan=band(distance-spread*1.75,spread*1.55)*.14;
    float violet=band(distance+spread*1.75,spread*1.6)*.12;
    float glow=bell(distance,.055+depth*.025)*.04;
    vec3 colour=vec3(.97,.995,1.)*white+vec3(.32,.72,.83)*cyan
      +vec3(.71,.61,.85)*violet+vec3(.66,.82,.93)*glow;
    float amount=weight*aperture*pulse;
    pigment+=colour*amount;energy+=(white+cyan+violet+glow)*amount;
  }
  float air=bell(p.y-carrier,.26)*bell(u,.87)*.018;
  pigment+=vec3(.72,.86,.98)*air;energy+=air;
  return vec4(pigment/max(energy,.00001),(1.-exp(-energy*1.65))*(1.-smoothstep(.74,1.04,abs(p.y))));
}
