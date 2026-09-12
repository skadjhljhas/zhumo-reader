"""Build the project's synthetic GPOS test font; no third-party glyph outlines."""
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.feaLib.builder import addOpenTypeFeaturesFromString
from pathlib import Path

font=FontBuilder(1000,isTTF=True)
font.setupGlyphOrder(['.notdef','space','left','right','letter'])
font.setupCharacterMap({32:'space',0xff08:'left',0xff09:'right',0x6587:'letter'})
glyphs={}
for name in ['.notdef','space','left','right','letter']:
    pen=TTGlyphPen(None)
    if name not in ['.notdef','space']:
        x=650 if name=='left' else 100
        pen.moveTo((x,0));pen.lineTo((x+120,0));pen.lineTo((x+120,700));pen.lineTo((x,700));pen.closePath()
    glyphs[name]=pen.glyph()
font.setupGlyf(glyphs)
font.setupHorizontalMetrics({name:(1000,650 if name=='left' else 100 if name not in ['.notdef','space'] else 0) for name in glyphs})
font.setupHorizontalHeader(ascent=800,descent=-200)
font.setupNameTable({'familyName':'ZhuMo Palt Test','styleName':'Regular','uniqueFontIdentifier':'ZhuMoPaltTest','fullName':'ZhuMo Palt Test','psName':'ZhuMoPaltTest'})
font.setupOS2(sTypoAscender=800,sTypoDescender=-200,usWinAscent=800,usWinDescent=200)
font.setupPost();font.setupMaxp()
addOpenTypeFeaturesFromString(font.font,'feature palt { pos left <-500 0 -500 0>; pos right <100 0 -500 0>; } palt;')
font.save(Path(__file__).with_name('palt-test.ttf'))
