import nodemailer from 'nodemailer';
import {Timestamp} from '@google-cloud/firestore';
import {createEmailVerification} from './email-verification.mjs';
export function emailService(db) {
 const configured=['SMTP_HOST','SMTP_USER','SMTP_PASS','SMTP_FROM'].every(key=>!!process.env[key]);
 const port=Number(process.env.SMTP_PORT||587);
 const transport=configured?nodemailer.createTransport({host:process.env.SMTP_HOST,port,secure:port===465,requireTLS:port!==465,auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS},connectionTimeout:15000,socketTimeout:20000}):null;
 const store=async(keys,update)=>db.runTransaction(async tx=>{
  const refs=keys.map(key=>db.collection('emailVerification').doc(key));const docs=await tx.getAll(...refs);
  const records=Object.fromEntries(keys.map((key,index)=>[key,docs[index].exists?docs[index].data():undefined]));
  const result=update(records);
  keys.forEach((key,index)=>{if(records[key])tx.set(refs[index],{...records[key],ttl:Timestamp.fromMillis(Date.now()+86400000)});});
  return result;
 });
 return createEmailVerification({store,send:transport?async({email,code,purpose})=>{
  const action=purpose==='reset'?'reset your password':'create your account';
  await transport.sendMail({from:process.env.SMTP_FROM,to:{address:email,name:''},subject:'Your Ortus Basics verification code',text:`Your Ortus Basics verification code is: ${code}\n\nEnter this code in Basics to ${action}. It expires in 10 minutes and can be used once.\n\nIf you did not request this, ignore this email. Your password has not changed.`});
 }:null});
}
