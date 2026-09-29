import {randomBytes} from 'node:crypto';
import {SHEETS_GATEWAY_URL} from './sheets-webapp-url.js';
const base=new URL(SHEETS_GATEWAY_URL).origin;
export function installEmailPasswordAuth(app,{isAllowed,userExists,createUser,setPassword,issueSession,setOperator,request=fetch,now=Date.now}) {
 const pending=new Map(),cookie='ortus_email_verification';
 const options={httpOnly:true,sameSite:'strict',path:'/api/auth',maxAge:600000};
 function sameOrigin(req,res){if(req.headers.origin&&req.headers.origin!==`${req.protocol}://${req.headers.host}`){res.status(403).json({error:'Invalid origin'});return false;}return true;}
 async function remote(action,body){
  const response=await request(base+'/auth/email/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(30000)});
  const data=await response.json();if(!response.ok)throw Object.assign(Error(data.error||'Email verification unavailable.'),{status:response.status});return data;
 }
 async function start(req,res,purpose){
  if(!sameOrigin(req,res))return;
  try{
   for(const [id,item]of pending)if(item.expires<=now())pending.delete(id);
   const email=String(req.body?.email||'').trim().toLowerCase();
   if(!['signup','reset'].includes(purpose))return res.status(400).json({error:'Choose signup or password reset.'});
   if(!await isAllowed(email))return res.status(403).json({error:'This email is not authorized for an app account.'});
   if(purpose==='signup'&&await userExists(email))return res.status(409).json({error:'An account already exists. Use Sign in or Forgot password.'});
   const result=await remote('start',{email,purpose});
   if(!/^[a-f0-9]{64}$/.test(result.id||''))throw Error('Invalid verification response.');
   const id=randomBytes(32).toString('hex');
   if(req.cookies?.[cookie])pending.delete(req.cookies[cookie]);
   pending.set(id,{email,purpose,challengeId:result.id,expires:now()+600000,busy:false});
   res.cookie(cookie,id,options);res.json({ok:true,email,expiresIn:600});
  }catch(error){res.status(error.status||503).json({error:error.status?error.message:'Could not send the code. Your password has not changed.'});}
 }
 app.post('/api/auth/email/start',(req,res)=>start(req,res,req.body?.purpose));
 // Old clients can no longer delete a password by posting an email here.
 app.post('/api/auth/reset',(req,res)=>start(req,res,'reset'));
 async function finish(req,res,purpose){
  if(!sameOrigin(req,res))return;
  const id=req.cookies?.[cookie],item=pending.get(id);
  const {email,password,code}=req.body||{};
  if(!item||item.expires<=now()||item.purpose!==purpose||item.email!==String(email||'').trim().toLowerCase())return res.status(400).json({error:'Request a verification code for this email first.'});
  if(typeof password!=='string'||password.length<8||Buffer.byteLength(password,'utf8')>72)return res.status(400).json({error:'Use a password of at least 8 characters and at most 72 UTF-8 bytes.'});
  if(!/^\d{6}$/.test(String(code||'')))return res.status(400).json({error:'Enter the six-digit code from your email.'});
  if(item.busy)return res.status(409).json({error:'Verification is already in progress.'});
  item.busy=true;
  try{
   if(purpose==='signup'&&await userExists(item.email))return res.status(409).json({error:'An account already exists. Use Forgot password.'});
   const verified=await remote('verify',{id:item.challengeId,code,email:item.email,purpose});
   if(verified.ok!==true)throw Error('Verification was not confirmed.');
   pending.delete(id);
   if(purpose==='signup')await createUser(item.email,password);else await setPassword(item.email,password);
   setOperator(item.email);await issueSession(res,item.email);
   res.clearCookie(cookie,{path:options.path});res.json({ok:true});
  }catch(error){res.status(error.status||503).json({error:error.status?error.message:'Could not finish. Please request a new code and try again.'});}
  finally{item.busy=false;}
 }
 app.post('/api/auth/signup',(req,res)=>finish(req,res,'signup'));
 app.post('/api/auth/reset/confirm',(req,res)=>finish(req,res,'reset'));
}
