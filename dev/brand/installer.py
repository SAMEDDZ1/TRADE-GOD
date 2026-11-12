import sys
from PIL import Image, ImageDraw, ImageFont
root=sys.argv[1]; ic=Image.open('/home/claude/art/icon_preview.png').convert('RGBA')
BG=(12,15,24); GOLD=(245,190,50)
try: F=lambda s: ImageFont.truetype('DejaVuSans-Bold.ttf',s)
except Exception: F=lambda s: ImageFont.load_default()
def card(w,h,iconsz,text=True,fs=20):
    im=Image.new('RGB',(w,h),BG); d=ImageDraw.Draw(im)
    i=ic.resize((iconsz,iconsz),Image.LANCZOS); im.paste(i,((w-iconsz)//2 if not text or w<h else 8,(h-iconsz)//2 if w>=h else 30),i)
    if text:
        f=F(fs); t='TRADE GOD'
        if w>=h: d.text((iconsz+16,(h-fs)//2-2),t,fill=GOLD,font=f)
        else: d.text(((w-d.textlength(t,font=f))//2,30+iconsz+14),t,fill=GOLD,font=f)
    return im
card(150,57,45,True,15).save(root+'/src-tauri/installer/header.bmp')
card(164,314,110,True,18).save(root+'/src-tauri/installer/sidebar.bmp')
im=card(660,400,140,False); d=ImageDraw.Draw(im); f=F(28); t='TRADE GOD'
d.text(((660-d.textlength(t,font=f))//2,20),t,fill=GOLD,font=f); im.save(root+'/src-tauri/installer/dmg-background.png')
