import auth from 'prismarine-auth';
import config from '../config.js';
import {recorderAccounts} from '../lib/recorder-accounts.js';

const accounts=recorderAccounts(process.env.MINECRAFT_ACCOUNTS,config.authCacheDir);
const {Authflow,Titles}=auth;
const index=Number(process.argv[2]||1)-1;
const account=accounts[index];
if(!account){console.error('Set MINECRAFT_ACCOUNTS and run npm run auth:account -- <account number>.');process.exit(1);}
const flow=new Authflow(account.username,account.authCacheDir,{authTitle:Titles.MinecraftNintendoSwitch,deviceType:'Nintendo',flow:'live'},code=>{
  console.log(JSON.stringify({account:index+1,url:code.verification_uri,userCode:code.user_code,expiresIn:code.expires_in}));
});
try{
  const {profile}=await flow.getMinecraftJavaToken({fetchProfile:true,fetchCertificates:true});
  if(!profile?.id||!profile?.name)throw new Error('This account did not return a Minecraft Java profile.');
  console.log(JSON.stringify({authenticated:true,account:index+1,name:profile.name}));
}catch(error){console.error(`Account ${index+1} authentication failed: ${error.message}`);process.exitCode=1;}
