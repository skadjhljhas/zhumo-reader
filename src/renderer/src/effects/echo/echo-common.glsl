// Shared by both echo fields. Stars arrive as an RGBA8 texture, three texels per stop:
//   A = x, y, magnitude, warmth      B = phase, depth, age, hour
//   C = breadth, sharpness, visits, kind (0 body text, 1 margin note)
vec4 starA(int i){return texture2D(stars,vec2(1./6.,(float(i)+.5)/rows));}
vec4 starB(int i){return texture2D(stars,vec2(.5,(float(i)+.5)/rows));}
vec4 starC(int i){return texture2D(stars,vec2(5./6.,(float(i)+.5)/rows));}
// Soft-knee alpha: many overlapping lights never clip into a flat patch.
float knee(float a){return a<.55?a:.55+.40*(1.-exp(-(a-.55)/.40));}
float dayness(float hour){return .5+.5*cos((hour-.5)*6.2831853);}
float gainFor(int i){
  float sel=abs(float(i)-focus.x)<.5?1.:0.;
  float hov=abs(float(i)-focus.y)<.5?1.:0.;
  return 1.+.7*sel+.4*hov;
}
float edgeFade(vec2 uv){
  return smoothstep(0.,.07,uv.x)*smoothstep(0.,.07,1.-uv.x)*smoothstep(0.,.05,uv.y)*smoothstep(0.,.10,1.-uv.y);
}
