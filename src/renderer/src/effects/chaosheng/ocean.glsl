// Long travelling swells share a direction and a slow undertow. No cellular
// caustic network: a sea expressed through light, without a solid shore.
float oceanPhase(vec2 p,float t,float complexity,float seed){
  float undertow=.88*sin(p.x*1.13-t*.053+seed);
  float swell=.43*sin(p.x*2.35+t*.039+seed*.73);
  float far=.08*sin(p.x*4.1-t*.068+seed*1.4);
  return p.y*(7.0+complexity*3.5)+undertow+swell+far*complexity-t*.24;
}
float oceanCrest(float phase){
  float wave=clamp(.5+.5*cos(phase),0.,1.);
  return wave*wave*wave*wave*wave*wave;
}
