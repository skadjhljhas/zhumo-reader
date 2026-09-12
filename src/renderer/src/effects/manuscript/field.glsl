precision highp float;
uniform vec2 resolution;
uniform float time;
uniform float theme;
uniform vec4 structure;
uniform vec4 detail;
uniform vec4 encounter;
uniform vec4 season;
uniform vec2 spectrum[4];

const float PI=3.14159265359;
float bell(float x,float width){return exp(-x*x/(width*width));}
float band(float distance,float width){
  // Filter the analytic line over its pixel footprint. MSAA does not filter a
  // full-screen fragment shader, and unfiltered subpixel peaks sparkle as they move.
  #ifdef FOLIO_DERIVATIVES
    float pixel=fwidth(distance);
  #else
    float pixel=3.1/resolution.y;
  #endif
  float filtered=sqrt(width*width+pixel*pixel*.5);
  return width/filtered*bell(distance,filtered);
}
float moment(float x){
  float value=0.;
  for(int k=0;k<4;k++){
    float order=float(k)+1.;
    value+=dot(spectrum[k],vec2(cos(x*order),sin(x*order)))/(order*order);
  }
  return value;
}
/* LUCENT_MOTION */
/* TIDAL_MOTION */
void main(){
  vec2 p=(gl_FragCoord.xy-resolution*.5)/resolution.y*2.2;
  gl_FragColor=theme<.5?lucentMotion(p):tidalMotion(p);
}
