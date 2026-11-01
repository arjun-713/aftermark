const sensitive=/^(authorization|password|secret|api.?key|access.?token|refresh.?token|email|phone)$/i;
export function redact<T>(value:T):T {
  if(typeof value==='string') return value.replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi,'[REDACTED]').replace(/Bearer\s+[^\s"']+/gi,'Bearer [REDACTED]').replace(/\b(?:sk-|aq_)[a-zA-Z0-9_-]{16,}/g,'[REDACTED]') as T;
  if(Array.isArray(value)) return value.map(x=>redact(x)) as T;
  if(value && typeof value==='object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,sensitive.test(k)?'[REDACTED]':redact(v)])) as T;
  return value;
}
export function canonical(value:unknown):string {
  if(Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if(value && typeof value==='object') return `{${Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,v])=>`${JSON.stringify(key)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
