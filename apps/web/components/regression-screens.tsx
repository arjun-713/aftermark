"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Plus, RotateCw } from "lucide-react";
import { useScope } from "./app-shell";
import { Badge, CopyButton, Empty, ErrorState, Loading, Modal, PageHeader, SectionTitle } from "./ui";
import { api, json, pretty, when } from "../lib/api";
import type { ComparisonReport, Dataset, ExpectedBehavior } from "../../../packages/regression/src/contracts";

type DatasetKind = Dataset["kind"];
type DatasetSummary = { id: string; name: string; kind: DatasetKind; version: number; hash: string; case_count: number; created_at: string };
type Review = { id: string; run_id: string; agent: string; environment: string; version: number; decision: string; annotation: string;
  assessment?: { outcomes: { id: string; name: string; required: boolean; verification: string }[] } };
type ExperimentSummary = { id: string; name: string; dataset_name: string; dataset_version: number; dataset_id: string; policy_id: string; created_at: string };
type PolicySummary = { id: string; version: number; hash: string; definition: { name: string }; active: boolean };
type RunSummary = { id: string; agent: string; agent_version: string; environment: string; execution_status: string };
const labels: Record<DatasetKind, string> = { agent_regression: "Agent regression", evaluator_calibration: "Evaluator calibration" };
const statusValue = (status: string) => status === "passed" ? "pass" : status === "failed" ? "fail" : status === "indeterminate" ? "unknown" : status === "allowed" ? "review" : status;
const runLink = (id: string) => `/app/runs/${encodeURIComponent(id)}`;
const queryString = (projectId: string) => `projectId=${encodeURIComponent(projectId)}`;

function useScopedQuery<T>(key: string, path: string, enabled = true) {
  const { workspaceId, projectId } = useScope();
  return useQuery<T>({ queryKey: [key, workspaceId, projectId, path],
    queryFn: () => api(`${path}${path.includes("?") ? "&" : "?"}${queryString(projectId)}`, workspaceId), enabled: !!workspaceId && !!projectId && enabled });
}
function downloadJson(value: unknown, filename: string) {
  const href = URL.createObjectURL(new Blob([pretty(value)], { type: "application/json" }));
  const link = document.createElement("a"); link.href = href; link.download = filename; link.click(); URL.revokeObjectURL(href);
}

export function Datasets() {
  const { workspaceId, projectId, role, notify } = useScope();
  const client = useQueryClient(); const canPublish = ["owner", "admin", "member"].includes(role);
  const [kind, setKind] = useState<DatasetKind>("agent_regression");
  const [selectedId, setSelectedId] = useState(""); const [publishing, setPublishing] = useState(false);
  const [reviewId, setReviewId] = useState(""); const [prefillRun, setPrefillRun] = useState("");
  const [reviewVersion, setReviewVersion] = useState(1); const [name, setName] = useState(""); const [caseId, setCaseId] = useState("");
  const [behavior, setBehavior] = useState<ExpectedBehavior["kind"]>("completion"); const [description, setDescription] = useState("");
  const [execution, setExecution] = useState("completed"); const [phrases, setPhrases] = useState("");
  const [outcomeAssertions, setOutcomeAssertions] = useState<Record<string, string>>({});
  const [humanLabel, setHumanLabel] = useState("clear"); const [stratum, setStratum] = useState("");
  const [localError, setLocalError] = useState("");
  const datasets = useScopedQuery<DatasetSummary[]>("regression-datasets", `/datasets?kind=${kind}`);
  const reviews = useScopedQuery<Review[]>("resolved-regression-reviews", "/reviews?status=resolved", publishing);
  const selectedReview = reviews.data?.find(review => review.id === reviewId);
  const detail = useScopedQuery<Dataset>("regression-dataset", `/datasets/${selectedId}`, !!selectedId);
  useEffect(() => {
    setSelectedId(""); setReviewId(""); setPrefillRun(""); setPublishing(false);
    if (!workspaceId || !projectId) return;
    const params = new URLSearchParams(window.location.search); const id = params.get("review") ?? params.get("reviewId");
    if (id) setReviewId(id); setPrefillRun(params.get("run") ?? params.get("runId") ?? "");
    if (id || params.has("run") || params.has("runId")) setPublishing(true);
    if (params.get("dataset")) setSelectedId(params.get("dataset")!);
  }, [workspaceId, projectId]);
  useEffect(() => {
    if (!reviews.data) return;
    const chosen = reviews.data.find(review => review.id === reviewId) ?? (!reviewId && prefillRun ? reviews.data.find(review => review.run_id === prefillRun) : undefined);
    if (chosen) { setReviewId(chosen.id); setReviewVersion(chosen.version); }
  }, [reviews.data, reviewId, prefillRun]);
  const replay = useMutation({ mutationFn: () => api(`/datasets/${selectedId}/replay`, workspaceId, { method: "POST", body: json({ projectId }) }), onError: error => notify(error.message) });
  useEffect(() => { replay.reset(); }, [selectedId]); // A replay belongs to one immutable version.
  const publish = useMutation({
    mutationFn: async () => {
      if (!selectedReview) throw new Error("Select a resolved review before publishing.");
      const expectedBehavior = { kind: behavior, description, executionStatuses: [execution], messageIncludes: phrases.split("\n").map(value => value.trim()).filter(Boolean),
        outcomes: Object.entries(outcomeAssertions).filter(([, value]) => value).map(([id, verification]) => ({ id, verification })) };
      if (kind === "agent_regression" && behavior !== "completion" && !expectedBehavior.messageIncludes.length) throw new Error("Add the acknowledgement phrase expected in the response.");
      const reviewedCase = { reviewId, reviewVersion: Number(reviewVersion), ...(caseId.trim() ? { caseId: caseId.trim() } : {}) };
      return api<Dataset>("/datasets", workspaceId, { method: "POST", body: json({ projectId, name, kind,
        cases: [{ ...reviewedCase, ...(kind === "agent_regression" ? { expectedBehavior } : { humanLabel, stratum }) }] }) });
    },
    onSuccess: value => { setSelectedId(value.id); setPublishing(false); void client.invalidateQueries({ queryKey: ["regression-datasets"] }); notify(`Published ${value.name} version ${value.version}.`); },
    onError: error => { setLocalError(error.message); void reviews.refetch(); },
  });
  function chooseReview(id: string) {
    setReviewId(id); setReviewVersion(reviews.data?.find(review => review.id === id)?.version ?? 1); setOutcomeAssertions({}); setLocalError("");
  }
  if (!projectId) return <Empty title="Select a project">Choose the project whose reviewed cases you want to preserve.</Empty>;
  return <>
    <PageHeader title="Datasets" description="Immutable reviewed cases for agent regressions and evaluator calibration."
      action={canPublish ? <button className="btn" onClick={() => { setPublishing(true); setLocalError(""); }}><Plus size={15} />Publish reviewed case</button> : undefined} />
    <div className="tabs" role="tablist" aria-label="Dataset kind">{Object.entries(labels).map(([value, label]) => <button key={value} role="tab" aria-selected={kind === value} className={kind === value ? "selected" : ""} onClick={() => { setKind(value as DatasetKind); setSelectedId(""); }}>{label}</button>)}</div>
    {kind === "evaluator_calibration" && <p className="quiet-notice">Human labels for detector calibration are separate from agent regression expectations. Publishing a dataset does not pass the calibration release gate.</p>}
    {!canPublish && <p className="quiet-notice">Your viewer role can inspect versions. Publishing requires a workspace member, admin, or owner.</p>}
    {datasets.isPending ? <Loading /> : datasets.error ? <ErrorState error={datasets.error} retry={() => datasets.refetch()} /> : !datasets.data?.length ?
      <Empty title={`No ${labels[kind].toLowerCase()} datasets yet`}>Resolve a case in the <Link href="/app/reviews">review inbox</Link>, then publish its frozen evidence and expected behavior.</Empty> :
      <div className="table-frame"><table className="data-table"><thead><tr><th>Dataset / version</th><th style={{ textAlign: "right" }}>Cases</th><th>Published</th><th>Version</th></tr></thead><tbody>{datasets.data.map(value => <tr key={value.id}>
        <td><div className="identity-cell"><strong>{value.name}</strong><code>{value.hash.slice(0, 16)}</code></div></td><td style={{ textAlign: "right" }}>{value.case_count}</td><td>{when(value.created_at)}</td>
        <td><button className="btn secondary small" onClick={() => setSelectedId(value.id)}>Open v{value.version}<ArrowRight size={13} /></button></td>
      </tr>)}</tbody></table></div>}
    {selectedId && <section className="panel" style={{ marginTop: 28 }} aria-label="Published dataset version">
      {detail.isPending ? <Loading /> : detail.error ? <ErrorState error={detail.error} retry={() => detail.refetch()} /> : detail.data && <>
        <div className="section-heading"><h2>{detail.data.name} · version {detail.data.version}</h2><CopyButton value={detail.data.hash} label="Copy hash" /></div>
        <p className="muted">{labels[detail.data.kind]} · {detail.data.cases.length} reviewed cases · published {when(detail.data.createdAt)}</p>
        <div className="form-footer"><CopyButton value={`aq datasets get ${detail.data.id} --json`} label="Copy CLI export" /><button className="btn secondary small" onClick={() => downloadJson(detail.data, `dataset-${detail.data!.id}.json`)}>Export manifest</button>
          {canPublish && <button className="btn secondary small" disabled={replay.isPending} onClick={() => replay.mutate()}>{replay.isPending ? "Assessing frozen cases…" : "Replay frozen cases"}</button>}
          {detail.data.kind === "agent_regression" && <Link href={`/app/experiments?dataset=${detail.data.id}`}>Compare candidate runs<ArrowRight size={13} /></Link>}</div>
        {detail.data.cases.map(value => <details key={value.id} style={{ marginTop: 18 }}><summary><strong>{value.id}</strong> · {"expectedBehavior" in value ? value.expectedBehavior.kind.replaceAll("_", " ") : `${value.stratum} / ${value.humanLabel}`}</summary>
          <p>{"expectedBehavior" in value ? value.expectedBehavior.description : value.humanReview.annotation}</p>
          <p className="muted">Source <Link href={runLink(value.source.runId)}>{value.source.runId}</Link> · {value.source.environment} · revision {value.source.revision} · human review v{value.humanReview.version}</p>
          {value.source.provenance.length > 0 && <p className="quiet-notice compact">Source labels: {value.source.provenance.join(", ")}</p>}
          <details><summary>Frozen manifest and evidence</summary><pre className="report-preview">{pretty(value)}</pre></details>
        </details>)}
        {replay.error && <ErrorState error={replay.error} />}
        {replay.data && <><p className="quiet-notice">Replayed frozen data and stored answers. Customer actions and external requests were not repeated.</p><pre className="report-preview">{pretty(replay.data)}</pre></>}
      </>}
    </section>}
    <Modal open={publishing} onOpenChange={setPublishing} title="Publish reviewed case" description="This immutable version contains one reviewed case. Reuse a dataset name to publish its next complete version.">
      <form onSubmit={event => { event.preventDefault(); setLocalError(""); publish.mutate(); }}>
        <label>Dataset kind<select value={kind} onChange={event => setKind(event.target.value as DatasetKind)}><option value="agent_regression">Agent regression</option><option value="evaluator_calibration">Evaluator calibration</option></select></label>
        <label>Dataset name<input required maxLength={160} value={name} onChange={event => setName(event.target.value)} /></label>
        {reviews.isPending ? <Loading rows={2} /> : reviews.error ? <ErrorState error={reviews.error} retry={() => reviews.refetch()} /> : !reviews.data?.length ? <Empty title="No resolved reviews">Resolve a human review before publishing. <Link href="/app/reviews">Open review inbox</Link></Empty> : <>
          <label>Resolved review<select required value={reviewId} onChange={event => chooseReview(event.target.value)}><option value="">Select a reviewed case</option>{reviews.data.map(review => <option key={review.id} value={review.id}>{review.agent} · {review.run_id} · {review.environment} · {review.decision}</option>)}</select></label>
          {selectedReview && <><p className="quiet-notice compact">Human decision: {selectedReview.decision}. {selectedReview.annotation} Source environment: {selectedReview.environment}.</p>
            <div className="form-two"><label>Reviewed version<input type="number" min={1} required value={reviewVersion} onChange={event => setReviewVersion(Number(event.target.value))} /></label><label>Case ID (optional)<input maxLength={128} value={caseId} onChange={event => setCaseId(event.target.value)} /></label></div>
            {kind === "agent_regression" ? <>
              <label>Expected behavior<select value={behavior} onChange={event => { const next = event.target.value as ExpectedBehavior["kind"]; setBehavior(next); setExecution(next === "honest_failure" ? "failed" : "completed"); if (next === "completion") setOutcomeAssertions({}); }}><option value="completion">Verified completion</option><option value="honest_failure">Honest failure</option><option value="escalation">Escalation</option></select></label>
              <label>Expected behavior description<textarea required minLength={3} maxLength={5000} rows={3} value={description} onChange={event => setDescription(event.target.value)} /></label>
              <label>Allowed execution status<select value={execution} onChange={event => setExecution(event.target.value)}>{(behavior === "completion" ? ["completed"] : ["completed", "failed", "cancelled", "abandoned"]).map(value => <option key={value}>{value}</option>)}</select></label>
              <label>Expected response phrases {behavior === "completion" ? "(optional)" : "(required)"}<textarea required={behavior !== "completion"} rows={2} value={phrases} onChange={event => setPhrases(event.target.value)} aria-describedby="response-phrases-help" /></label>
              <p className="muted" id="response-phrases-help">One literal phrase per line. These assertions check recorded wording; external handoffs still need verification.</p>
              <h3>Source outcome assertions</h3>
              {!selectedReview.assessment?.outcomes.length ? <p className="quiet-notice">This case has no outcome contract. Verified completion needs a required outcome; failure or escalation can assert the recorded response.</p> : selectedReview.assessment.outcomes.map(outcome => <label key={outcome.id}>{outcome.name} · {outcome.required ? "required" : "optional"} · source {outcome.verification}
                <select value={outcomeAssertions[outcome.id] ?? ""} onChange={event => setOutcomeAssertions(old => ({ ...old, [outcome.id]: event.target.value }))}><option value="">{behavior === "completion" && outcome.required ? "Require verified (default)" : "No additional assertion"}</option><option value="verified">Require verified</option>{behavior !== "completion" && <option value="contradicted">Expect contradicted</option>}</select></label>)}
              <p className="quiet-notice compact">Required unknown verification blocks CI by default. A reviewed failure may explicitly expect contradicted outcomes.</p>
            </> : <>
              <label>Human label<select value={humanLabel} onChange={event => setHumanLabel(event.target.value)}><option value="clear">Clear</option><option value="violation">Violation</option></select></label>
              <label>Detector / failure stratum<input required maxLength={160} value={stratum} onChange={event => setStratum(event.target.value)} /></label>
              <p className="quiet-notice">This records a reviewed label. The human corpus, sealed holdout, precision, and activation gates remain separate.</p>
            </>}
          </>}
        </>}
        {localError && <p className="form-error" role="alert">{localError}</p>}
        <div className="form-footer"><button type="button" className="btn secondary" onClick={() => setPublishing(false)}>Cancel</button><button className="btn" disabled={!canPublish || !selectedReview || publish.isPending}>{publish.isPending ? "Publishing…" : "Publish immutable version"}</button></div>
      </form>
    </Modal>
  </>;
}

export function Experiments() {
  const { workspaceId, projectId, role, notify } = useScope(); const client = useQueryClient();
  const canCreate = ["owner", "admin", "member"].includes(role);
  const [creating, setCreating] = useState(false); const [selectedId, setSelectedId] = useState("");
  const [datasetId, setDatasetId] = useState(""); const [policyId, setPolicyId] = useState(""); const [name, setName] = useState("Regression comparison");
  const [candidateName, setCandidateName] = useState("candidate"); const [mode, setMode] = useState<"form" | "json">("form");
  const [mappings, setMappings] = useState<Record<string, string>>({}); const [candidateJson, setCandidateJson] = useState("[]"); const [initializedDataset, setInitializedDataset] = useState("");
  const [evaluateMissing, setEvaluateMissing] = useState(true); const [allowUnknown, setAllowUnknown] = useState(false); const [localError, setLocalError] = useState("");
  const experiments = useScopedQuery<ExperimentSummary[]>("regression-experiments", "/experiments");
  const datasets = useScopedQuery<DatasetSummary[]>("regression-datasets", "/datasets?kind=agent_regression");
  const policies = useScopedQuery<PolicySummary[]>("regression-policies", "/policies");
  const selectedDataset = useScopedQuery<Dataset>("regression-dataset", `/datasets/${datasetId}`, !!datasetId && creating);
  const runs = useQuery<RunSummary[]>({ queryKey: ["regression-candidate-runs", workspaceId, projectId], enabled: !!workspaceId && !!projectId && creating,
    queryFn: async () => (await Promise.all(["test", "staging"].map(environment => api<{ items: RunSummary[] }>(`/runs?${queryString(projectId)}&environment=${environment}&limit=100`, workspaceId)))).flatMap(page => page.items).filter(run => run.execution_status !== "running") });
  const report = useQuery<ComparisonReport>({ queryKey: ["regression-report", workspaceId, projectId, selectedId], enabled: !!workspaceId && !!projectId && !!selectedId,
    queryFn: () => api(`/experiments/${selectedId}?${queryString(projectId)}`, workspaceId), refetchInterval: query => query.state.data?.ready === false ? 2000 : false });
  useEffect(() => {
    setSelectedId(""); setDatasetId(""); setPolicyId(""); setInitializedDataset(""); setCreating(false);
    if (!workspaceId || !projectId) return;
    const params = new URLSearchParams(window.location.search); if (params.get("dataset")) { setDatasetId(params.get("dataset")!); setCreating(true); } if (params.get("experiment")) setSelectedId(params.get("experiment")!);
  }, [workspaceId, projectId]);
  useEffect(() => { if (!policyId && policies.data?.length) setPolicyId((policies.data.find(policy => policy.active) ?? policies.data[0]).id); }, [policies.data, policyId]);
  useEffect(() => {
    if (selectedDataset.data && initializedDataset !== selectedDataset.data.id) {
      const next = Object.fromEntries(selectedDataset.data.cases.map(value => [value.id, ""])); setMappings(next);
      setCandidateJson(pretty([{ name: candidateName, runs: selectedDataset.data.cases.map(value => ({ caseId: value.id, runId: "" })) }])); setInitializedDataset(selectedDataset.data.id);
    }
  }, [selectedDataset.data, initializedDataset, candidateName]);
  const create = useMutation({ mutationFn: async () => {
    const policy = policies.data?.find(value => value.id === policyId);
    let candidates;
    try { candidates = mode === "json" ? JSON.parse(candidateJson) : [{ name: candidateName, runs: Object.entries(mappings).map(([caseId, runId]) => ({ caseId, runId: runId.trim() })) }]; }
    catch { throw new Error("Candidate mappings must be valid JSON."); }
    return api<ComparisonReport>("/experiments", workspaceId, { method: "POST", body: json({ projectId, name, datasetId, datasetHash: selectedDataset.data?.hash, policyId, policyHash: policy?.hash,
      candidates, evaluateMissing, allowRequiredUnknown: allowUnknown }) });
  }, onSuccess: value => { setSelectedId(value.experimentId); client.setQueryData(["regression-report", workspaceId, projectId, value.experimentId], value); void client.invalidateQueries({ queryKey: ["regression-experiments"] }); setCreating(false); notify(value.ready ? "Comparison report saved." : "Experiment saved. Waiting for the pinned evaluations."); },
    onError: error => setLocalError(error.message) });
  if (!projectId) return <Empty title="Select a project">Choose the project whose candidate runs you want to compare.</Empty>;
  const selectedPolicy = policies.data?.find(value => value.id === policyId);
  return <>
    <PageHeader title="Experiments" description="Compare customer-run candidates against one immutable dataset and policy version."
      action={canCreate ? <button className="btn" onClick={() => { setCreating(true); setLocalError(""); }}><Plus size={15} />Compare candidate runs</button> : undefined} />
    {experiments.isPending ? <Loading /> : experiments.error ? <ErrorState error={experiments.error} retry={() => experiments.refetch()} /> : !experiments.data?.length ?
      <Empty title="No saved comparisons">Publish reviewed <Link href="/app/datasets">regression cases</Link>, then map traces from your customer-run test or staging candidates.</Empty> :
      <div className="table-frame"><table className="data-table"><thead><tr><th>Experiment</th><th>Dataset version</th><th>Created</th><th>Report</th></tr></thead><tbody>{experiments.data.map(value => <tr key={value.id}>
        <td><div className="identity-cell"><strong>{value.name}</strong><code>{value.id}</code></div></td><td>{value.dataset_name} · v{value.dataset_version}</td><td>{when(value.created_at)}</td><td><button className="btn secondary small" onClick={() => setSelectedId(value.id)}>Open report<ArrowRight size={13} /></button></td>
      </tr>)}</tbody></table></div>}
    {selectedId && <section className="panel" style={{ marginTop: 28 }} aria-label="Comparison report">
      {report.isPending ? <Loading /> : report.error ? <ErrorState error={report.error} retry={() => report.refetch()} /> : report.data && <ComparisonDetails report={report.data} refresh={() => report.refetch()} />}
    </section>}
    <Modal open={creating} onOpenChange={setCreating} title="Compare candidate runs" description="Map traces produced in your own test infrastructure. This creates a pinned comparison and executes no customer agent code.">
      <form onSubmit={event => { event.preventDefault(); setLocalError(""); create.mutate(); }}>
        <label>Experiment name<input required maxLength={160} value={name} onChange={event => setName(event.target.value)} /></label>
        {datasets.error && <ErrorState error={datasets.error} retry={() => datasets.refetch()} />}
        <label>Regression dataset version<select required value={datasetId} onChange={event => setDatasetId(event.target.value)}><option value="">Select an immutable version</option>{datasets.data?.map(value => <option key={value.id} value={value.id}>{value.name} · v{value.version} · {value.case_count} cases</option>)}</select></label>
        {!datasets.isPending && !datasets.data?.length && <p className="quiet-notice">Publish an <Link href="/app/datasets">agent regression dataset</Link> first. Calibration datasets are excluded.</p>}
        {policies.error && <ErrorState error={policies.error} retry={() => policies.refetch()} />}
        <label>Evaluator policy version<select required value={policyId} onChange={event => setPolicyId(event.target.value)}><option value="">Select a policy</option>{policies.data?.map(value => <option key={value.id} value={value.id}>{value.definition.name} · v{value.version}{value.active ? " · activated" : " · not activated"}</option>)}</select></label>
        {selectedPolicy && !selectedPolicy.active && <p className="quiet-notice compact">Semantic findings stay for review while this selected policy is not activated.</p>}
        {selectedDataset.isPending && datasetId ? <Loading rows={2} /> : selectedDataset.error ? <ErrorState error={selectedDataset.error} retry={() => selectedDataset.refetch()} /> : selectedDataset.data && <>
          <div className="tabs" role="tablist" aria-label="Candidate mapping editor"><button type="button" role="tab" aria-selected={mode === "form"} className={mode === "form" ? "selected" : ""} onClick={() => setMode("form")}>One candidate</button><button type="button" role="tab" aria-selected={mode === "json"} className={mode === "json" ? "selected" : ""} onClick={() => { if (mode === "form") setCandidateJson(pretty([{ name: candidateName, runs: Object.entries(mappings).map(([caseId, runId]) => ({ caseId, runId })) }])); setMode("json"); }}>Multiple candidates / JSON</button></div>
          {mode === "form" ? <>
            <label>Candidate name<input required maxLength={120} value={candidateName} onChange={event => setCandidateName(event.target.value)} /></label>
            <datalist id="regression-run-options">{runs.data?.map(run => <option key={run.id} value={run.id}>{run.agent} · {run.agent_version} · {run.environment} · {run.execution_status}</option>)}</datalist>
            {runs.error && <ErrorState error={runs.error} retry={() => runs.refetch()} />}
            {selectedDataset.data.cases.map(value => <label key={value.id}>Run for {value.id}<input required list="regression-run-options" value={mappings[value.id] ?? ""} onChange={event => setMappings(old => ({ ...old, [value.id]: event.target.value }))} aria-describedby="candidate-runs-help" /></label>)}
            <p className="muted" id="candidate-runs-help">Select a terminal test or staging run, or enter its run ID. Every case needs a distinct run. Submit candidate traces through your SDK or CLI first.</p>
          </> : <label>Candidate mappings JSON<textarea required rows={12} spellCheck={false} value={candidateJson} onChange={event => setCandidateJson(event.target.value)} aria-describedby="candidate-json-help" /><span className="muted" id="candidate-json-help">An array of candidates, each with a name and runs containing caseId, runId, and optional evaluationId. Exact case coverage is checked by the API.</span></label>}
        </>}
        <label className="checkbox-label"><input type="checkbox" checked={evaluateMissing} onChange={event => setEvaluateMissing(event.target.checked)} />Evaluate missing selected-policy revisions</label>
        <label className="checkbox-label"><input type="checkbox" checked={allowUnknown} onChange={event => setAllowUnknown(event.target.checked)} />Explicitly allow required unknown verification</label>
        {allowUnknown && <p className="quiet-notice">Required unknowns remain visible in the report. Explicit verified or contradicted assertions still need evidence.</p>}
        {localError && <p className="form-error" role="alert">{localError}</p>}
        <div className="form-footer"><button type="button" className="btn secondary" onClick={() => setCreating(false)}>Cancel</button><button className="btn" disabled={!canCreate || !selectedDataset.data || !selectedPolicy || create.isPending}>{create.isPending ? "Creating comparison…" : "Create pinned comparison"}</button></div>
      </form>
    </Modal>
  </>;
}

function ComparisonDetails({ report, refresh }: { report: ComparisonReport; refresh: () => unknown }) {
  const cli = `aq report ${report.experimentId} --wait --timeout 120 --format junit --output comparison.xml`;
  return <>
    <div className="section-heading"><h2>{report.name}</h2><Badge value={statusValue(report.status)} label={report.status} /></div>
    <p>{report.dataset.name} v{report.dataset.version} · {report.policy.name} v{report.policy.version}</p>
    <div className="metric-strip" style={{ marginTop: 20 }}><div><span>Passed cases</span><strong>{report.summary.passed}</strong></div><div><span>Failed cases</span><strong>{report.summary.failed}</strong></div><div><span>Indeterminate cases</span><strong>{report.summary.indeterminate}</strong></div><div><span>Required unknown</span><strong>{report.summary.requiredUnknown}</strong></div></div>
    {!report.ready && <p className="quiet-notice">Pinned evaluations are pending. The report refreshes while they process; CI exits with code 2 until a conclusive report is available.</p>}
    {report.summary.requiredUnknown > 0 && <p className="quiet-notice">{report.summary.requiredUnknown} required outcome(s) remain unknown. {report.allowRequiredUnknown ? "This experiment explicitly allows that uncertainty." : "CI blocks this uncertainty by default."}</p>}
    {report.summary.semanticReviewOnly > 0 && <p className="quiet-notice">{report.summary.semanticReviewOnly} semantic finding(s) remain for review. Blocking requires the exact calibrated and activated policy.</p>}
    <div className="form-footer"><CopyButton value={cli} label="Copy CI report command" /><button className="btn secondary small" onClick={() => downloadJson(report, `comparison-${report.experimentId}.json`)}>Export JSON</button><button className="btn secondary small" onClick={() => refresh()}><RotateCw size={13} />Refresh report</button></div>
    {report.candidates.map(candidate => <section key={candidate.name} style={{ marginTop: 28 }}>
      <SectionTitle>{candidate.name} · {candidate.summary.passed}/{candidate.summary.cases} cases passed</SectionTitle>
      <div className="table-frame"><table className="data-table"><thead><tr><th>Case / expected behavior</th><th>Execution</th><th>Quality</th><th>Verification</th><th>Assertion result</th></tr></thead><tbody>{candidate.cases.map(value => <tr key={value.caseId}>
        <td><div className="identity-cell"><strong>{value.caseId}</strong><span className="muted">{value.expectedBehavior.kind.replaceAll("_", " ")}</span><Link href={runLink(value.runId)}>{value.runId}</Link><small className="muted">Pinned revision {value.revision}</small></div></td>
        <td>{value.executionStatus ?? "Pending"}</td><td>{value.qualityDecision ?? "Pending"}</td><td>{value.verification.replaceAll("_", " ")}</td><td><Badge value={statusValue(value.status)} label={value.status} /></td>
      </tr>)}</tbody></table></div>
      {candidate.cases.map(value => <details key={value.caseId} style={{ marginTop: 16 }}><summary>{value.caseId} · assertion evidence</summary><p>{value.expectedBehavior.description}</p>
        {value.assertions.map((assertion, index) => <p key={`${assertion.code}-${index}`}><strong>{assertion.status === "allowed" ? "Review" : assertion.status}</strong> · {assertion.message}</p>)}
        {value.findings.length > 0 && <details><summary>Evaluator findings ({value.findings.length})</summary><pre className="report-preview">{pretty(value.findings)}</pre></details>}
      </details>)}
    </section>)}
    <p className="panel-note">Comparison used frozen evaluations and stored answers. Customer code and external requests were not repeated. Exit code: {report.exitCode}.</p>
    <details><summary>Immutable manifest hashes and semantic gate</summary><pre className="report-preview">{pretty({ dataset: report.dataset, policy: report.policy, createdAt: report.createdAt, generatedAt: report.generatedAt })}</pre></details>
  </>;
}
