import { createCipheriv,createDecipheriv,randomBytes,createHash } from 'node:crypto';
import { KMSClient,GenerateDataKeyCommand,DecryptCommand } from '@aws-sdk/client-kms';
import { config } from '../../db/src/config.ts';
type Context={organizationId:string;projectId:string};
export type Envelope={version:1;mode:'kms'|'local';key:string;iv:string;tag:string;ciphertext:string};
function localKey(){if(config.NODE_ENV==='production')throw new Error('Production encryption requires Singapore KMS');return createHash('sha256').update(process.env.LOCAL_ENCRYPTION_KEY||config.SESSION_SECRET).digest();}
function kms(){if((process.env.AWS_REGION??'ap-southeast-1')!=='ap-southeast-1')throw new Error('Connector KMS must be in Singapore');return new KMSClient({region:'ap-southeast-1'});}
export async function encrypt(value:unknown,context:Context):Promise<Envelope>{
  let key:Uint8Array,wrapped:string,mode:'kms'|'local';
  if(process.env.KMS_KEY_ID){const result=await kms().send(new GenerateDataKeyCommand({KeyId:process.env.KMS_KEY_ID,KeySpec:'AES_256',EncryptionContext:context}));if(!result.Plaintext || !result.CiphertextBlob)throw new Error('KMS key generation failed');key=result.Plaintext;wrapped=Buffer.from(result.CiphertextBlob).toString('base64');mode='kms';}
  else {key=localKey();wrapped='development';mode='local';}
  try{const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(JSON.stringify(context)));const ciphertext=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);return {version:1,mode,key:wrapped,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')};}finally{key.fill(0);}
}
export async function decrypt<T>(envelope:Envelope,context:Context):Promise<T>{
  let key:Uint8Array;
  if(envelope.mode==='kms'){const result=await kms().send(new DecryptCommand({CiphertextBlob:Buffer.from(envelope.key,'base64'),EncryptionContext:context,KeyId:process.env.KMS_KEY_ID}));if(!result.Plaintext)throw new Error('KMS decryption failed');key=result.Plaintext;}
  else key=localKey();
  try{const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(envelope.iv,'base64'));decipher.setAAD(Buffer.from(JSON.stringify(context)));decipher.setAuthTag(Buffer.from(envelope.tag,'base64'));return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,'base64')),decipher.final()]).toString('utf8'));}finally{key.fill(0);}
}
