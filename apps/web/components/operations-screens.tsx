"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, json } from "../lib/api";
import { useScope } from "./app-shell";
import {
  Badge,
  CopyButton,
  Empty,
  ErrorState,
  Loading,
  Modal,
  PageHeader,
} from "./ui";
import { SettingsNav } from "./settings-nav";
const textError = (error: unknown) =>
  error instanceof Error ? error.message : "The request could not complete.";
const stamp = (value: string | null) =>
  value ? new Date(value).toLocaleString() : "Not recorded";

export function AlertSettings() {
  const s = useScope(),
    client = useQueryClient(),
    allowed = ["owner", "admin"].includes(s.role);
  const [open, setOpen] = useState(false),
    [name, setName] = useState(""),
    [url, setUrl] = useState(""),
    [secret, setSecret] = useState("");
  const query = useQuery<any[]>({
    queryKey: ["alert-destinations", s.workspaceId, s.projectId],
    queryFn: () =>
      api(`/alerts/destinations?projectId=${s.projectId}`, s.workspaceId),
    enabled: allowed && !!s.projectId,
  });
  const health = useQuery<any>({
    queryKey: ["alert-health", s.workspaceId, s.projectId],
    queryFn: () =>
      api(`/alerts/health?projectId=${s.projectId}`, s.workspaceId),
    enabled: allowed && !!s.projectId,
    refetchInterval: 15000,
  });
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["alert-destinations"] });
    void client.invalidateQueries({ queryKey: ["alert-health"] });
  };
  const create = useMutation({
    gcTime: 0,
    mutationFn: () =>
      api("/alerts/destinations", s.workspaceId, {
        method: "POST",
        body: json({ projectId: s.projectId, name, url }),
      }),
    onSuccess: (data) => {
      setSecret(data.signingSecret);
      refresh();
    },
  });
  const change = useMutation({
    gcTime: 0,
    mutationFn: (input: {
      id: string;
      kind: "toggle" | "rotate" | "delete";
      enabled?: boolean;
    }) =>
      api(
        `/alerts/destinations/${input.id}${input.kind === "rotate" ? "/rotate-secret" : input.kind === "delete" ? `?projectId=${s.projectId}` : ""}`,
        s.workspaceId,
        {
          method:
            input.kind === "toggle"
              ? "PATCH"
              : input.kind === "rotate"
                ? "POST"
                : "DELETE",
          ...(input.kind !== "delete"
            ? {
                body: json({
                  projectId: s.projectId,
                  ...(input.kind === "toggle"
                    ? { enabled: input.enabled }
                    : {}),
                }),
              }
            : {}),
        },
      ),
    onSuccess: (data, input) => {
      if (input.kind === "rotate") {
        setSecret(data.signingSecret);
        setOpen(true);
      }
      refresh();
      s.notify("Alert destination updated.");
    },
  });
  const replay = useMutation({
    mutationFn: (delivery: any) =>
      api(`/alerts/deliveries/${delivery.id}/replay`, s.workspaceId, {
        method: "POST",
        body: json({
          projectId: s.projectId,
          expectedGeneration: delivery.generation,
          confirm: "replay",
        }),
      }),
    onSuccess: () => {
      refresh();
      s.notify("Alert replay queued with the original event ID.");
    },
  });
  useEffect(() => {
    setOpen(false);
    setSecret("");
    create.reset();
    change.reset();
    replay.reset();
  }, [s.workspaceId, s.projectId]);
  const close = (value: boolean) => {
    if (create.isPending) return;
    setOpen(value);
    if (!value) {
      setSecret("");
      setName("");
      setUrl("");
      create.reset();
    }
  };
  return (
    <>
      <PageHeader
        title="Alerts"
        description="Signed notifications for completed assessments. Destinations receive outcome metadata."
        action={
          allowed ? (
            <button className="btn primary" onClick={() => setOpen(true)}>
              Add destination
            </button>
          ) : undefined
        }
      />
      <SettingsNav current="alerts" />
      {!allowed ? (
        <Empty title="Admin access required">
          Owners and admins manage project alert destinations.
        </Empty>
      ) : query.isPending ? (
        <Loading rows={4} />
      ) : query.error ? (
        <ErrorState error={query.error} retry={() => query.refetch()} />
      ) : (
        <>
          <p className="quiet-notice">
            No trace bodies or model context are sent. Verify HMAC signatures
            and deduplicate the stable event ID at your endpoint. Delivery may
            occur more than once.
          </p>
          {!query.data?.length ? (
            <Empty title="No alert destinations">
              Add a public HTTPS endpoint to receive fail, review and unknown
              assessments. New destinations apply to future assessments.
            </Empty>
          ) : (
            <div className="table-frame">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Destination</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {query.data.map((d) => (
                    <tr key={d.id}>
                      <td>
                        <strong>{d.name}</strong>
                        <div className="muted small break-anywhere">
                          {d.url}
                        </div>
                      </td>
                      <td>
                        <Badge
                          value={d.enabled ? "connected" : "disconnected"}
                          label={d.enabled ? "Enabled" : "Disabled"}
                        />
                      </td>
                      <td>
                        <div className="inline-actions">
                          <button
                            className="btn secondary small"
                            disabled={change.isPending}
                            onClick={() =>
                              change.mutate({
                                id: d.id,
                                kind: "toggle",
                                enabled: !d.enabled,
                              })
                            }
                          >
                            {d.enabled ? "Disable" : "Enable"}
                          </button>
                          <button
                            className="btn secondary small"
                            disabled={change.isPending}
                            onClick={() =>
                              change.mutate({ id: d.id, kind: "rotate" })
                            }
                          >
                            Rotate secret
                          </button>
                          <button
                            className="btn text-button small"
                            disabled={change.isPending}
                            onClick={() =>
                              change.mutate({ id: d.id, kind: "delete" })
                            }
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {change.error && (
            <p className="form-error" role="alert">
              {textError(change.error)}
            </p>
          )}
          <section className="panel" style={{ marginTop: 24 }}>
            <div className="panel-heading">
              <h2>Delivery health</h2>
              <button
                className="btn secondary small"
                onClick={() => health.refetch()}
              >
                Refresh
              </button>
            </div>
            {health.error ? (
              <ErrorState error={health.error} retry={() => health.refetch()} />
            ) : health.isPending ? (
              <Loading rows={3} />
            ) : (
              <>
                <p className="muted">
                  {health.data.states.length
                    ? health.data.states
                        .map(
                          (v: any) =>
                            `${v.count} ${v.state.replaceAll("_", " ")}`,
                        )
                        .join(" · ")
                    : "No deliveries recorded."}{" "}
                  Bounded to five attempts, with up to three explicit replays.
                </p>
                {health.data.deadLetters.length > 0 && (
                  <div className="table-frame">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Evaluation</th>
                          <th>Failure</th>
                          <th>Attempts</th>
                          <th>Recovery</th>
                        </tr>
                      </thead>
                      <tbody>
                        {health.data.deadLetters.map((d: any) => (
                          <tr key={d.id}>
                            <td>
                              <code>{d.evaluation_id.slice(0, 8)}</code>
                            </td>
                            <td>{d.last_error ?? "unknown"}</td>
                            <td>{d.attempt_count}</td>
                            <td>
                              <button
                                className="btn secondary small"
                                disabled={
                                  replay.isPending || d.replay_count >= 3
                                }
                                onClick={() => replay.mutate(d)}
                              >
                                Replay delivery
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
            {replay.error && (
              <p role="alert" className="form-error">
                {textError(replay.error)}
              </p>
            )}
          </section>
          <p className="muted small" style={{ marginTop: 16 }}>
            Alerts use HMAC-SHA256 over the timestamp and exact JSON body.{" "}
            <Link href="/help#alerts">Receiver integration guide →</Link>
          </p>
        </>
      )}
      <Modal
        open={open}
        onOpenChange={close}
        title={secret ? "Save the signing secret" : "Add an alert destination"}
        description={
          secret
            ? "The secret is shown once. Store it in your receiver’s secret manager."
            : "This enables future fail, review and unknown notifications for the selected project."
        }
      >
        {secret ? (
          <>
            <div className="secret-display">
              <code>{secret}</code>
              <CopyButton value={secret} />
            </div>
            <p className="muted">
              When rotating, update your receiver before the next delivery. The
              secret is never included in a notification.
            </p>
            <button className="btn primary" onClick={() => close(false)}>
              I saved the secret
            </button>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <label>
              Name
              <input
                required
                value={name}
                maxLength={80}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              Public HTTPS endpoint
              <input
                required
                type="url"
                value={url}
                maxLength={2048}
                placeholder="https://your-service.example/agent-quality"
                onChange={(e) => setUrl(e.target.value)}
              />
            </label>
            <p className="muted small">
              Use a public hostname, port 443 and a path without query
              parameters. Private addresses and redirects are rejected.
            </p>
            {create.error && (
              <p role="alert" className="form-error">
                {textError(create.error)}
              </p>
            )}
            <div className="form-footer">
              <button
                type="button"
                className="btn secondary"
                onClick={() => close(false)}
              >
                Cancel
              </button>
              <button className="btn primary" disabled={create.isPending}>
                {create.isPending ? "Validating…" : "Enable destination"}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}

export function ProcessingHealth() {
  const s = useScope(),
    allowed = ["owner", "admin"].includes(s.role);
  const query = useQuery<any>({
    queryKey: ["operations", s.workspaceId, s.projectId],
    queryFn: () =>
      api(`/operations/health?projectId=${s.projectId}`, s.workspaceId),
    enabled: allowed && !!s.projectId,
    refetchInterval: 15000,
  });
  const [entry, setEntry] = useState<any>(),
    [state, setState] = useState("released"),
    [hash, setHash] = useState(""),
    [tokens, setTokens] = useState("0");
  const reconcile = useMutation({
    mutationFn: () =>
      api(
        `/operations/reservations/${entry.evaluation_id}/reconcile`,
        s.workspaceId,
        {
          method: "POST",
          body: json({
            projectId: s.projectId,
            state,
            tokens: Number(tokens),
            providerEvidenceSha256: hash,
            confirmedProcessed: state === "consumed",
          }),
        },
      ),
    onSuccess: () => {
      setEntry(undefined);
      void query.refetch();
      s.notify("Reservation reconciled. No provider request will be repeated.");
    },
  });
  useEffect(() => {
    setEntry(undefined);
    reconcile.reset();
  }, [s.workspaceId, s.projectId]);
  return (
    <>
      <PageHeader
        title="Processing health"
        description="Durable queues, evaluation processing and reservations requiring investigation."
        action={
          <button className="btn secondary" onClick={() => query.refetch()}>
            Refresh
          </button>
        }
      />
      <SettingsNav current="operations" />
      {!allowed ? (
        <Empty title="Admin access required">
          Owners and admins investigate operational state.
        </Empty>
      ) : query.isPending ? (
        <Loading rows={5} />
      ) : query.error ? (
        <ErrorState error={query.error} retry={() => query.refetch()} />
      ) : (
        <>
          <div className="metric-strip">
            <div>
              <span>Semantic requests</span>
              <strong style={{ fontSize: 22 }}>
                {query.data.semanticEnabled ? "Enabled" : "Disabled"}
              </strong>
              <p>The server kill switch controls new requests.</p>
            </div>
            <div>
              <span>Last maintenance success</span>
              <strong style={{ fontSize: 18 }}>
                {stamp(query.data.maintenance?.last_success_at)}
              </strong>
              <p>Retention, deletion and object cleanup</p>
            </div>
            <div>
              <span>Pending deletions</span>
              <strong>{query.data.deletions?.pending ?? 0}</strong>
              <p>Completed after database and object cleanup</p>
            </div>
          </div>
          <section className="panel" style={{ marginTop: 24 }}>
            <div className="panel-heading">
              <h2>Queue state</h2>
            </div>
            {query.data.queue.length ? (
              <div className="table-frame">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Queue</th>
                      <th>State</th>
                      <th>Jobs</th>
                      <th>Oldest</th>
                    </tr>
                  </thead>
                  <tbody>
                    {query.data.queue.map((q: any) => (
                      <tr key={`${q.name}-${q.state}`}>
                        <td>{q.name}</td>
                        <td>
                          <Badge value={q.state} label={q.state} />
                        </td>
                        <td>{q.count}</td>
                        <td>{stamp(q.oldest)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty title="No queued work">
                New accepted runs create durable evaluation jobs.
              </Empty>
            )}
          </section>
          <section className="panel" style={{ marginTop: 24 }}>
            <div className="panel-heading">
              <h2>Ambiguous provider reservations</h2>
            </div>
            <p className="muted">
              Investigate provider processing before reconciling. Reservations
              stay held until there is recorded evidence. Reconciliation never
              sends another model request.
            </p>
            {query.data.ambiguous.length ? (
              <div className="table-frame">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Evaluation</th>
                      <th>Units held</th>
                      <th>Recorded</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {query.data.ambiguous.map((e: any) => (
                      <tr key={e.evaluation_id}>
                        <td>
                          <code>{e.evaluation_id.slice(0, 8)}</code>
                        </td>
                        <td>{e.units}</td>
                        <td>{stamp(e.created_at)}</td>
                        <td>
                          <button
                            className="btn secondary small"
                            onClick={() => {
                              setEntry(e);
                              setHash("");
                              setState("released");
                              setTokens("0");
                              reconcile.reset();
                            }}
                          >
                            Reconcile
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty title="No ambiguous reservations">
                There are no provider requests awaiting reconciliation in this
                project.
              </Empty>
            )}
          </section>
          <section className="panel" style={{ marginTop: 24 }}>
            <div className="panel-heading">
              <h2>Dead-letter evaluations</h2>
            </div>
            {query.data.deadLetter.length ? (
              <ul>
                {query.data.deadLetter.map((d: any) => (
                  <li key={d.id}>
                    <code>{d.id}</code> · {stamp(d.created_on)} ·{" "}
                    {d.run_id ? (
                      <Link href={`/app/runs/${encodeURIComponent(d.run_id)}`}>
                        Inspect run
                      </Link>
                    ) : (
                      "Use the run detail page to request a new evaluation after resolving the failure."
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <Empty title="No dead-letter evaluations">
                Interrupted jobs retry with bounded backoff before appearing
                here.
              </Empty>
            )}
          </section>
        </>
      )}
      <Modal
        open={!!entry}
        onOpenChange={(v) => {
          if (!v && !reconcile.isPending) setEntry(undefined);
        }}
        title="Reconcile a provider reservation"
        description="Only reconcile after investigating the provider request. Keep the supporting provider evidence separately."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            reconcile.mutate();
          }}
        >
          <label>
            Confirmed provider result
            <select value={state} onChange={(e) => setState(e.target.value)}>
              <option value="released">
                The provider did not process this request
              </option>
              <option value="consumed">
                The provider processed this request
              </option>
            </select>
          </label>
          <label>
            Actual input tokens
            <input
              type="number"
              min={0}
              max={10000000}
              required
              value={tokens}
              onChange={(e) => setTokens(e.target.value)}
            />
          </label>
          <label>
            SHA-256 of supporting provider evidence
            <input
              required
              pattern="[a-f0-9]{64}"
              value={hash}
              onChange={(e) => setHash(e.target.value)}
              spellCheck={false}
            />
          </label>
          <p className="muted small">
            A reservation must be at least 15 minutes old. This records your
            administrative decision and its evidence hash in the audit history.
          </p>
          {reconcile.error && (
            <p role="alert" className="form-error">
              {textError(reconcile.error)}
            </p>
          )}
          <div className="form-footer">
            <button
              className="btn secondary"
              type="button"
              onClick={() => setEntry(undefined)}
            >
              Cancel
            </button>
            <button className="btn primary" disabled={reconcile.isPending}>
              Record reconciliation
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}

export function RunDataActions({ runId }: { runId: string }) {
  const s = useScope(),
    [confirm, setConfirm] = useState(false),
    [deletion, setDeletion] = useState<string>();
  const exportRun = useMutation({
    mutationFn: async () => {
      const archive = await api(
        `/runs/${encodeURIComponent(runId)}/export`,
        s.workspaceId,
        { method: "POST", body: json({ projectId: s.projectId }) },
      );
      const result = await api(
        `${archive.downloadPath.replace("/v1", "")}`,
        s.workspaceId,
      );
      const url = new URL(result.url);
      if (url.protocol !== "https:")
        throw new Error("Private download URL is unavailable.");
      window.location.assign(url.href);
    },
  });
  const remove = useMutation({
    mutationFn: () =>
      api("/operations/deletions", s.workspaceId, {
        method: "POST",
        body: json({
          projectId: s.projectId,
          kind: "run",
          targetId: runId,
          confirm: "delete",
        }),
      }),
    onSuccess: (d) => {
      setDeletion(d.id);
      setConfirm(false);
      s.notify(
        "Deletion requested. Source and curated copies will be removed.",
      );
    },
  });
  const status = useQuery<any>({
    queryKey: ["run-deletion", s.workspaceId, deletion],
    queryFn: () => api(`/operations/deletions/${deletion}`, s.workspaceId),
    enabled: !!deletion,
    refetchInterval: (q) => (q.state.data?.complete ? false : 2000),
  });
  useEffect(() => {
    setConfirm(false);
    setDeletion(undefined);
    exportRun.reset();
    remove.reset();
  }, [runId, s.workspaceId]);
  return (
    <>
      <div className="inline-actions" style={{ marginBottom: 20 }}>
        {s.role !== "viewer" && (
          <button
            className="btn secondary small"
            disabled={exportRun.isPending || !!deletion}
            onClick={() => exportRun.mutate()}
          >
            {exportRun.isPending ? "Preparing export…" : "Export redacted run"}
          </button>
        )}
        {["owner", "admin"].includes(s.role) && (
          <button
            className="btn text-button small"
            disabled={!!deletion}
            onClick={() => setConfirm(true)}
          >
            Delete run & copies
          </button>
        )}
        {deletion && (
          <span role="status" className="muted small">
            {status.data?.complete
              ? "Deletion completed. Return to the runs explorer."
              : "Deletion and object cleanup pending."}
          </span>
        )}
      </div>
      {exportRun.error && (
        <p className="form-error" role="alert">
          {textError(exportRun.error)}
        </p>
      )}
      <Modal
        open={confirm}
        onOpenChange={setConfirm}
        title="Delete this run and curated copies?"
        description="This requests permanent deletion of trace content, observations, evaluations, related dataset copies and comparisons. Content-free usage accounting remains counted."
      >
        {remove.error && (
          <p className="form-error" role="alert">
            {textError(remove.error)}
          </p>
        )}
        <div className="form-footer">
          <button className="btn secondary" onClick={() => setConfirm(false)}>
            Keep run
          </button>
          <button
            className="btn danger"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            Delete permanently
          </button>
        </div>
      </Modal>
    </>
  );
}
