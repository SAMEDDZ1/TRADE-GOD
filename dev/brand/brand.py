import sys, os
from PIL import Image, ImageDraw
OUT=sys.argv[1]
GOLD=(245,190,50); GOLD_D=(190,135,25); BG=(12,15,24); BG2=(22,28,44); GREEN=(46,204,113); RED=(231,76,60)
def icon(n=64):
    # pixel-art master on a 64 grid
    im=Image.new('RGBA',(n,n),(0,0,0,0)); d=ImageDraw.Draw(im)
    d.rounded_rectangle([1,1,n-2,n-2],radius=12,fill=BG,outline=GOLD_D,width=2)
    d.rounded_rectangle([4,4,n-5,n-5],radius=9,fill=BG2)
    # candles rising
    candles=[(12,46,53,RED),(20,40,50,GREEN),(28,42,51,RED),(36,35,46,GREEN),(44,30,40,GREEN)]
    for x,top,bot,c in candles:
        d.line([x+2,top-4,x+2,bot+3],fill=(150,160,180))
        d.rectangle([x,top,x+4,bot],fill=c)
    # crown
    pts=[(14,22),(14,10),(21,16),(32,6),(43,16),(50,10),(50,22)]
    d.polygon(pts,fill=GOLD,outline=GOLD_D)
    d.rectangle([14,20,50,24],fill=GOLD_D)
    for x in (21,32,43): d.rectangle([x-1,20,x+1,22],fill=(230,60,70))
    for x,y in ((14,9),(32,5),(50,9)): d.ellipse([x-2,y-2,x+2,y+2],fill=GOLD)
    return im
m=icon(64).resize((1024,1024),Image.NEAREST)
os.makedirs(OUT,exist_ok=True)
def save(name,sz): m.resize((sz,sz),Image.LANCZOS if sz<64 else Image.NEAREST).save(os.path.join(OUT,name))
for name,sz in [('32x32.png',32),('64x64.png',64),('128x128.png',128),('128x128@2x.png',256),('icon.png',512),
  ('Square30x30Logo.png',30),('Square44x44Logo.png',44),('Square71x71Logo.png',71),('Square89x89Logo.png',89),
  ('Square107x107Logo.png',107),('Square142x142Logo.png',142),('Square150x150Logo.png',150),('Square284x284Logo.png',284),
  ('Square310x310Logo.png',310),('StoreLogo.png',50)]: save(name,sz)
m.save(os.path.join(OUT,'icon.ico'),sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
m.save(os.path.join(OUT,'icon.icns'))
m.save('/home/claude/art/icon_preview.png')
