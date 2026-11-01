"""Compare original public card pictures. No price is inferred from artwork scores."""
import cv2,numpy as np,io
from PIL import Image,ImageChops
cv2.setNumThreads(1)
def normalize(raw):
 im=Image.open(io.BytesIO(raw)).convert('RGBA');box=im.getchannel('A').point(lambda x:255 if x>192 else 0).getbbox()
 if box:im=im.crop(box)
 bg=Image.new('RGBA',im.size,'white');bg.alpha_composite(im);im=bg.convert('RGB')
 box=ImageChops.difference(im,Image.new('RGB',im.size,'white')).convert('L').point(lambda x:255 if x>24 else 0).getbbox()
 if box and (box[2]-box[0])*(box[3]-box[1])>=im.width*im.height*.18:im=im.crop(box)
 if not .55<=im.width/im.height<=.83:raise ValueError('No usable upright single-card image')
 return np.array(im.resize((160,224),Image.Resampling.LANCZOS))
def features(im):
 gray=cv2.cvtColor(im,cv2.COLOR_RGB2GRAY);mask=np.ones(gray.shape,np.uint8)*255;mask[72:137]=0
 return cv2.SIFT_create(nfeatures=650).detectAndCompute(gray,mask)
def compare(a,b,fa,fb):
 ka,da=fa;kb,db=fb
 fail={'registered':False,'quality':0.0}
 if da is None or db is None or len(da)<8 or len(db)<8:return fail
 pairs=cv2.BFMatcher().knnMatch(da,db,k=2);good=[m for pair in pairs if len(pair)==2 for m,n in [pair]if m.distance<.72*n.distance]
 if len(good)<8:return fail
 src=np.float32([ka[m.queryIdx].pt for m in good]);dst=np.float32([kb[m.trainIdx].pt for m in good])
 cv2.setRNGSeed(104729);H,mask=cv2.findHomography(src,dst,cv2.RANSAC,3.0)
 if H is None or mask is None:return fail
 ok=mask.ravel().astype(bool);n=int(ok.sum());ratio=n/len(good)
 corners=cv2.perspectiveTransform(np.float32([[[0,0],[159,0],[159,223],[0,223]]]),H)[0]
 area=abs(cv2.contourArea(corners))/(160*224)
 if n<8 or not .65<area<1.4 or np.max(np.linalg.norm(corners-np.float32([[0,0],[159,0],[159,223],[0,223]]),axis=1))>40:return fail
 warped=cv2.warpPerspective(a,H,(160,224));g1=cv2.cvtColor(warped,cv2.COLOR_RGB2GRAY).astype(float);g2=cv2.cvtColor(b,cv2.COLOR_RGB2GRAY).astype(float)
 mu1=cv2.GaussianBlur(g1,(7,7),1.5);mu2=cv2.GaussianBlur(g2,(7,7),1.5);s1=cv2.GaussianBlur(g1*g1,(7,7),1.5)-mu1*mu1;s2=cv2.GaussianBlur(g2*g2,(7,7),1.5)-mu2*mu2;s12=cv2.GaussianBlur(g1*g2,(7,7),1.5)-mu1*mu2
 score=((2*mu1*mu2+6.5025)*(2*s12+58.5225))/((mu1*mu1+mu2*mu2+6.5025)*(s1+s2+58.5225))
 valid=np.zeros((224,160),bool);valid[7:68,7:153]=True;valid[142:217,7:153]=True
 structure=float(score[valid].mean());points=src[ok];cells=len({(min(5,int(x/160*6)),min(5,int(y/224*6)))for x,y in points});top=int(sum(y<72 for x,y in points))
 quality=round(.55*structure+.25*min(n/120,1)+.1*min(cells/18,1)+.1*ratio,6)
 return {'registered':True,'quality':quality,'inliers':n,'inlierRatio':round(ratio,6),'spatialCells':cells,'artInliers':top,'unwatermarkedStructure':round(structure,6),'homography':H.tolist()}
def passes(e,shop=False):
 return e.get('registered') and e['inliers']>=(40 if shop else 50)and e['inlierRatio']>=.85 and e['spatialCells']>=12 and e['artInliers']>=15 and e['unwatermarkedStructure']>=.75
