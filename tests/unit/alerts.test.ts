import { describe,it,expect,vi,afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { alertPayload,alertPayloadSchema,signAlert,verifyAlert,alertLimits,AlertError } from '../../packages/alerts/src/contracts.ts';
import { publicAddress,webhookUrl,resolveTarget,pinnedOptions,sendPinned } from '../../packages/alerts/src/network.ts';

afterEach(()=>vi.useRealTimers());
describe('webhook address policy',()=>{
  it.each(['0.0.0.1','10.2.3.4','100.64.0.1','127.0.0.1','169.254.169.254','172.16.0.1','172.31.255.255','192.0.0.9','192.0.2.1','192.88.99.2','192.168.1.1','198.18.0.1','198.51.100.1','203.0.113.9','224.0.0.1','240.0.0.1','255.255.255.255'])('rejects private or special IPv4 %s',address=>expect(publicAddress(address,4)).toBe(false));
  it.each(['::','::1','::ffff:127.0.0.1','::ffff:8.8.8.8','64:ff9b::a00:1','100::1','2001::1','2001:db8::1','2002:a00:1::1','3fff::1','fc00::1','fe80::1','ff02::1','fe80::1%lo'])('rejects private, translated, reserved or scoped IPv6 %s',address=>expect(publicAddress(address,6)).toBe(false));
  it('allows ordinary global addresses with a matching address family',()=>{
    expect(publicAddress('8.8.8.8',4)).toBe(true); expect(publicAddress('1.1.1.1',4)).toBe(true);
    expect(publicAddress('2606:4700:4700::1111',6)).toBe(true); expect(publicAddress('2001:4860:4860::8888',6)).toBe(true);
    expect(publicAddress('8.8.8.8',6)).toBe(false); expect(publicAddress('not-an-ip',4)).toBe(false);
  });
  it.each(['http://hooks.example.com/x','https://127.0.0.1/x','https://2130706433/x','https://0x7f000001/x','https://[::1]/x','https://user:password@hooks.example.com/x','https://hooks.example.com:444/x','https://hooks.example.com/x?token=secret','https://hooks.example.com/x#fragment','https://localhost/x','https://a.local/x','https://metadata.google.internal/x','https://singlelabel/x'])('rejects unsafe endpoint %s',value=>expect(()=>webhookUrl(value)).toThrow('dns_rejected'));
  it('rejects mixed public/private answers instead of picking only the public answer',async()=>{
    await expect(resolveTarget('https://hooks.example.com/x',async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}])).rejects.toThrow('dns_rejected');
    await expect(resolveTarget('https://hooks.example.com/x',async()=>[])).rejects.toThrow('dns_rejected');
  });
  it('pins TCP lookup after validation, preserving the original TLS and HTTP host',async()=>{
    let calls=0;
    const target=await resolveTarget('https://Hooks.Example.com./callback',async()=>{calls++;return [{address:calls===1?'8.8.8.8':'127.0.0.1',family:4}];});
    const options=pinnedOptions(target,{}),lookup=options.lookup as any;
    expect(options.hostname).toBe('hooks.example.com'); expect(options.servername).toBe('hooks.example.com');
    expect(options.rejectUnauthorized).toBe(true); expect(options.agent).toBe(false); expect(options.autoSelectFamily).toBe(false);
    expect(await new Promise(resolve=>lookup('hooks.example.com',{},(_error:unknown,address:string)=>resolve(address)))).toBe('8.8.8.8');
    expect(await new Promise(resolve=>lookup('hooks.example.com',{all:true},(_error:unknown,addresses:unknown)=>resolve(addresses)))).toEqual([{address:'8.8.8.8',family:4}]);
    expect(calls).toBe(1);
    expect(await new Promise(resolve=>lookup('different.example.com',{},(error:Error)=>resolve(error.message)))).toBe('dns_rejected');
  });
  it('bounds DNS resolution time without starting a request',async()=>{
    vi.useFakeTimers(); const result=resolveTarget('https://hooks.example.com/x',async()=>new Promise(()=>{}));
    const assertion=expect(result).rejects.toThrow('dns_failed'); await vi.advanceTimersByTimeAsync(alertLimits.dnsTimeoutMs+1); await assertion;
  });
});
describe('signed metadata delivery',()=>{
  it('whitelists enum/count metadata and rejects extra stored fields',()=>{
    const payload=alertPayload({organizationId:randomUUID(),projectId:randomUUID(),evaluationId:randomUUID(),revision:3,assessment:{processing:'completed',decision:'fail',outcomes:[{verification:'contradicted',name:'PRIVATE TRACE',reason:'MODEL CONTEXT',id:'customer-id',required:true,evidenceIds:[]}] }},randomUUID());
    expect(payload.verification).toEqual({verified:0,contradicted:1,unknown:0});
    expect(JSON.stringify(payload)).not.toContain('PRIVATE TRACE');expect(JSON.stringify(payload)).not.toContain('MODEL CONTEXT');expect(JSON.stringify(payload)).not.toContain('customer-id');
    expect(()=>alertPayloadSchema.parse({...payload,trace:'forbidden'})).toThrow();
  });
  it('signs exact raw bytes and validates timestamp/length before constant-time comparison',()=>{
    const secret='test-signing-secret-at-least-32-characters',timestamp='2000000000',body='{"id":"stable","quality":"fail"}';
    const signature=signAlert(secret,timestamp,body);
    expect(verifyAlert(secret,timestamp,body,signature,2000000000000)).toBe(true);
    expect(verifyAlert(secret,timestamp,body+' ',signature,2000000000000)).toBe(false);
    expect(verifyAlert(secret,timestamp,body,signature,2000000400000)).toBe(false);
    expect(verifyAlert(secret,timestamp,body,'short',2000000000000)).toBe(false);
  });
  it('posts to the pinned connection and stops at redirect headers without following them',async()=>{
    const target=await resolveTarget('https://hooks.example.com/callback',async()=>[{address:'8.8.8.8',family:4}]);
    let requests=0,body='',captured:any; const response={statusCode:302,destroy:vi.fn()};
    const fake=((options:any,callback:Function)=>{
      requests++; captured=options; const req=new EventEmitter() as any;
      req.end=(value:string)=>{body=value;queueMicrotask(()=>callback(response));};req.destroy=vi.fn();return req;
    }) as any;
    expect(await sendPinned(target,{'x-aq-signature':'synthetic-signature'},'synthetic-body',fake)).toBe(302);
    expect(requests).toBe(1);expect(body).toBe('synthetic-body');expect(captured.hostname).toBe('hooks.example.com');expect(response.destroy).toHaveBeenCalled();
  });
  it('bounds the whole HTTPS request and returns a sanitized timeout',async()=>{
    vi.useFakeTimers(); const target={url:new URL('https://hooks.example.com/x'),hostname:'hooks.example.com',address:'8.8.8.8',family:4 as const};
    const req=new EventEmitter() as any;req.end=()=>{};req.destroy=vi.fn();
    const result=sendPinned(target,{},'body',(()=>req) as any);const assertion=expect(result).rejects.toEqual(new AlertError('timeout'));
    await vi.advanceTimersByTimeAsync(alertLimits.requestTimeoutMs+1);await assertion;expect(req.destroy).toHaveBeenCalled();
  });
});
