const role = process.env.SERVICE_ROLE ?? 'api';
if (['api','web','worker'].includes(role)) {
  const response = await fetch(`http://127.0.0.1:${process.env.PORT ?? 10000}/${role === 'api' ? 'ready' : role === 'web' ? '' : 'health'}`, { signal: AbortSignal.timeout(4000) });
  if (!response.ok) process.exitCode = 1;
}
