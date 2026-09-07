export const VERSION=3, STEP=1/120;
export const NAMES=['나옹','이브이','꼬부기','피카츄','고라파덕','팬텀','잠만보','푸린'];
export const RADII=[17,23,29,36,44,54,66,81];
export const FIELD={width:480,height:550,left:28,right:452,floor:522,danger:132};
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
export class MergeGame {
 constructor(seed=1,mode='speed'){if(!['speed','endless'].includes(mode))throw Error('올바르지 않은 게임 모드입니다.');this.mode=mode;this.seed=seed>>>0;this.randomState=this.seed;this.balls=[];this.events=[];this.points=0;this.ticks=0;this.cooldown=0;this.overflow=0;this.current=0;this.next=0;this.over=false;this.won=false;this.maxLevel=0;this.serial=0;this.asleep=false;this.stillTicks=0;}
 random(){let t=this.randomState+=0x6D2B79F5;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296;}
 randomLevel(){const n=this.random();return n<.42?0:n<.73?1:n<.93?2:3;}
 make(level,x,y,vx=0,vy=0){return{id:++this.serial,level,r:RADII[level],x,y,vx,vy,angle:0,age:0};}
 drop(x){if(this.over||this.cooldown>0||!Number.isFinite(x))return false;this.asleep=false;this.stillTicks=0;const r=RADII[this.current];this.balls.push(this.make(this.current,clamp(x,FIELD.left+r,FIELD.right-r),73));this.current=this.next;this.next=this.randomLevel();this.cooldown=60;return true;}
 merge(a,b){if(a.level===7&&this.mode==='endless'){const x=(a.x+b.x)/2,y=(a.y+b.y)/2;this.balls=this.balls.filter(o=>o!==a&&o!==b);this.points+=1280;this.events.push({type:'clear',x,y,r:81,level:7});return true;}const level=a.level+1,r=RADII[level],x=clamp((a.x+b.x)/2,FIELD.left+r,FIELD.right-r),y=Math.min(FIELD.floor-r,(a.y+b.y)/2),fresh=this.make(level,x,y,(a.vx+b.vx)*.35,(a.vy+b.vy)*.35);fresh.age=Math.max(a.age,b.age);this.balls=this.balls.filter(o=>o!==a&&o!==b);this.balls.push(fresh);this.points+=2**level*5;this.maxLevel=Math.max(this.maxLevel,level);this.events.push({type:'merge',x,y,r,level});if(level===7&&this.mode==='speed'){this.won=true;this.over=true;}return true;}
 solve(){
  for(const b of this.balls){if(b.x-b.r<FIELD.left){b.x=FIELD.left+b.r;if(b.vx<0)b.vx*=-.16;}if(b.x+b.r>FIELD.right){b.x=FIELD.right-b.r;if(b.vx>0)b.vx*=-.16;}if(b.y+b.r>FIELD.floor){b.y=FIELD.floor-b.r;if(b.vy>0)b.vy*=-.1;b.vx*=.96;}}
  for(let i=0;i<this.balls.length;i++)for(let j=i+1;j<this.balls.length;j++){
   const a=this.balls[i],b=this.balls[j],dx=b.x-a.x,dy=b.y-a.y,sum=a.r+b.r,d2=dx*dx+dy*dy;if(d2>(sum+.2)**2)continue;
   if(a.level===b.level&&(a.level<7||this.mode==='endless'))return this.merge(a,b);
   const d=Math.sqrt(d2),nx=d>1e-6?dx/d:1,ny=d>1e-6?dy/d:0,ia=1/(a.r*a.r),ib=1/(b.r*b.r),inv=ia+ib,overlap=Math.max(0,sum-d-.05)*.8;
   a.x-=nx*overlap*ia/inv;a.y-=ny*overlap*ia/inv;b.x+=nx*overlap*ib/inv;b.y+=ny*overlap*ib/inv;
   const v=(b.vx-a.vx)*nx+(b.vy-a.vy)*ny;if(v<0){const force=-1.08*v/inv;a.vx-=force*ia*nx;a.vy-=force*ia*ny;b.vx+=force*ib*nx;b.vy+=force*ib*ny;const tangent=(b.vx-a.vx)*(-ny)+(b.vy-a.vy)*nx,f=clamp(-tangent/inv,-force*.12,force*.12);a.vx-=f*ia*(-ny);a.vy-=f*ia*nx;b.vx+=f*ib*(-ny);b.vy+=f*ib*nx;}
  }return false;
 }
 step(){
  if(this.over)return;this.ticks++;this.cooldown=Math.max(0,this.cooldown-1);
  if(this.asleep)return;
  const before=this.balls.map(b=>[b.id,b.x,b.y]);
  for(const b of this.balls){b.age+=STEP;b.vy+=820*STEP;b.vx*=Math.exp(-.45*STEP);b.vy*=Math.exp(-.08*STEP);b.x+=b.vx*STEP;b.y+=b.vy*STEP;b.angle+=b.vx/b.r*STEP*.3;}
  for(let i=0;i<7&&!this.over;i++)this.solve();
  const overflow=this.balls.some(b=>b.age>1.8&&b.y-b.r<FIELD.danger&&Math.abs(b.vy)<65);this.overflow=overflow?this.overflow+STEP:Math.max(0,this.overflow-STEP*2);
  if(this.overflow>1.6||this.balls.length>=64)this.over=true;
  const still=!this.overflow&&before.length===this.balls.length&&this.balls.every((b,i)=>b.id===before[i][0]&&b.age>1.8&&Math.abs(b.x-before[i][1])<.02&&Math.abs(b.y-before[i][2])<.02&&Math.hypot(b.vx,b.vy)<5);
  this.stillTicks=still?this.stillTicks+1:0;
  if(this.stillTicks>=120){this.asleep=true;for(const b of this.balls){b.vx=0;b.vy=0;}}
 }
 result(){return{score:this.points,maxLevel:this.maxLevel,won:this.won,durationMs:Math.round(this.ticks*1000/120)};}
}
export function verifyReplay(seed,replay,mode='speed'){
 if(!replay||replay.version!==VERSION||!Number.isSafeInteger(replay.ticks)||replay.ticks<1||replay.ticks>Math.floor(Number.MAX_SAFE_INTEGER/1000)||!Array.isArray(replay.drops)||replay.drops.length>4096)throw Error('경기 기록 형식을 확인해 주세요.');
 let previous=-60;for(const a of replay.drops){if(!Array.isArray(a)||a.length!==2||!Number.isSafeInteger(a[0])||a[0]<previous+60||a[0]>=replay.ticks||!Number.isInteger(a[1])||a[1]<0||a[1]>480)throw Error('낙하 기록이 올바르지 않습니다.');previous=a[0];}
 if(!replay.drops.length)throw Error('플레이한 기록이 없습니다.');
 const game=new MergeGame(seed,mode);let cursor=0,work=0;
 while(game.ticks<replay.ticks){if(game.over)throw Error('종료 이후의 기록이 포함되어 있습니다.');if(game.asleep){const target=replay.drops[cursor]?.[0]??replay.ticks;if(target>game.ticks){game.cooldown=Math.max(0,game.cooldown-(target-game.ticks));game.ticks=target;if(game.ticks===replay.ticks)break;}}if(replay.drops[cursor]?.[0]===game.ticks){if(!game.drop(replay.drops[cursor][1]))throw Error('불가능한 낙하 기록입니다.');cursor++;}if(++work>1000000)throw Error('경기 기록의 물리 검증량이 너무 큽니다.');game.step();game.events.length=0;}
 if(!game.over||cursor!==replay.drops.length)throw Error('완료된 경기만 등록할 수 있습니다.');return game.result();
}
