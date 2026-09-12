// A sea of long swells: moon-silver on indigo, a distant trace of sunlight.
vec4 tidalMotion(vec2 p){
  float volume=structure.x,notes=sqrt(structure.y),depth=structure.z;
  float seed=encounter.y*6.28318+season.x*.045+season.z*.018;
  vec2 q=p;
  q.x/=(.82+volume*.46)*(.95+encounter.z*.10);
  q.y+=.055*moment(q.x*1.1)*(notes+.3);
  q.y+=q.x*((encounter.x-.5)*.09+season.y*.018);
  q.y+=(encounter.w-.5)*.040*sin(q.x*1.7+seed*.63);
  float phase=oceanPhase(q,time,.15+notes*.36+depth*.20+detail.z*.18+structure.w*.08,seed);
  phase+=detail.y*.14*sin(q.x*1.6+seed)+detail.x*.08*sin(q.x*3.1-time*.047);
  float broad=oceanCrest(phase);
  float edge=band(sin(phase),.065)*smoothstep(.0,.7,cos(phase));
  float near=oceanCrest(phase-.48)*.12;
  float reflected=bell(q.x-.28-.10*sin(time*.037+seed),.74);
  float glimmer=.45+.55*pow(clamp(.5+.5*sin(q.x*9.7+phase*.31-time*.083+seed),0.,1.),3.);
  float silver=edge*(.21+reflected*.43)*glimmer;
  float blue=broad*(.105+reflected*.10)+near;
  float sun=bell(q.x+.80,.38)*broad*.018*(.7+.3*season.w);
  vec3 pigment=vec3(.82,.91,1.)*silver+vec3(.37,.57,.87)*blue+vec3(.92,.77,.53)*sun;
  float energy=silver+blue+sun;
  float envelope=exp(-pow(abs(q.x)/(.98+volume*.22),4.)-pow(abs(p.y)/(.55+notes*.15+depth*.10),4.));
  return vec4(pigment/max(energy,.00001),(1.-exp(-energy*1.8))*envelope);
}
