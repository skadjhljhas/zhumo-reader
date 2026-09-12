// A return to a passage leaves the light of a long swell in the available air.
vec4 causticLight(vec2 p,float clock,float memory,float density) {
  p.y*=.56;
  float phase=oceanPhase(p,clock,.10+density*.30,memory*6.28318);
  float broad=oceanCrest(phase);
  float width=max(.09,18./max(resolution.y,1.));
  float edge=exp(-pow(sin(phase)/width,2.))*smoothstep(0.,.7,cos(phase));
  float reflected=exp(-pow((p.x-.25-.2*sin(clock*.028+memory))/.85,2.));
  float silver=edge*(.10+reflected*.19);
  float blue=broad*(.08+reflected*.08);
  float tail=oceanCrest(phase-.5)*.04;
  float envelope=exp(-pow(p.x*.61,4.)-pow(p.y*1.65,4.));
  float opacity=(silver+blue+tail)*envelope;
  vec3 colour=(vec3(.81,.90,1.)*silver+vec3(.35,.54,.85)*blue+vec3(.56,.70,.89)*tail)/max(silver+blue+tail,.00001);
  float alpha=1.-exp(-opacity*1.8);
  alpha=alpha<.44?alpha:.44+.10*(1.-exp(-(alpha-.44)/.10));
  return vec4(colour,alpha);
}
