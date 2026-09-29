const params=new URLSearchParams(location.search);
const purpose=params.get('mode')==='reset'?'reset':'signup';
const email=document.getElementById('email'),send=document.getElementById('send-code'),fields=document.getElementById('verified-fields'),status=document.getElementById('code-status'),error=document.getElementById('auth-error'),submit=document.getElementById('confirm-email-auth');
email.value=params.get('email')||'';
if(purpose==='reset'){
 document.getElementById('email-auth-title').textContent='Reset password';
 document.getElementById('email-auth-description').textContent='We’ll email you a code. Your current password stays unchanged until you verify it and choose a new one.';
 submit.textContent='Verify code & reset password →';
}
let target='',busy=false,cooldown=0;
const showError=text=>{error.textContent=text;error.classList.add('visible');};
async function post(path,body){const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(35000)});const data=await response.json();if(!response.ok)throw Error(data.error||'Please try again.');return data;}
function updateSend(){const seconds=Math.max(0,Math.ceil((cooldown-Date.now())/1000));send.disabled=busy||seconds>0;send.textContent=seconds?`Resend in ${seconds}s`:target?'Resend code':'Send verification code';}
setInterval(updateSend,1000);
email.addEventListener('input',()=>{target='';fields.hidden=true;fields.disabled=true;status.textContent='';error.classList.remove('visible');});
send.addEventListener('click',async()=>{
 if(!email.reportValidity())return;
 const requested=email.value.trim().toLowerCase();busy=true;updateSend();error.classList.remove('visible');status.textContent='Sending your code…';
 try{
  await post('/api/auth/email/start',{email:requested,purpose});
  if(email.value.trim().toLowerCase()!==requested){status.textContent='Email changed. Request a code for the new address.';return;}
  target=requested;cooldown=Date.now()+60000;fields.hidden=false;fields.disabled=false;
  status.textContent=`Code sent to ${target}. Check your inbox or spam folder.`;document.getElementById('verification-code').value='';document.getElementById('verification-code').focus();
 }catch(e){status.textContent='';showError(e.message);}
 finally{busy=false;updateSend();}
});
document.getElementById('signup-form').addEventListener('submit',async event=>{
 event.preventDefault();if(busy)return;error.classList.remove('visible');
 if(!target||target!==email.value.trim().toLowerCase())return showError('Request a code for this email first.');
 const password=document.getElementById('password').value;
 if(password!==document.getElementById('password2').value)return showError('Passwords do not match.');
 busy=true;submit.disabled=true;updateSend();
 try{await post(purpose==='reset'?'/api/auth/reset/confirm':'/api/auth/signup',{email:target,code:document.getElementById('verification-code').value.trim(),password});location.assign('/');}
 catch(e){showError(e.message);}
 finally{busy=false;submit.disabled=false;updateSend();}
});
fetch('/api/health').then(r=>r.json()).then(data=>{if(data.version)document.getElementById('deck-version').textContent='v'+data.version;}).catch(()=>{});
