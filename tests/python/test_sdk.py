import json
import unittest
from unittest.mock import patch
from agent_quality import AgentQuality, redact

class Response:
    status = 202
    def __enter__(self): return self
    def __exit__(self, *args): pass

class SDKTest(unittest.TestCase):
    def test_redaction_and_context(self):
        events = []
        def send(req, timeout):
            events.extend(json.loads(req.data)["events"])
            return Response()
        sdk = AgentQuality(endpoint="http://localhost", api_key="test", project_id="20000000-0000-4000-8000-000000000001", agent="Agent", agent_version="v1", flush_interval=999)
        @sdk.tool("github.createIssue")
        def create(): return {"number": 42, "email": "hidden@example.test"}
        with patch("urllib.request.urlopen", send):
            with sdk.run(run_id="run-1"):
                with sdk.span("nested"):
                    create()
            sdk.close()
        self.assertTrue(all(e["runId"] == "run-1" for e in events))
        self.assertNotIn("hidden@example.test", json.dumps(events))
        self.assertEqual(sdk.counters["delivered"], len(events))

    def test_failure_isolation_and_bounded_buffer(self):
        sdk = AgentQuality(endpoint="http://localhost", api_key="test", project_id="x", agent="Agent", agent_version="v1", max_buffer=2, flush_interval=999)
        with patch("urllib.request.urlopen", side_effect=OSError("offline")):
            with sdk.run(): sdk.message("extra")
            sdk.close()
        self.assertEqual(sdk.counters["dropped"], 3)
        self.assertEqual(sdk.counters["retries"], 2)

if __name__ == "__main__": unittest.main()
