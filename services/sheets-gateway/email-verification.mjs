import {randomBytes,randomInt,createHash,timingSafeEqual} from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('hex');
const problem=(message,status=400)=>Object.assign(Error(message),{status});
export function createEmailVerification({store,send,now=Date.now}) {
 return {
  async start({email,purpose}) {
   if(!send)throw problem('Email verification is not configured yet. Please use Google sign-in.',503);
   email=String(email||'').trim().toLowerCase();
   if(!/^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(email)||email.length>254||!['signup','reset'].includes(purpose))throw problem('Enter a valid email and verification purpose.');
   const at=now(),id=randomBytes(32).toString('hex'),code=String(randomInt(0,1000000)).padStart(6,'0');
   const recipient='recipient-'+hash(email),global='global';
   await store([recipient,global,'challenge-'+id],records=>{
    for(const [key,limit] of [[recipient,5],[global,200]]) {
     const previous=records[key];const bucket=previous&&at-previous.startedAt<3600000?previous:{startedAt:at,count:0,lastAt:0};
     if(bucket.count>=limit||(key===recipient&&bucket.count&&at-bucket.lastAt<60000))throw problem('Too many code requests. Please wait before trying again.',429);
     records[key]={...bucket,count:bucket.count+1,lastAt:at};
    }
    records['challenge-'+id]={email,purpose,digest:hash(id+':'+code),expires:at+600000,attempts:0,used:false};
   });
   try {await send({email,code,purpose});}
   catch {await store(['challenge-'+id],records=>{records['challenge-'+id].used=true;});throw problem('Could not send the verification email. Your password has not changed. Please try again later.',503);}
   return {id,expiresIn:600};
  },
  async verify({id,code,email,purpose}) {
   if(!/^[a-f0-9]{64}$/.test(String(id)))throw problem('Invalid or expired verification code.');
   const key='challenge-'+id;
   const ok=await store([key],records=>{
    const item=records[key];if(!item||item.used||item.expires<=now()||item.attempts>=5)return false;
    item.attempts++;
    const candidate=hash(id+':'+String(code));
    if(item.email!==String(email||'').trim().toLowerCase()||item.purpose!==purpose||!/^\d{6}$/.test(String(code))||!timingSafeEqual(Buffer.from(candidate,'hex'),Buffer.from(item.digest,'hex')))return false;
    item.used=true;return true;
   });
   if(!ok)throw problem('Invalid or expired verification code. Request a new code if needed.');
   return {ok:true};
  }
 };
}
export function installEmailVerification(app,service,jsonMiddleware) {
 for(const action of ['start','verify'])app.post('/auth/email/'+action,jsonMiddleware,async(req,res)=>{
  try {res.json(await service[action](req.body||{}));}
  catch(error){res.status(error.status||503).json({error:error.status?error.message:'Email verification is temporarily unavailable.'});}
 });
}
