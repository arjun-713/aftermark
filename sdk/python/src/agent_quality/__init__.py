"""Failure-isolated agent telemetry. No external runtime dependencies."""
from __future__ import annotations
import contextlib
import contextvars
import functools
import hashlib
import hmac
import inspect
import json
import re
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone

_context = contextvars.ContextVar("agent_quality_context", default=None)
_sensitive = re.compile(r"^(authorization|password|secret|api.?key|access.?token|refresh.?token|email|phone)$", re.I)
_email_candidates = re.compile(r"[\w.+@-]+")

def _redact_email_candidate(match):
    token = match.group(0)
    at = token.rfind("@")
    if at <= 0:
        return token
    domain = token[at + 1:].rstrip(".")
    dot = domain.rfind(".")
    if dot > 0 and re.fullmatch(r"[\w.-]+", domain) and re.fullmatch(r"[a-z]{2,63}", domain[dot + 1:], re.I):
        return "[REDACTED]" + token[at + 1 + len(domain):]
    return token

def redact(value):
    if isinstance(value, str):
        value = _email_candidates.sub(_redact_email_candidate, value)
        value = re.sub(r"Bearer\s+[^\s\"']+", "Bearer [REDACTED]", value, flags=re.I)
        return re.sub(r"\b(?:sk-|aq_)[a-zA-Z0-9_-]{16,}", "[REDACTED]", value)
    if isinstance(value, dict):
        return {str(k): "[REDACTED]" if _sensitive.match(str(k)) else redact(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [redact(v) for v in value]
    return value

class AgentQuality:
    def __init__(self, *, endpoint, api_key, project_id, agent, agent_version, environment="production", max_buffer=1000, flush_interval=1.0):
        self.endpoint, self.api_key, self.project_id = endpoint.rstrip("/"), api_key, project_id
        self.agent, self.agent_version, self.environment = agent, agent_version, environment
        self.max_buffer = max(1, max_buffer)
        self.counters = dict(delivered=0, dropped=0, retries=0, truncated=0, delivery_failures=0)
        self._buffer, self._lock, self._flush_lock, self._stop = [], threading.Lock(), threading.Lock(), threading.Event()
        self._thread = threading.Thread(target=self._background, args=(max(0.05, flush_interval),), daemon=True)
        self._thread.start()

    def _background(self, interval):
        while not self._stop.wait(interval):
            self.flush()

    def emit(self, kind, payload):
        try:
            context = _context.get()
            if context is None:
                self.counters["dropped"] += 1
                return
            clean = redact(payload)
            if isinstance(clean.get("text"), str) and len(clean["text"]) > 32000:
                clean["text"] = clean["text"][:31960] + " [TRUNCATED]"
                self.counters["truncated"] += 1
            event = dict(schemaVersion="1.0", eventId=str(uuid.uuid4()), runId=context["runId"], kind=kind, timestamp=datetime.now(timezone.utc).isoformat(), agentVersion=self.agent_version, environment=self.environment, payload=clean)
            if context.get("spanId"):
                event["spanId"] = context["spanId"]
            if context.get("parentSpanId"):
                event["parentSpanId"] = context["parentSpanId"]
            if len(json.dumps(event).encode()) > 128000:
                if kind == "outcome.expected":
                    self.counters["dropped"] += 1
                    return
                event["payload"] = {**{k: clean[k] for k in ("tool", "toolCallId", "success") if k in clean}, "text": "[TRUNCATED: oversized event payload]", "metadata": {"truncated": True}}
                self.counters["truncated"] += 1
            with self._lock:
                if len(self._buffer) >= self.max_buffer:
                    self.counters["dropped"] += 1
                else:
                    self._buffer.append(event)
        except Exception:
            self.counters["dropped"] += 1

    @contextlib.contextmanager
    def run(self, *, run_id=None, outcomes=()):
        token = _context.set({"runId": run_id or str(uuid.uuid4())})
        self.emit("run.started", {"agent": self.agent})
        for outcome in outcomes:
            self.expect(outcome)
        try:
            yield self
        except BaseException as error:
            self.emit("run.failed", {"text": str(error)})
            raise
        else:
            self.emit("run.completed", {})
        finally:
            _context.reset(token)

    @contextlib.contextmanager
    def span(self, name):
        parent = _context.get()
        if not parent:
            yield self
            return
        token = _context.set({**parent, "spanId": str(uuid.uuid4()), "parentSpanId": parent.get("spanId")})
        self.emit("span.started", {"name": name, "metadata": {"parentSpanId": parent.get("spanId")}})
        try:
            yield self
        finally:
            self.emit("span.completed", {"name": name})
            _context.reset(token)

    def expect(self, outcome):
        self.emit("outcome.expected", {"outcome": outcome})

    def message(self, text):
        self.emit("message", {"text": text})

    def tool(self, name):
        def decorate(fn):
            def start(args, kwargs):
                call = str(uuid.uuid4())
                self.emit("tool.called", {"tool": name, "toolCallId": call, "arguments": {"args": args, **kwargs}})
                return call
            def end(call, success, result):
                self.emit("tool.result", {"tool": name, "toolCallId": call, "success": success, **({"result": result if isinstance(result, dict) else {"value": result}} if success else {"text": str(result)})})
            @functools.wraps(fn)
            async def async_wrapped(*args, **kwargs):
                call = start(args, kwargs)
                try:
                    result = await fn(*args, **kwargs)
                except BaseException as error:
                    end(call, False, error)
                    raise
                end(call, True, result)
                return result
            @functools.wraps(fn)
            def wrapped(*args, **kwargs):
                call = start(args, kwargs)
                try:
                    result = fn(*args, **kwargs)
                except BaseException as error:
                    end(call, False, error)
                    raise
                end(call, True, result)
                return result
            return async_wrapped if inspect.iscoroutinefunction(fn) else wrapped
        return decorate

    def flush(self):
        if not self._flush_lock.acquire(blocking=False):
            return
        try:
            while True:
                with self._lock:
                    if not self._buffer:
                        break
                    events, size = [], 128
                    while self._buffer and len(events) < 100:
                        event_size = len(json.dumps(self._buffer[0]).encode()) + 1
                        if events and size + event_size > 900000:
                            break
                        size += event_size
                        events.append(self._buffer.pop(0))
                body = json.dumps(dict(projectId=self.project_id, events=events)).encode()
                sent = False
                for attempt in range(3):
                    try:
                        req = urllib.request.Request(self.endpoint + "/v1/events", body, {"Authorization": "Bearer " + self.api_key, "Content-Type": "application/json"})
                        with urllib.request.urlopen(req, timeout=5) as response:
                            sent = response.status == 202
                        if sent:
                            self.counters["delivered"] += len(events)
                            break
                    except urllib.error.HTTPError as error:
                        if error.code < 500 and error.code != 429:
                            break
                    except Exception:
                        pass
                    if attempt < 2:
                        self.counters["retries"] += 1
                        time.sleep(0.1 * (2 ** attempt))
                if not sent:
                    self.counters["dropped"] += len(events)
                    self.counters["delivery_failures"] += 1
        except Exception:
            self.counters["delivery_failures"] += 1
        finally:
            self._flush_lock.release()

    def close(self):
        self._stop.set()
        self._thread.join(timeout=16)
        self.flush()

def submit_evidence(*, endpoint, verifier_key, receipt):
    try:
        receipt = redact(receipt)
        timestamp = str(int(time.time()))
        body = json.dumps(receipt, ensure_ascii=False).encode()
        signature = hmac.new(verifier_key.encode(), timestamp.encode() + b"." + body, hashlib.sha256).hexdigest()
        request = urllib.request.Request(endpoint.rstrip("/") + "/v1/evidence", body, {"Authorization": "Bearer " + verifier_key, "Content-Type": "application/json", "x-receipt-timestamp": timestamp, "x-receipt-signature": signature})
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status in (200, 202)
    except Exception:
        return False
