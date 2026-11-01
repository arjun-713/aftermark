import { lookup } from 'node:dns/promises';
import type { LookupFunction } from 'node:net';
import { BlockList, isIP } from 'node:net';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { AlertError, alertLimits } from './contracts.ts';

const blocked = new BlockList(), globalV6 = new BlockList();
for (const [network,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.31.196.0',24],['192.52.193.0',24],['192.88.99.0',24],['192.168.0.0',16],['192.175.48.0',24],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]] as const) blocked.addSubnet(network,prefix,'ipv4');
globalV6.addSubnet('2000::',3,'ipv6');
for (const [network,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['2620:4f:8000::',48],['3fff::',20]] as const) blocked.addSubnet(network,prefix,'ipv6');
export function publicAddress(address: string, family: number) {
  if (address.includes('%')) return false;
  const actual = isIP(address); if (actual !== family) return false;
  return actual === 4 ? !blocked.check(address,'ipv4') : actual === 6 && globalV6.check(address,'ipv6') && !blocked.check(address,'ipv6');
}
export function webhookUrl(value: string) {
  let url: URL; try { url = new URL(value); } catch { throw new AlertError('dns_rejected'); }
  const hostname = url.hostname.toLowerCase().replace(/\.$/,'');
  if (value.length > 2048 || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port && url.port !== '443'
    || isIP(hostname.replace(/^\[|\]$/g,'')) || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/.test(hostname)
    || /(?:^|\.)(?:localhost|local|internal|lan|home|arpa)$/.test(hostname)) throw new AlertError('dns_rejected');
  url.hostname = hostname; url.port = ''; url.search = ''; url.hash = ''; return url;
}
export type Address = { address: string; family: number };
export type Resolver = (hostname: string) => Promise<Address[]>;
export type PinnedTarget = { url: URL; hostname: string; address: string; family: 4|6 };
const systemResolver: Resolver = hostname => lookup(hostname,{ all:true,verbatim:true });
export async function resolveTarget(value: string, resolver: Resolver = systemResolver): Promise<PinnedTarget> {
  const url = webhookUrl(value); let timer: NodeJS.Timeout | undefined;
  try {
    const addresses = await Promise.race([resolver(url.hostname),new Promise<never>((_resolve,reject) => { timer = setTimeout(() => reject(new AlertError('dns_failed')),alertLimits.dnsTimeoutMs); })]);
    if (!addresses.length || addresses.length > 64 || addresses.some(a => !publicAddress(a.address,a.family))) throw new AlertError('dns_rejected');
    return { url,hostname:url.hostname,address:addresses[0].address,family:addresses[0].family as 4|6 };
  } catch (error) { throw error instanceof AlertError ? error : new AlertError('dns_failed'); }
  finally { if (timer) clearTimeout(timer); }
}
export function pinnedOptions(target: PinnedTarget, headers: Record<string,string>): RequestOptions & { autoSelectFamily:false } {
  const pinnedLookup: LookupFunction = (hostname, options, callback) => {
    if (hostname !== target.hostname) { callback(new AlertError('dns_rejected'),'',4); return; }
    if (typeof options === 'object' && options.all) (callback as any)(null,[{ address:target.address,family:target.family }]);
    else callback(null,target.address,target.family);
  };
  return { protocol:'https:',hostname:target.hostname,port:443,path:target.url.pathname,method:'POST',headers,
    family:target.family,autoSelectFamily:false,lookup:pinnedLookup,servername:target.hostname,rejectUnauthorized:true,agent:false,maxHeaderSize:16384 };
}
export type AlertTransport = (target: PinnedTarget, headers: Record<string,string>, rawBody: string) => Promise<number>;
/** DNS is resolved/validated once, and TCP lookup can return only that pinned address. No redirect handling exists. */
export async function sendPinned(target: PinnedTarget, headers: Record<string,string>, rawBody: string, request = httpsRequest): Promise<number> {
  return new Promise((resolve,reject) => {
    let finished = false, timer: NodeJS.Timeout | undefined;
    const done = (error?: AlertError, status?: number) => { if (finished) return; finished = true; if (timer) clearTimeout(timer); error ? reject(error) : resolve(status!); };
    const req = request(pinnedOptions(target,headers),res => { const status = res.statusCode ?? 0; done(undefined,status); res.destroy(); });
    timer = setTimeout(() => { req.destroy(); done(new AlertError('timeout')); },alertLimits.requestTimeoutMs);
    req.once('error',error => done(error instanceof AlertError ? error : new AlertError(/CERT|TLS|SSL/.test(String((error as NodeJS.ErrnoException).code))?'tls_failed':'transport_failed')));
    req.end(rawBody,'utf8');
  });
}
