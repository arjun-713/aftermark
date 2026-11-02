"use client";
import { SettingsNav } from "./settings-nav";
import { RunDataActions } from "./operations-screens";
import { useEffect, useMemo, useState, useDeferredValue } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  useQuery,
  useMutation,
  useQueryClient,
  useInfiniteQuery,
} from "@tanstack/react-query";
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  type ColumnDef,
} from "@tanstack/react-table";
import {
  ArrowRight,
  ArrowUpRight,
  ArrowLeft,
  Search,
  RotateCw,
  Check,
  Clock,
  GitBranch,
  Terminal,
  Plus,
  ShieldCheck,
  ChevronRight,
  Inbox,
  Play,
  ExternalLink,
} from "lucide-react";
import { useScope } from "./app-shell";
import {
  Badge,
  PageHeader,
  SectionTitle,
  Empty,
  Loading,
  ErrorState,
  Modal,
  CopyButton,
} from "./ui";
import { api, json, pretty, when, ago, RequestError } from "../lib/api";

function useProjectQuery(
  key: string,
  path: string,
  interval?: number,
  enabled = true,
) {
  const { workspaceId, projectId } = useScope();
  return useQuery({
    queryKey: [key, workspaceId, projectId, path],
    queryFn: () =>
      api(
        `${path}${path.includes("?") ? "&" : "?"}projectId=${projectId}`,
        workspaceId,
      ),
    enabled: !!workspaceId && !!projectId && enabled,
    refetchInterval: interval,
  });
}
function useAction(path: string, onSuccess?: (value: any) => void) {
  const s = useScope();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: any) =>
      api(path, s.workspaceId, {
        method: "POST",
        body: json({ ...body, projectId: s.projectId }),
      }),
    onSuccess: (value) => {
      void client.invalidateQueries();
      onSuccess?.(value);
    },
    onError: (error) => {
      if (error instanceof RequestError && error.status === 409)
        void client.invalidateQueries();
      s.notify(error.message);
    },
  });
}
const linkRun = (id: string) => `/app/runs/${encodeURIComponent(id)}`;
const labels: Record<string, string> = {
  pass: "Pass",
  fail: "Fail",
  review: "Review",
  unknown: "Unknown",
  pending: "Pending",
};

export function Overview() {
  const { workspaceId, projectId, authMode } = useScope();
  const query = useQuery({
    queryKey: ["overview", workspaceId, projectId],
    queryFn: () => api(`/overview?projectId=${projectId}`, workspaceId),
    enabled: !!projectId,
    refetchInterval: 15000,
  });
  const connections = useProjectQuery("connections", "/connections");
  if (query.isPending)
    return (
      <>
        <PageHeader
          title="Overview"
          description="Evaluation coverage and outcomes that need a decision."
        />
        <Loading rows={7} />
      </>
    );
  if (query.error)
    return <ErrorState error={query.error} retry={() => query.refetch()} />;
  const { metrics: m, attention } = query.data;
  const segments = [
    ["pass", "Pass", m.passed ?? 0],
    ["fail", "Fail", m.failed],
    ["review", "Review", m.needs_review],
    ["unknown", "Unknown", m.unknown],
    ["pending", "Awaiting evaluation", Math.max(0, m.total - m.evaluated)],
  ];
  return (
    <>
      <PageHeader
        title="Overview"
        description={
          m.failed ? (
            <>
              <strong>
                {m.failed} runs have outcomes contradicted by evidence.
              </strong>{" "}
              Review them before your next release.
            </>
          ) : (
            "Follow the evidence from a completed run to a regression case."
          )
        }
        action={
          <Link className="btn primary" href="/app/reviews">
            Open review inbox
            <ArrowRight size={15} />
          </Link>
        }
      />
      {authMode === "local" && (
        <div className="quiet-notice">
          Development workspace. Sample runs use labeled fixture receipts;
          external provider checks require a connection.
        </div>
      )}
      <div className="metric-strip">
        <div>
          <span>Verified completion</span>
          <strong>
            {m.verified.toLocaleString()}
            <small> / {m.total.toLocaleString()} runs</small>
          </strong>
          <p>Required outcomes observed</p>
        </div>
        <div>
          <span>Evaluation coverage</span>
          <strong>
            {m.coverage === null ? "—" : `${Math.round(m.coverage * 100)}%`}
          </strong>
          <p>{m.evaluated.toLocaleString()} current assessments</p>
        </div>
        <div>
          <span>Waiting for review</span>
          <strong>{m.open_reviews.toLocaleString()}</strong>
          <p>Open or disputed reviews</p>
        </div>
      </div>
      <section className="attention-section">
        <SectionTitle href="/app/runs" link="Explore runs">
          Outcomes that need a decision
        </SectionTitle>
        {!attention.length ? (
          <Empty
            title={
              m.total ? "No unresolved findings" : "Your first run starts here"
            }
            action={
              <Link
                className="btn secondary"
                href={m.total ? "/app/runs" : "/app/onboarding"}
              >
                {m.total ? "Explore runs" : "Instrument an agent"}
                <ArrowRight size={14} />
              </Link>
            }
          >
            {m.total
              ? "Reviewed findings remain available in the run history."
              : "Add the SDK, define an expected outcome, and send a completed run."}
          </Empty>
        ) : (
          <div className="attention-list">
            {attention.slice(0, 3).map((run: any) => (
              <article className="attention-row" key={run.id}>
                <div className="attention-identity">
                  <Link href={linkRun(run.id)}>
                    {run.agent}
                    <ArrowUpRight size={14} />
                  </Link>
                  <span>
                    <code>{run.agent_version}</code> · {ago(run.started_at)}
                  </span>
                  <Badge
                    value={run.assessment.decision}
                    label={labels[run.assessment.decision]}
                  />
                </div>
                <div>
                  <span className="field-label">Agent claim</span>
                  <p className="claim-preview">
                    “{run.claim ?? "No final response is recorded."}”
                  </p>
                </div>
                <div>
                  <span className="field-label">Expected outcome</span>
                  <p>
                    {run.assessment.outcomes[0]?.name ??
                      "No explicit outcome configured"}
                  </p>
                  <span className="muted small">
                    {run.assessment.outcomes[0]?.verification ??
                      "Coverage unknown"}
                  </span>
                </div>
                <div className="attention-observation">
                  <span className="field-label">Recorded evidence</span>
                  <p>
                    {run.observations?.find((o: any) => o.status === "observed")
                      ? Object.entries(
                          run.observations.find(
                            (o: any) => o.status === "observed",
                          ).properties ?? {},
                        )
                          .map(([k, v]) => `${k}: ${String(v)}`)
                          .join(" · ")
                      : "No applicable independent observation"}
                  </p>
                  <Link href={linkRun(run.id)}>
                    Inspect evidence
                    <ArrowRight size={13} />
                  </Link>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      <div className="overview-bottom">
        <section className="panel">
          <SectionTitle>Assessment decisions</SectionTitle>
          <p className="muted">
            All retained runs · refreshed {when(query.data.updatedAt)}
          </p>
          <div
            className="distribution"
            aria-label="Assessment decision distribution"
          >
            {segments.map(
              ([key, label, count]) =>
                Number(count) > 0 && (
                  <span
                    key={String(key)}
                    className={`segment segment-${key}`}
                    style={{
                      width: `${(Number(count) / Math.max(m.total, 1)) * 100}%`,
                    }}
                    title={`${label}: ${count}`}
                  />
                ),
            )}
          </div>
          <div className="distribution-legend">
            {segments.map(([key, label, count]) => (
              <div key={String(key)}>
                <span className={`legend-mark mark-${key}`} />
                <span>{label}</span>
                <strong>{Number(count).toLocaleString()}</strong>
              </div>
            ))}
          </div>
          <p className="panel-note">
            Quality decisions describe current frozen revisions. Missing
            evidence keeps an outcome unknown.
          </p>
        </section>
        <section className="panel">
          <SectionTitle href="/app/onboarding" link="Setup guide">
            Verification readiness
          </SectionTitle>
          <div className="readiness-row">
            <span>
              <Terminal size={15} />
              Agent telemetry
            </span>
            <Badge
              value={m.total ? "connected" : "pending"}
              label={m.total ? "Receiving runs" : "Waiting for a run"}
            />
          </div>
          <div className="readiness-row">
            <span>
              <ShieldCheck size={15} />
              Independent connections
            </span>
            <span>
              {connections.data?.connections.filter(
                (c: any) => c.status === "connected",
              ).length ?? 0}{" "}
              connected
            </span>
          </div>
          <div className="readiness-row">
            <span>
              <GitBranch size={15} />
              Regression workflow
            </span>
            <Link href="/app/datasets">
              Curate a reviewed case
              <ArrowUpRight size={13} />
            </Link>
          </div>
          <p className="panel-note">
            Unknown outcomes stay visible. A successful tool response alone
            cannot establish verified completion.
          </p>
        </section>
      </div>
    </>
  );
}

export function Runs() {
  const { workspaceId, projectId } = useScope();
  const [search, setSearch] = useState("");
  const deferred = useDeferredValue(search);
  const [decision, setDecision] = useState("");
  const [environment, setEnvironment] = useState("");
  const [version, setVersion] = useState("");
  const [agent, setAgent] = useState("");
  const [from, setFrom] = useState("");
  const params = new URLSearchParams({
    projectId,
    ...(deferred ? { search: deferred } : {}),
    ...(decision ? { decision } : {}),
    ...(environment ? { environment } : {}),
    ...(version ? { version } : {}),
    ...(agent ? { agent } : {}),
    ...(from ? { from: new Date(from).toISOString() } : {}),
    limit: "50",
  });
  const query = useInfiniteQuery({
    queryKey: ["runs", workspaceId, projectId, params.toString()],
    queryFn: ({ pageParam }) =>
      api(
        `/runs?${params}${pageParam ? `&cursor=${pageParam}` : ""}`,
        workspaceId,
      ),
    initialPageParam: "",
    getNextPageParam: (page: any) => page.nextCursor ?? undefined,
    enabled: !!projectId,
    refetchInterval: 15000,
  });
  const data = useMemo(
    () => query.data?.pages.flatMap((p) => p.items) ?? [],
    [query.data],
  );
  const columns = useMemo<ColumnDef<any>[]>(
    () => [
      {
        header: "Run / agent",
        accessorKey: "id",
        cell: ({ row }) => (
          <div className="identity-cell">
            <Link href={linkRun(row.original.id)}>{row.original.agent}</Link>
            <code>{row.original.id}</code>
          </div>
        ),
      },
      {
        header: "Version",
        accessorKey: "agent_version",
        cell: ({ getValue }) => <code>{String(getValue())}</code>,
      },
      {
        header: "Environment",
        accessorKey: "environment",
        cell: ({ getValue }) => (
          <span className="neutral-tag">{String(getValue())}</span>
        ),
      },
      {
        header: "Execution",
        accessorKey: "execution_status",
        cell: ({ getValue }) => (
          <span className="muted">{String(getValue())}</span>
        ),
      },
      {
        header: "Quality",
        accessorKey: "decision",
        cell: ({ row }) => (
          <div>
            <Badge
              value={row.original.decision}
              label={labels[row.original.decision] ?? "Pending"}
            />
            {row.original.evaluated_revision &&
              row.original.evaluated_revision !== row.original.revision && (
                <small className="stale-label">New revision pending</small>
              )}
          </div>
        ),
      },
      {
        header: "Started",
        accessorKey: "started_at",
        cell: ({ getValue }) => (
          <span className="tabular muted" title={when(String(getValue()))}>
            {ago(String(getValue()))}
          </span>
        ),
      },
    ],
    [],
  );
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });
  return (
    <>
      <PageHeader
        title="Runs"
        description="Execution is what happened. Quality is what the evidence supports."
        action={
          <Link className="btn secondary" href="/app/onboarding">
            Add traces
            <Plus size={14} />
          </Link>
        }
      />
      <div className="tabs" aria-label="Quality filters">
        {["", "fail", "review", "unknown", "pass"].map((d) => (
          <button
            className={decision === d ? "selected" : ""}
            onClick={() => setDecision(d)}
            key={d}
          >
            {d ? labels[d] : "All runs"}
          </button>
        ))}
      </div>
      <div className="filter-bar">
        <label className="search-field">
          <Search size={15} />
          <input
            aria-label="Search runs"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search runs or agents…"
          />
        </label>
        <select
          aria-label="Environment"
          value={environment}
          onChange={(e) => setEnvironment(e.target.value)}
        >
          <option value="">All environments</option>
          {["production", "staging", "test"].map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
        <input
          className="filter-input"
          aria-label="Agent filter"
          placeholder="Agent name"
          value={agent}
          onChange={(e) => setAgent(e.target.value)}
        />
        <input
          className="filter-input"
          aria-label="Version filter"
          placeholder="Version"
          value={version}
          onChange={(e) => setVersion(e.target.value)}
        />
        <input
          aria-label="From date"
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <span className="results-count">
          {query.data?.pages[0].total ?? "—"} runs
        </span>
      </div>
      {query.error ? (
        <ErrorState error={query.error} retry={() => query.refetch()} />
      ) : query.isPending ? (
        <Loading rows={8} />
      ) : !data.length ? (
        <Empty title="No runs match these filters">
          Change a filter, or send a run with the SDK.
        </Empty>
      ) : (
        <>
          <div className="table-frame">
            <table className="data-table runs-table">
              <thead>
                {table.getHeaderGroups().map((group) => (
                  <tr key={group.id}>
                    {group.headers.map((h) => (
                      <th key={h.id}>
                        {flexRender(h.column.columnDef.header, h.getContext())}
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody>
                {table.getRowModel().rows.map((row) => (
                  <tr key={row.id}>
                    {row.getVisibleCells().map((cell) => (
                      <td
                        data-label={String(cell.column.columnDef.header)}
                        key={cell.id}
                      >
                        {flexRender(
                          cell.column.columnDef.cell,
                          cell.getContext(),
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="table-footer">
            <span>
              Showing {data.length} of {query.data?.pages[0].total} runs
            </span>
            {query.hasNextPage && (
              <button
                className="btn secondary"
                disabled={query.isFetchingNextPage}
                onClick={() => query.fetchNextPage()}
              >
                {query.isFetchingNextPage ? "Loading…" : "Load more"}
              </button>
            )}
            <span>Times in your local timezone</span>
          </div>
        </>
      )}
    </>
  );
}

function EvidenceComparison({ run }: { run: any }) {
  const evaluation = run.evaluations?.[0];
  const assessment = evaluation?.assessment;
  const claim = run.events?.findLast(
    (e: any) =>
      ["run.completed", "run.failed", "message"].includes(e.kind) &&
      e.payload.text,
  )?.payload.text;
  const sample = run.events?.some((e: any) => e.payload.metadata?.sample);
  return (
    <>
      {sample && (
        <div className="quiet-notice compact">
          Sample trace · observations are development fixture receipts.
        </div>
      )}
      <div className="evidence-grid">
        <section className="evidence-pane">
          <h3>Agent claim</h3>
          <blockquote>
            {claim ? `“${claim}”` : "No final response is recorded."}
          </blockquote>
          <span className="muted small">Reported by the customer agent</span>
        </section>
        <section className="evidence-pane">
          <h3>Expected outcome</h3>
          {assessment?.outcomes.length ? (
            assessment.outcomes.map((o: any) => (
              <div className="outcome-item" key={o.id}>
                <strong>{o.name}</strong>
                <Badge value={o.verification} />
                <p>{o.reason}</p>
              </div>
            ))
          ) : (
            <p>
              No explicit expected outcome was configured. Overall verified
              completion is unavailable.
            </p>
          )}
        </section>
        <section className="evidence-pane">
          <h3>Recorded observation</h3>
          {run.evidence?.length ? (
            run.evidence.map((record: any) => (
              <details className="observation" open key={record.id}>
                <summary>
                  {record.body.provider}
                  <ChevronRight size={13} />
                </summary>
                <span className="provenance">
                  {record.body.source.replaceAll("_", " ")}
                </span>
                {record.body.status === "observed" ? (
                  <dl>
                    {Object.entries(record.body.properties ?? {}).map(
                      ([key, value]) => (
                        <div key={key}>
                          <dt>{key}</dt>
                          <dd>
                            <code>
                              {typeof value === "object"
                                ? json(value)
                                : String(value)}
                            </code>
                          </dd>
                        </div>
                      ),
                    )}
                  </dl>
                ) : (
                  <p>
                    {record.body.reason ??
                      "The verifier could not observe the record."}
                  </p>
                )}
                <small>{when(record.body.observedAt)}</small>
              </details>
            ))
          ) : (
            <div className="missing-observation">
              <Clock size={18} />
              <p>No independent observation.</p>
              <Link href="/app/connections">
                Check connections
                <ArrowUpRight size={13} />
              </Link>
            </div>
          )}
        </section>
      </div>
      {assessment?.limitations.length > 0 && (
        <div className="limitations">
          <strong>Coverage limitations</strong>
          {assessment.limitations.map((text: string) => (
            <p key={text}>{text}</p>
          ))}
        </div>
      )}
    </>
  );
}
export function RunDetail({ runId }: { runId: string }) {
  const query = useProjectQuery(
    `run-${runId}`,
    `/runs/${encodeURIComponent(runId)}`,
    5000,
  );
  const [tab, setTab] = useState("evidence");
  const s = useScope();
  const evaluate = useAction(
    `/runs/${encodeURIComponent(runId)}/evaluate`,
    () => s.notify("Evaluation queued for the current revision."),
  );
  const retryQuota = useAction(
    `/evaluations/${query.data?.evaluations?.[0]?.id ?? "unknown"}/retry`,
    () =>
      s.notify(
        "Frozen evaluation queued. Its previous error remains in attempt history.",
      ),
  );
  if (query.isPending) return <Loading rows={8} />;
  if (query.error)
    return <ErrorState error={query.error} retry={() => query.refetch()} />;
  const run = query.data;
  const latest = run.evaluations[0];
  const task = run.events.find((e: any) => e.kind === "run.started")?.payload
    .metadata?.task;
  return (
    <>
      <Link className="back-link" href="/app/runs">
        <ArrowLeft size={13} />
        All runs
      </Link>
      <PageHeader
        title={
          typeof task === "string" && task.trim()
            ? task.slice(0, 200)
            : run.agent
        }
        description={
          <>
            <code>{run.id}</code>
            <span className="separator">·</span>
            {run.agent}
            <span className="separator">·</span>
            <code>{run.agent_version}</code>
          </>
        }
        action={
          latest?.processing === "error" ? (
            <button
              className="btn secondary"
              disabled={retryQuota.isPending || s.role === "viewer"}
              onClick={() => retryQuota.mutate({})}
            >
              {retryQuota.isPending
                ? "Queuing…"
                : "Retry after restoring allowance"}
            </button>
          ) : (
            <button
              className="btn secondary"
              disabled={evaluate.isPending || s.role === "viewer"}
              onClick={() => evaluate.mutate({})}
            >
              <RotateCw size={14} />
              {evaluate.isPending ? "Queuing…" : "Evaluate now"}
            </button>
          )
        }
      />
      <RunDataActions runId={runId} />
      <div className="run-summary">
        <div>
          <span>Quality</span>
          <Badge
            value={latest?.assessment?.decision}
            label={labels[latest?.assessment?.decision] ?? "Pending"}
          />
        </div>
        <div>
          <span>Execution</span>
          <strong>{run.execution_status}</strong>
        </div>
        <div>
          <span>Processing</span>
          <strong>{latest?.processing ?? "pending"}</strong>
        </div>
        <div>
          <span>Revision</span>
          <code>{run.revision}</code>
        </div>
        <div>
          <span>Environment</span>
          <strong>{run.environment}</strong>
        </div>
        <div>
          <span>Started</span>
          <strong>{when(run.started_at)}</strong>
        </div>
      </div>
      {latest && latest.revision !== run.revision && (
        <div className="quiet-notice">
          New evidence arrived. The current assessment covers revision{" "}
          {latest.revision}; revision {run.revision} is awaiting evaluation.
        </div>
      )}
      <div className="tabs">
        {[
          ["evidence", "Claim & evidence"],
          ["timeline", `Timeline · ${run.events.length}`],
          ["history", `Evaluation history · ${run.evaluations.length}`],
        ].map(([id, label]) => (
          <button
            key={id}
            className={tab === id ? "selected" : ""}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "evidence" ? (
        <>
          <EvidenceComparison run={run} />
          <SectionTitle>Findings</SectionTitle>
          {latest?.assessment?.findings.length ? (
            <div className="findings-list">
              {latest.assessment.findings.map((f: any) => (
                <article key={f.id}>
                  <Badge value={f.severity} label={f.severity} />
                  <div>
                    <h3>{f.code.replaceAll("_", " ")}</h3>
                    <p>{f.summary}</p>
                    <span className="muted small">
                      {f.evidenceIds.length} linked evidence references
                      {f.probability !== undefined
                        ? ` · returned probability ${(f.probability * 100).toFixed(1)}%; not guaranteed correctness`
                        : ""}
                    </span>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <Empty
              title={latest ? "No findings emitted" : "Evaluation is pending"}
            >
              {latest
                ? "The assessment above describes its verification coverage."
                : "The durable worker will process this revision."}
            </Empty>
          )}
          <div className="detail-actions">
            {run.reviews[0] && (
              <Link
                className="btn primary"
                href={`/app/reviews?review=${run.reviews[0].id}`}
              >
                Review this run
                <ArrowRight size={14} />
              </Link>
            )}
            <Link
              className="btn secondary"
              href={`/app/datasets?run=${encodeURIComponent(run.id)}`}
            >
              Create regression case
              <GitBranch size={14} />
            </Link>
          </div>
        </>
      ) : tab === "timeline" ? (
        <div className="timeline">
          {run.events.map((e: any) => (
            <details
              key={e.eventId}
              className={`timeline-event ${e.kind === "tool.result" && e.payload.success === false ? "event-failed" : ""}`}
            >
              <summary>
                <span className="timeline-marker" />
                <time>{new Date(e.timestamp).toLocaleTimeString()}</time>
                <strong>
                  {e.payload.tool ??
                    e.payload.name ??
                    e.kind.replaceAll(".", " · ")}
                </strong>
                <span className="event-kind">{e.kind}</span>
                <ChevronRight size={14} />
              </summary>
              {e.payload.text && <p>{e.payload.text}</p>}
              <pre>{pretty(e.payload)}</pre>
              <code className="event-id">{e.eventId}</code>
            </details>
          ))}
        </div>
      ) : (
        <div className="history-list">
          {run.evaluations.map((e: any) => (
            <article key={e.id}>
              <div>
                <strong>Revision {e.revision}</strong>
                <p>{when(e.created_at)}</p>
              </div>
              <Badge value={e.assessment?.decision} />
              <div>
                <span className="muted small">Policy hash</span>
                <code className="hash">{e.policy_hash}</code>
              </div>
              <div>
                <span className="muted small">Processing</span>
                <p>
                  {e.processing} ·{" "}
                  {e.assessment?.model ?? "Deterministic checks"}
                </p>
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}

export function Reviews() {
  const s = useScope();
  const [status, setStatus] = useState("open");
  const [assigned, setAssigned] = useState("all");
  const [selected, setSelected] = useState("");
  const [mobileDetail, setMobileDetail] = useState(false);
  const [decision, setDecision] = useState("fail");
  const [annotation, setAnnotation] = useState("");
  const [disagree, setDisagree] = useState(false);
  const query = useProjectQuery(
    "reviews",
    `/reviews?status=${status}&assigned=${assigned}`,
    10000,
  );
  useEffect(() => {
    if (query.data) {
      const initial = new URLSearchParams(location.search).get("review");
      if (!selected || !query.data.some((r: any) => r.id === selected))
        setSelected(
          query.data.find((r: any) => r.id === initial)?.id ??
            query.data[0]?.id ??
            "",
        );
    }
  }, [query.data, selected]);
  const review = query.data?.find((r: any) => r.id === selected);
  const run = useProjectQuery(
    `review-context-${selected}`,
    `/reviews/${selected || "none"}/context`,
    undefined,
    !!review,
  );
  const claim = useAction(`/reviews/${selected}/claim`, () =>
    s.notify("Review claimed."),
  );
  const decide = useAction(`/reviews/${selected}/decisions`, () => {
    s.notify("Review decision recorded.");
    setAnnotation("");
    setSelected("");
    setMobileDetail(false);
  });
  useEffect(() => {
    const keyboard = (e: KeyboardEvent) => {
      if (
        ["INPUT", "TEXTAREA", "SELECT"].includes(
          (e.target as HTMLElement)?.tagName,
        ) ||
        e.metaKey ||
        e.ctrlKey
      )
        return;
      const rows = query.data ?? [];
      const index = rows.findIndex((r: any) => r.id === selected);
      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        const next =
          rows[
            Math.max(
              0,
              Math.min(rows.length - 1, index + (e.key === "j" ? 1 : -1)),
            )
          ];
        if (next) setSelected(next.id);
      }
    };
    document.addEventListener("keydown", keyboard);
    return () => document.removeEventListener("keydown", keyboard);
  }, [query.data, selected]);
  return (
    <>
      <PageHeader
        title="Review inbox"
        description="Resolve a finding with evidence. Human decisions preserve the original assessment."
        action={
          <span className="keyboard-hint">
            <kbd>J</kbd>
            <kbd>K</kbd> to navigate
          </span>
        }
      />
      <div className="tabs">
        {["open", "disputed", "resolved", "all"].map((v) => (
          <button
            key={v}
            className={status === v ? "selected" : ""}
            onClick={() => setStatus(v)}
          >
            {v[0].toUpperCase() + v.slice(1)}
          </button>
        ))}
      </div>
      <div className="filter-bar">
        <select
          aria-label="Review assignment"
          value={assigned}
          onChange={(e) => setAssigned(e.target.value)}
        >
          <option value="all">All reviewers</option>
          <option value="mine">Assigned to me</option>
          <option value="unassigned">Unassigned</option>
        </select>
        <span className="muted">{query.data?.length ?? "—"} reviews</span>
      </div>
      {query.error ? (
        <ErrorState error={query.error} retry={() => query.refetch()} />
      ) : query.isPending ? (
        <Loading rows={6} />
      ) : !query.data.length ? (
        <Empty
          title="The inbox is clear"
          action={
            <Link className="btn secondary" href="/app/runs">
              Explore runs
              <ArrowRight size={14} />
            </Link>
          }
        >
          Findings and uncertain outcomes appear here when evaluations complete.
        </Empty>
      ) : (
        <div className="review-workspace" data-detail={mobileDetail}>
          <div className="review-list" aria-label="Review queue">
            {query.data.map((r: any) => (
              <button
                key={r.id}
                aria-pressed={selected === r.id}
                className={`review-list-item ${selected === r.id ? "selected" : ""}`}
                onClick={() => {
                  setSelected(r.id);
                  setMobileDetail(true);
                  setAnnotation("");
                }}
              >
                <div>
                  <Badge value={r.assessment?.decision} />
                  <span>{ago(r.created_at)}</span>
                </div>
                <strong>{r.agent}</strong>
                <p>
                  {r.assessment?.findings[0]?.summary ??
                    "This run has incomplete verification coverage."}
                </p>
                <small>
                  {r.assigned_to === s.user?.id
                    ? "Assigned to you"
                    : r.assigned_to
                      ? "Assigned to another reviewer"
                      : "Unassigned"}{" "}
                  · rev {r.evaluated_revision}
                </small>
              </button>
            ))}
          </div>
          <section className="review-detail">
            {review && (
              <>
                <button
                  className="back-link mobile-back"
                  onClick={() => setMobileDetail(false)}
                >
                  <ArrowLeft size={13} />
                  Back to inbox
                </button>
                <div className="review-detail-heading">
                  <div>
                    <h2>{review.agent}</h2>
                    <Link href={linkRun(review.run_id)}>
                      <code>{review.run_id}</code>
                      <ArrowUpRight size={13} />
                    </Link>
                  </div>
                  <span className="neutral-tag">Review v{review.version}</span>
                </div>
                {review.evaluated_revision !== review.current_revision && (
                  <div className="quiet-notice compact">
                    This review covers an earlier revision. Inspect the current
                    run before deciding.
                  </div>
                )}
                {run.isPending ? (
                  <Loading rows={3} />
                ) : run.error ? (
                  <ErrorState error={run.error} retry={() => run.refetch()} />
                ) : (
                  <EvidenceComparison run={run.data} />
                )}
                <div className="review-form">
                  <div className="review-ownership">
                    <span>
                      {review.assigned_to === s.user?.id
                        ? "You are reviewing this run."
                        : review.assigned_to
                          ? "Another reviewer has this run."
                          : "Claim this review to record a decision."}
                    </span>
                    {!review.assigned_to && s.role !== "viewer" && (
                      <button
                        className="btn primary"
                        onClick={() =>
                          claim.mutate({ expectedVersion: review.version })
                        }
                        disabled={claim.isPending}
                      >
                        {claim.isPending ? "Claiming…" : "Claim review"}
                      </button>
                    )}
                  </div>
                  {review.assigned_to === s.user?.id && s.role !== "viewer" ? (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        decide.mutate({
                          expectedVersion: review.version,
                          decision,
                          annotation,
                          disagree,
                        });
                      }}
                    >
                      <div className="form-two">
                        <label>
                          Human quality decision
                          <select
                            value={decision}
                            onChange={(e) => setDecision(e.target.value)}
                          >
                            <option value="fail">
                              Fail — required result contradicted
                            </option>
                            <option value="pass">
                              Pass — requirements satisfied
                            </option>
                            <option value="unknown">
                              Unknown — more context needed
                            </option>
                          </select>
                        </label>
                        <label className="checkbox-label">
                          <input
                            type="checkbox"
                            checked={disagree}
                            onChange={(e) => setDisagree(e.target.checked)}
                          />
                          Flag evaluator disagreement
                        </label>
                      </div>
                      <label>
                        Review note
                        <textarea
                          value={annotation}
                          onChange={(e) => setAnnotation(e.target.value)}
                          minLength={3}
                          maxLength={5000}
                          required
                          placeholder="What evidence supports your decision?"
                          rows={3}
                        />
                      </label>
                      <div className="form-footer">
                        <Link href={`/app/datasets?review=${review.id}`}>
                          Promote to regression
                          <GitBranch size={14} />
                        </Link>
                        <button
                          className="btn primary"
                          disabled={decide.isPending}
                        >
                          {decide.isPending ? "Recording…" : "Record decision"}
                          <Check size={14} />
                        </button>
                      </div>
                    </form>
                  ) : s.role === "viewer" ? (
                    <p className="muted">
                      Your viewer role has read-only access. A member, admin or
                      owner can record a review.
                    </p>
                  ) : review.status === "resolved" ? (
                    <p>{review.annotation}</p>
                  ) : null}
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </>
  );
}

export function Policies() {
  const s = useScope();
  const query = useProjectQuery("policies", "/policies");
  const [selected, setSelected] = useState("");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [runId, setRunId] = useState("");
  const [preview, setPreview] = useState<any>();
  const policy = query.data?.find((p: any) => p.id === selected);
  useEffect(() => {
    if (query.data?.length && !selected) {
      setSelected(query.data[0].id);
      setDraft(pretty(query.data[0].definition));
    }
  }, [query.data, selected]);
  const create = useAction("/policies", (value) => {
    setSelected(value.id);
    setDraft(pretty(value.definition));
    s.notify(`Policy version ${value.version} saved as a draft.`);
  });
  const activate = useAction(`/policies/${selected}/activate`, () =>
    s.notify("Policy version activated for future evaluations."),
  );
  const previewAction = useAction(`/policies/${selected}/preview`, setPreview);
  return (
    <>
      <PageHeader
        title="Policies"
        description="Immutable checks and thresholds. Activate a version when it is ready."
      />
      {query.error ? (
        <ErrorState error={query.error} retry={() => query.refetch()} />
      ) : query.isPending ? (
        <Loading rows={5} />
      ) : (
        <div className="policy-layout">
          <aside className="version-list">
            <h2>Policy versions</h2>
            {query.data.map((p: any) => (
              <button
                className={selected === p.id ? "selected" : ""}
                key={p.id}
                onClick={() => {
                  setSelected(p.id);
                  setDraft(pretty(p.definition));
                  setError("");
                }}
              >
                <span>
                  Version {p.version}
                  {p.active && <span className="active-label">Active</span>}
                </span>
                <strong>{p.definition.name}</strong>
                <small>{when(p.created_at)}</small>
              </button>
            ))}
          </aside>
          <section className="policy-editor">
            <div className="section-heading">
              <h2>{policy?.definition.name ?? "Policy draft"}</h2>
              <span className="neutral-tag">
                {policy?.active ? "Active version" : "Draft version"}
              </span>
            </div>
            <p className="muted">
              Deterministic checks always retain uncertainty. Semantic checks
              require a configured provider; blocking checks also require a
              passed calibration report.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                try {
                  setError("");
                  create.mutate({ definition: JSON.parse(draft) });
                } catch {
                  setError("The policy must be valid JSON.");
                }
              }}
            >
              <label>
                Policy definition
                <textarea
                  className="code-editor"
                  spellCheck={false}
                  rows={17}
                  value={draft}
                  readOnly={!["owner", "admin"].includes(s.role)}
                  onChange={(e) => setDraft(e.target.value)}
                />
              </label>
              {error && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
              <div className="form-footer">
                <span className="muted small">
                  Saving creates a new immutable version.
                </span>
                <button
                  className="btn primary"
                  disabled={
                    create.isPending || !["owner", "admin"].includes(s.role)
                  }
                >
                  {create.isPending ? "Saving…" : "Save new version"}
                </button>
              </div>
            </form>
            <div className="policy-actions">
              <button
                className="btn secondary"
                disabled={
                  policy?.active ||
                  activate.isPending ||
                  !["owner", "admin"].includes(s.role)
                }
                onClick={() => activate.mutate({})}
              >
                <Check size={14} />
                Activate selected version
              </button>
              <div className="joined-input">
                <input
                  aria-label="Run ID for policy preview"
                  placeholder="Run ID for preview"
                  value={runId}
                  onChange={(e) => setRunId(e.target.value)}
                />
                <button
                  className="btn secondary"
                  disabled={
                    !runId || previewAction.isPending || s.role === "viewer"
                  }
                  onClick={() => previewAction.mutate({ runId })}
                >
                  <Play size={13} />
                  Preview
                </button>
              </div>
            </div>
            <p className="muted small">
              Preview reuses frozen observations and makes no provider requests.
            </p>
          </section>
        </div>
      )}
      <Modal
        open={!!preview}
        onOpenChange={(open) => !open && setPreview(undefined)}
        title="Policy preview"
        description="Deterministic replay of frozen evidence. Semantic checks may remain unknown."
      >
        <pre className="report-preview">{pretty(preview?.assessment)}</pre>
      </Modal>
    </>
  );
}

export function Connections() {
  const s = useScope();
  const query = useProjectQuery("connections", "/connections");
  const [starting, setStarting] = useState("");
  const client = useQueryClient();
  const connect = async (provider: string) => {
    try {
      setStarting(provider);
      const result = await api(
        `/connections/${provider}/authorize`,
        s.workspaceId,
        { method: "POST", body: json({ projectId: s.projectId }) },
      );
      location.href = result.url;
    } catch (error) {
      s.notify((error as Error).message);
    } finally {
      setStarting("");
    }
  };
  const check = async (id: string) => {
    try {
      const result = await api(`/connections/${id}/check`, s.workspaceId, {
        method: "POST",
        body: json({ projectId: s.projectId }),
      });
      s.notify(`Connection is ${result.status}.`);
      void client.invalidateQueries({ queryKey: ["connections"] });
    } catch (error) {
      s.notify((error as Error).message);
    }
  };
  const [disconnect, setDisconnect] = useState<any>();
  return (
    <>
      <PageHeader
        title="Connections"
        description="Read-only state observations from your systems. Provenance stays attached to every result."
      />
      {query.error ? (
        <ErrorState error={query.error} retry={() => query.refetch()} />
      ) : query.isPending ? (
        <Loading rows={4} />
      ) : (
        <>
          <div className="connection-list">
            {[
              [
                "github",
                "GitHub Issues",
                "Observe issue existence and configured properties. The App requests Issues and Metadata read permissions.",
              ],
              [
                "hubspot",
                "HubSpot Contacts",
                "Observe only the contact properties defined by your outcomes. OAuth requests contact read permissions.",
              ],
            ].map(([provider, name, description]) => {
              const connection = query.data.connections.find(
                (c: any) => c.provider === provider,
              );
              const configured = query.data.configuration[provider];
              return (
                <section key={provider} className="connection-row">
                  <div className="provider-wordmark">
                    {provider === "github" ? (
                      <GitBranch size={24} strokeWidth={1.4} />
                    ) : (
                      <span className="hubspot-symbol">H</span>
                    )}
                    <div>
                      <h2>{name}</h2>
                      <p>{description}</p>
                    </div>
                  </div>
                  <div className="connection-state">
                    <Badge value={connection?.status ?? "disconnected"} />
                    {connection && (
                      <small>
                        {connection.name} ·{" "}
                        {connection.last_checked_at
                          ? `Checked ${ago(connection.last_checked_at)}`
                          : "Not checked yet"}
                      </small>
                    )}
                    {!configured && (
                      <small>
                        Platform credentials are required before connecting.
                      </small>
                    )}
                  </div>
                  <div className="connection-actions">
                    {connection ? (
                      <>
                        <button
                          className="btn secondary"
                          disabled={s.role === "viewer" || s.role === "member"}
                          onClick={() => check(connection.id)}
                        >
                          Check health
                        </button>
                        <button
                          className="btn text-button"
                          onClick={() => setDisconnect(connection)}
                          disabled={!["owner", "admin"].includes(s.role)}
                        >
                          Disconnect
                        </button>
                      </>
                    ) : (
                      <button
                        className="btn secondary"
                        disabled={
                          !configured ||
                          !["owner", "admin"].includes(s.role) ||
                          starting === provider
                        }
                        onClick={() => connect(provider)}
                      >
                        {starting === provider
                          ? "Connecting…"
                          : `Connect ${provider === "github" ? "GitHub" : "HubSpot"}`}
                        <ArrowUpRight size={13} />
                      </button>
                    )}
                  </div>
                </section>
              );
            })}
          </div>
          <section className="settings-row">
            <div>
              <h2>Customer-operated verifier</h2>
              <p>
                Submit signed observations from your infrastructure with a
                separate verifier credential.
              </p>
            </div>
            <div className="settings-panel">
              <h3>Visible, independent provenance</h3>
              <p>
                Customer receipts retain their source. An ingestion key cannot
                submit a provider-verified record.
              </p>
              <KeyCreator initialScope="verifier" />
              <Link className="inline-link" href="/help#verifiers">
                Receipt signing guide
                <ArrowUpRight size={13} />
              </Link>
            </div>
          </section>
        </>
      )}
      <Modal
        open={!!disconnect}
        onOpenChange={(open) => !open && setDisconnect(undefined)}
        title="Disconnect provider"
        description={`This deletes the platform credential for ${disconnect?.name ?? "this connection"}. Future checks will remain unknown until it is reconnected.`}
      >
        <div className="form-footer">
          <button
            className="btn secondary"
            onClick={() => setDisconnect(undefined)}
          >
            Keep connection
          </button>
          <button
            className="btn danger"
            onClick={async () => {
              try {
                await api(
                  `/connections/${disconnect.id}?projectId=${s.projectId}`,
                  s.workspaceId,
                  { method: "DELETE" },
                );
                setDisconnect(undefined);
                s.notify("Connection removed.");
                void client.invalidateQueries({ queryKey: ["connections"] });
              } catch (error) {
                s.notify((error as Error).message);
              }
            }}
          >
            Disconnect
          </button>
        </div>
      </Modal>
    </>
  );
}

export function KeyCreator({
  initialScope = "ingest",
}: {
  initialScope?: string;
}) {
  const s = useScope();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(
    initialScope === "verifier" ? "Customer verifier" : "Agent ingestion",
  );
  const [scope, setScope] = useState(initialScope);
  const [created, setCreated] = useState<any>();
  const create = useAction("/keys", (value) => setCreated(value));
  return (
    <>
      <button
        className="btn secondary"
        disabled={!["owner", "admin"].includes(s.role)}
        onClick={() => setOpen(true)}
      >
        <Plus size={14} />
        Create {initialScope === "verifier" ? "verifier" : "API"} key
      </button>
      <Modal
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          if (!value) setCreated(undefined);
        }}
        title={created ? "Save your API key" : "Create API key"}
        description={
          created
            ? "This secret is shown once. Store it in your backend secret manager."
            : "The key is scoped to this project. Create separate credentials for ingestion, CI and verification."
        }
      >
        {created ? (
          <>
            <div className="secret-display">
              <code>{created.secret}</code>
              <CopyButton value={created.secret} />
            </div>
            <p className="muted">
              Scopes: {created.scopes.join(", ")}. This key will stop working
              immediately when revoked.
            </p>
            <button
              className="btn primary"
              onClick={() => {
                setOpen(false);
                setCreated(undefined);
              }}
            >
              I saved the key
            </button>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate({
                name,
                scopes:
                  scope === "ci"
                    ? ["ci", "ingest", "read", "evaluate"]
                    : [scope],
              });
            }}
          >
            <label>
              Key name
              <input
                value={name}
                required
                minLength={1}
                maxLength={100}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              Purpose
              <select value={scope} onChange={(e) => setScope(e.target.value)}>
                <option value="ingest">Agent event ingestion</option>
                <option value="ci">CI regression runner</option>
                <option value="read">Read-only API access</option>
                <option value="verifier">Signed customer verifier only</option>
              </select>
            </label>
            <div className="form-footer">
              <span className="muted small">
                Project: {s.projects.find((p) => p.id === s.projectId)?.name}
              </span>
              <button className="btn primary" disabled={create.isPending}>
                {create.isPending ? "Creating…" : "Create key"}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}
export function Onboarding() {
  const s = useScope();
  const client = useQueryClient();
  const [language, setLanguage] = useState("typescript");
  const [endpoint, setEndpoint] = useState("https://your-domain.example/api");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setEndpoint(`${location.origin}/api`);
  }, []);
  const code =
    language === "typescript"
      ? `import { AgentQuality } from '@agent-quality/sdk';\n\nconst aq = new AgentQuality({\n  endpoint: '${endpoint}',\n  apiKey: process.env.AQ_API_KEY!,\n  projectId: '${s.projectId || "YOUR_PROJECT_ID"}',\n  agent: 'Support agent', agentVersion: 'git-sha',\n});\n\nawait aq.run(async () => {\n  // Wrap tools with aq.tool() and define aq.expect().\n  return await yourAgent();\n});\nawait aq.close();`
      : `from agent_quality import AgentQuality\n\naq = AgentQuality(\n    endpoint='${endpoint}',\n    api_key=os.environ['AQ_API_KEY'],\n    project_id='${s.projectId || "YOUR_PROJECT_ID"}',\n    agent='Support agent', agent_version='git-sha',\n)\ntry:\n    with aq.run():\n        result = your_agent()\n        aq.message(result)\nfinally:\n    aq.close()`;
  return (
    <>
      <PageHeader
        title="Instrument your agent"
        description="Send redacted traces, define the expected result, then connect independent evidence."
      />
      {!s.workspaceId || !s.projectId ? (
        <section className="setup-form">
          <h2>{!s.workspaceId ? "Create a workspace" : "Create a project"}</h2>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await api(
                  !s.workspaceId ? "/workspaces" : "/projects",
                  s.workspaceId || undefined,
                  { method: "POST", body: json({ name }) },
                );
                await client.invalidateQueries();
                s.notify("Created. Your workspace is ready.");
              } catch (error) {
                s.notify((error as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              {!s.workspaceId ? "Workspace name" : "Project name"}
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={120}
              />
            </label>
            <button className="btn primary" disabled={busy}>
              {busy ? "Creating…" : "Create"}
            </button>
          </form>
        </section>
      ) : (
        <>
          <div className="onboarding-steps">
            <section>
              <span className="step-index">1</span>
              <h2>Create an ingestion key</h2>
              <p>
                Keep the key in your agent backend. It identifies the workspace
                and project for every event.
              </p>
              <KeyCreator />
            </section>
            <section>
              <span className="step-index">2</span>
              <h2>Define the expected result</h2>
              <p>
                Name the resource and properties that must be true. Map a tool
                result field when the ID arrives later.
              </p>
              <Link href="/app/policies">
                Configure a policy
                <ArrowUpRight size={13} />
              </Link>
            </section>
            <section>
              <span className="step-index">3</span>
              <h2>Observe independent state</h2>
              <p>
                Connect a read-only provider, or submit signed receipts from a
                customer-operated verifier.
              </p>
              <Link href="/app/connections">
                Connect a verifier
                <ArrowUpRight size={13} />
              </Link>
            </section>
          </div>
          <section className="code-panel">
            <div className="code-panel-header">
              <div className="tabs">
                {["typescript", "python"].map((lang) => (
                  <button
                    className={language === lang ? "selected" : ""}
                    key={lang}
                    onClick={() => setLanguage(lang)}
                  >
                    {lang === "typescript" ? "TypeScript" : "Python"}
                  </button>
                ))}
              </div>
              <CopyButton value={code} label="Copy example" />
            </div>
            <pre>{code}</pre>
          </section>
          <div className="onboarding-footer">
            <p>
              Acknowledgement means events and a processing job are durable.
              Evaluation follows asynchronously.
            </p>
            <Link className="btn primary" href="/app/runs">
              View incoming runs
              <ArrowRight size={14} />
            </Link>
          </div>
        </>
      )}
    </>
  );
}

export function Settings() {
  const s = useScope();
  const path = usePathname();
  const section = path.split("/")[3] ?? "keys";
  const keys = useProjectQuery(
    "keys",
    "/keys",
    undefined,
    section === "keys" && ["owner", "admin"].includes(s.role),
  );
  const usage = useProjectQuery("usage", "/usage");
  const [revoke, setRevoke] = useState<any>();
  const client = useQueryClient();
  return (
    <>
      <PageHeader
        title={
          section === "usage"
            ? "Usage & billing"
            : section === "team"
              ? "Team"
              : section === "retention"
                ? "Retention"
                : "API keys"
        }
        description={
          section === "keys"
            ? "Scoped credentials for ingestion, CI and verifier receipts. Secrets are shown once."
            : "Workspace settings and access."
        }
        action={section === "keys" ? <KeyCreator /> : undefined}
      />
      <SettingsNav current={section} />

      {section === "keys" ? (
        !["owner", "admin"].includes(s.role) ? (
          <Empty title="Admin access required">
            Only owners and admins can manage API keys.
          </Empty>
        ) : keys.error ? (
          <ErrorState error={keys.error} retry={() => keys.refetch()} />
        ) : keys.isPending ? (
          <Loading rows={4} />
        ) : !keys.data.length ? (
          <Empty title="No API keys yet">
            Create a scoped key to send your first run.
          </Empty>
        ) : (
          <div className="table-frame">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Prefix</th>
                  <th>Scopes</th>
                  <th>Created</th>
                  <th>Access</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {keys.data
                  .filter((k: any) => k.project_id === s.projectId)
                  .map((key: any) => (
                    <tr key={key.id}>
                      <td>{key.name}</td>
                      <td>
                        <code>{key.prefix}…</code>
                      </td>
                      <td>{key.scopes.join(", ")}</td>
                      <td>{when(key.created_at)}</td>
                      <td>
                        <Badge
                          value={key.revoked_at ? "revoked" : "connected"}
                          label={key.revoked_at ? "Revoked" : "Active"}
                        />
                      </td>
                      <td>
                        {!key.revoked_at && (
                          <button
                            className="btn text-button small"
                            onClick={() => setRevoke(key)}
                          >
                            Revoke
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )
      ) : section === "usage" ? (
        usage.isPending ? (
          <Loading rows={4} />
        ) : usage.error ? (
          <ErrorState error={usage.error} />
        ) : (
          <>
            <div className="metric-strip">
              <div>
                <span>Consumed evaluations</span>
                <strong>{usage.data.consumed.toLocaleString()}</strong>
              </div>
              <div>
                <span>Reserved or ambiguous</span>
                <strong>{usage.data.reserved.toLocaleString()}</strong>
              </div>
              <div>
                <span>Remaining allowance</span>
                <strong>{usage.data.remaining.toLocaleString()}</strong>
              </div>
            </div>
            <div className="settings-row">
              <div>
                <h2>{usage.data.subscription.plan} plan</h2>
                <p>
                  Evaluation usage, subscription status and trace retention are
                  tracked separately.
                </p>
              </div>
              <div className="settings-panel">
                <Badge value={usage.data.subscription.status} />
                <p>
                  {usage.data.subscription.allowance.toLocaleString()}{" "}
                  evaluations · period ends{" "}
                  {when(usage.data.subscription.period_end)}
                </p>
                <div className="quota-track">
                  <span
                    style={{
                      width: `${Math.min(100, ((usage.data.consumed + usage.data.reserved) / usage.data.subscription.allowance) * 100)}%`,
                    }}
                  />
                </div>
                <p className="muted small">
                  Hard limits protect your allowance. Ambiguous requests retain
                  their reservation until reconciled.
                </p>
              </div>
            </div>
          </>
        )
      ) : (
        <Empty
          title={
            section === "team"
              ? "Workspace team settings"
              : "Retention settings"
          }
        >
          Workspace owners manage access and data retention.
        </Empty>
      )}
      <Modal
        open={!!revoke}
        onOpenChange={(open) => !open && setRevoke(undefined)}
        title="Revoke API key"
        description={`“${revoke?.name ?? "This key"}” will stop working immediately. Agents using it must switch to a replacement key.`}
      >
        <div className="form-footer">
          <button
            className="btn secondary"
            onClick={() => setRevoke(undefined)}
          >
            Keep key
          </button>
          <button
            className="btn danger"
            onClick={async () => {
              try {
                await api(`/keys/${revoke.id}`, s.workspaceId, {
                  method: "DELETE",
                });
                setRevoke(undefined);
                s.notify("API key revoked.");
                void client.invalidateQueries({ queryKey: ["keys"] });
              } catch (error) {
                s.notify((error as Error).message);
              }
            }}
          >
            Revoke key
          </button>
        </div>
      </Modal>
    </>
  );
}
export function PendingScreen({ kind }: { kind: string }) {
  return (
    <>
      <PageHeader
        title={kind[0].toUpperCase() + kind.slice(1)}
        description="Turn observed behavior into a repeatable quality check."
      />
      <Empty
        title="Start with a reviewed case"
        action={
          <Link className="btn secondary" href="/app/reviews">
            Open review inbox
            <ArrowRight size={14} />
          </Link>
        }
      >
        Inspect a run and record the expected behavior before curating a
        regression case.
      </Empty>
    </>
  );
}
