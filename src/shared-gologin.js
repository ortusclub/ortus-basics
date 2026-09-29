// Shared tokens stay in the background process's memory, never in app settings.
const fields={ortus:'GOLOGIN_API_TOKEN',marketing:'GOLOGIN_API_TOKEN_MARKETING'};
export function createSharedGoLogin({connection,url,request=fetch,env=process.env,now=Date.now,onChange=()=>{}}){
 let values={},expires=0,retryAt=0,pending=null,owner='',message='';
 const identity=()=>{const s=connection.status();return s.connected?s.email:'';};
 const clear=()=>{const had=Object.keys(values).length;values={};expires=0;if(had)onChange();};
 function token(id){if(!identity()||identity()!==owner||now()>=expires)return '';return values[id]||'';}
 async function ensure(){
  const email=identity();
  if(!email){clear();owner='';message='Sign in with your company Google account to use shared GoLogin access.';return;}
  if(email!==owner){clear();owner=email;retryAt=0;}
  if(Object.values(fields).every(key=>String(env[key]||'').trim()))return;
  if(now()<expires||now()<retryAt)return;
  if(pending)return pending;
  pending=(async()=>{
   try{
    const identityToken=await connection.token();
    const response=await request(url,{headers:{Authorization:'Bearer '+identityToken},redirect:'error',signal:AbortSignal.timeout(12000)});
    if(!response.ok)throw Error(response.status===401?'Company Google sign-in expired. Reconnect Google to use shared GoLogin access.':'Shared GoLogin access is unavailable. Retry shortly or enter your own token.');
    const data=await response.json();const next={};
    for(const id of Object.keys(fields)){const v=data.tokens?.[id];if(typeof v==='string'&&v.trim()&&v.length<8192)next[id]=v.trim();}
    if(identity()!==email||owner!==email)return;
    const changed=JSON.stringify(values)!==JSON.stringify(next);values=next;expires=now()+300000;message='';retryAt=0;if(changed)onChange();
   }catch(e){if(identity()===email&&owner===email){clear();retryAt=now()+30000;message=e.message?.startsWith('Company Google')||e.message?.startsWith('Shared GoLogin')?e.message:'Could not load shared GoLogin access. Retry shortly or enter your own token.';}}
   finally{pending=null;}
  })();
  return pending;
 }
 return {ensure,token,status:id=>({eligible:!!fields[id],active:!!token(id),message:fields[id]?message:''})};
}
let provider;
export function configureSharedGoLogin(options){provider=createSharedGoLogin(options);}
export const ensureSharedGoLogin=()=>provider?.ensure();
export const sharedGoLoginToken=id=>provider?.token(id)||'';
export const sharedGoLoginStatus=id=>provider?.status(id)||{eligible:['ortus','marketing'].includes(id),active:false,message:''};
