"""Compare original public card pictures. No price is inferred from artwork scores."""
import cv2,numpy as np,io
from PIL import Image,ImageChops
cv2.setNumThreads(1)
def card_frame(raw):
 im=Image.open(io.BytesIO(raw)).convert('RGBA');box=im.getchannel('A').point(lambda x:255 if x>192 else 0).getbbox()
 if box:im=im.crop(box)
 bg=Image.new('RGBA',im.size,'white');bg.alpha_composite(im);im=bg.convert('RGB')
 box=ImageChops.difference(im,Image.new('RGB',im.size,'white')).convert('L').point(lambda x:255 if x>24 else 0).getbbox()
 if box and (box[2]-box[0])*(box[3]-box[1])>=im.width*im.height*.18:im=im.crop(box)
 # BREAK cards are printed landscape. Put the card in the same frame as a
 # sideways catalogue scan before computing illustration and text features.
 landscape=.55<=im.height/im.width<=.83
 if landscape:im=im.transpose(Image.Transpose.ROTATE_90)
 if not .55<=im.width/im.height<=.83:raise ValueError('No usable single-card frame')
 return im,landscape

def normalize(raw):
 frame,_=card_frame(raw)
 return np.array(frame.resize((160,224),Image.Resampling.LANCZOS))

def landscape_registration(source, market):
    """Require distributed illustration and text matches on a whole oriented card."""
    size = (320, 448)
    boundary = np.float32([[0, 0], [319, 0], [319, 447], [0, 447]])
    mask = np.full((448, 320), 255, np.uint8)
    mask[144:274] = 0
    sift = cv2.SIFT_create(nfeatures=1500)
    def describe(frame):
        image = np.asarray(frame.resize(size, Image.Resampling.LANCZOS).convert('L'))
        return sift.detectAndCompute(image, mask)
    left, features_left = describe(source)
    best = {'registered': False, 'quality': 0.0}
    for frame in (market, market.transpose(Image.Transpose.ROTATE_180)):
        right, features_right = describe(frame)
        if features_left is None or features_right is None or len(right)<2:continue
        pairs = cv2.BFMatcher().knnMatch(features_left, features_right, k=2)
        good = [pair[0] for pair in pairs if len(pair)==2 and pair[0].distance<.70*pair[1].distance]
        if len(good)<90:continue
        src = np.float32([left[m.queryIdx].pt for m in good])
        dst = np.float32([right[m.trainIdx].pt for m in good])
        cv2.setRNGSeed(104729)
        transform, fitted = cv2.findHomography(src, dst, cv2.RANSAC, 4)
        if transform is None:continue
        points = src[fitted.ravel().astype(bool)]
        n = len(points)
        ratio = n/len(good)
        corners = cv2.perspectiveTransform(boundary[None], transform)[0]
        area = abs(cv2.contourArea(corners))/(320*448)
        shift = float(np.max(np.linalg.norm(corners-boundary,axis=1)))
        top = sum(y<144 for _,y in points)
        bottom = sum(y>=274 for _,y in points)
        cells = len({(min(5,int(x/320*6)), min(5,int(y/448*6))) for x,y in points})
        if n>=90 and ratio>=.90 and top>=25 and bottom>=30 and cells>=16 and .80<area<1.2 and shift<32:
            return {'registered':True,'method':'landscape-full-card','quality':round(ratio,6),'inliers':n,
                    'inlierRatio':ratio,'artInliers':int(top),'textInliers':int(bottom),'spatialCells':cells,
                    'area':area,'cornerShift':shift}
    return best
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
 if e.get('method')=='landscape-full-card':
  return e.get('registered') and e['inliers']>=90 and e['inlierRatio']>=.90 and e['artInliers']>=25 and e['textInliers']>=30 and e['spatialCells']>=16 and .80<e['area']<1.2 and e['cornerShift']<32
 return e.get('registered') and e['inliers']>=(40 if shop else 50)and e['inlierRatio']>=.85 and e['spatialCells']>=12 and e['artInliers']>=15 and e['unwatermarkedStructure']>=.75
