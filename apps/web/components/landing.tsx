"use client";
import { useState } from "react";
import Link from "next/link";
import {
  ScanEye,
  ArrowRight,
  ArrowUpRight,
  GitBranch,
  ShieldCheck,
} from "lucide-react";
import { Badge } from "./ui";
const offerings = {
  trial: {
    name: "Trial",
    price: 0,
    allowance: "1,000",
    members: 3,
    projects: 1,
    description:
      "14 days to instrument a workflow, inspect its evidence and publish a regression case.",
  },
  starter: {
    name: "Starter",
    price: 29,
    allowance: "10,000",
    members: 3,
    projects: 3,
    description:
      "For a team bringing outcome verification into its everyday agent development.",
  },
  team: {
    name: "Team",
    price: 99,
    allowance: "50,000",
    members: 10,
    projects: 20,
    description:
      "For several agents, shared review queues and a release process grounded in evidence.",
  },
};
export function MarketingNav() {
  return (
    <nav className="landing-nav" aria-label="Website navigation">
      <Link className="wordmark" href="/">
        <ScanEye size={25} strokeWidth={1.5} />
        Agent Quality
      </Link>
      <span className="preview-label">Preview</span>
      <div>
        <Link href="/pricing">Pricing</Link>
        <Link href="/help">Docs</Link>
        <Link className="btn primary" href="/login">
          Open workspace
          <ArrowUpRight size={14} />
        </Link>
      </div>
    </nav>
  );
}
export function MarketingFooter() {
  return (
    <footer className="landing-footer">
      <span>Evidence for agent outcomes.</span>
      <div>
        <Link href="/help">Documentation</Link>
        <Link href="/privacy">Data & privacy</Link>
        <Link href="/pricing">Pricing</Link>
      </div>
      <span>Agent Quality · {new Date().getFullYear()}</span>
    </footer>
  );
}
export function PricingSelector() {
  const [selected, setSelected] = useState<keyof typeof offerings>("starter");
  const plan = offerings[selected];
  return (
    <section className="pricing-selector" aria-label="Proposed launch plans">
      <div className="plan-names">
        {Object.entries(offerings).map(([id, value]) => (
          <button
            key={id}
            className={selected === id ? "selected" : ""}
            aria-pressed={selected === id}
            onClick={() => setSelected(id as keyof typeof offerings)}
          >
            {value.name}
            <span>{selected === id ? "Selected" : ""}</span>
          </button>
        ))}
      </div>
      <div className="plan-detail">
        <div className="plan-price">
          ${plan.price}
          <span>{selected === "trial" ? "for 14 days" : "/ month"}</span>
        </div>
        <p>{plan.description}</p>
        <dl>
          <div>
            <dt>Evaluated runs</dt>
            <dd>{plan.allowance}</dd>
          </div>
          <div>
            <dt>Team members</dt>
            <dd>{plan.members}</dd>
          </div>
          <div>
            <dt>Projects</dt>
            <dd>{plan.projects}</dd>
          </div>
          <div>
            <dt>Detailed trace retention</dt>
            <dd>30 days</dd>
          </div>
        </dl>
        <Link className="btn primary" href="/login">
          Open your workspace
          <ArrowRight size={15} />
        </Link>
        <small>
          Proposed launch prices in USD. Billing configuration and launch
          validation are required before paid availability.
        </small>
      </div>
    </section>
  );
}
export function Landing() {
  const [observation, setObservation] = useState("none");
  const decision =
    observation === "none"
      ? "unknown"
      : observation === "open"
        ? "pass"
        : "fail";
  const exit = decision === "pass" ? 0 : decision === "fail" ? 1 : 2;
  return (
    <div className="marketing">
      <MarketingNav />
      <main>
        <section className="landing-hero">
          <div className="hero-copy">
            <h1>Did the agent finish?</h1>
            <p>
              Compare what your agent claimed with the state recorded by your
              systems. Review the gaps and keep them as regression cases.
            </p>
            <div className="hero-actions">
              <Link className="btn primary" href="/login">
                Open workspace
                <ArrowRight size={15} />
              </Link>
              <Link href="/help">
                Read the integration guide
                <ArrowUpRight size={14} />
              </Link>
            </div>
            <p className="hero-footnote">
              Built for SaaS workflow agents. Customer execution stays in your
              infrastructure.
            </p>
          </div>
          <div className="landing-demo" data-ui>
            <div className="demo-header">
              <span>Sample outcome check</span>
              <Badge value={decision} />
            </div>
            <div className="demo-claim">
              <span className="field-label">Agent claim</span>
              <p>“I created the support issue and left it open.”</p>
            </div>
            <div className="demo-facts">
              <div>
                <span className="field-label">Expected state</span>
                <strong>Issue #42 · open</strong>
              </div>
              <div>
                <span className="field-label">Reported tool result</span>
                <span>success: true</span>
              </div>
            </div>
            <label>
              Independent sample observation
              <select
                value={observation}
                onChange={(e) => setObservation(e.target.value)}
              >
                <option value="none">No independent receipt</option>
                <option value="open">Receipt observed: open</option>
                <option value="closed">Receipt observed: closed</option>
              </select>
            </label>
            <div className={`demo-result result-${decision}`}>
              <strong>
                {decision === "unknown"
                  ? "Completion remains unknown"
                  : decision === "pass"
                    ? "Expected state observed"
                    : "Observed state contradicts the outcome"}
              </strong>
              <p>
                {decision === "unknown"
                  ? "A successful tool response leaves the external result unverified."
                  : decision === "pass"
                    ? "The sample receipt matches the required state at its observation time."
                    : "The sample receipt records a closed issue while the expected state is open."}
              </p>
            </div>
            <small>
              Interactive fixture · no live provider query · no historical
              causality claim
            </small>
          </div>
        </section>
        <section className="workflow-story">
          <div>
            <h2>
              Keep the evidence.
              <br />
              Carry the case forward.
            </h2>
            <p>
              An observed failure becomes a review decision, then an immutable
              regression case. Each comparison keeps the run revision, policy
              version and evidence that produced its result.
            </p>
            <Link href="/help#ci">
              Add outcome checks to CI
              <ArrowRight size={15} />
            </Link>
          </div>
          <div className="landing-report" data-ui>
            <div className="demo-header">
              <span>Illustrative CI report</span>
              <GitBranch size={16} />
            </div>
            <div className="sample-case">
              <strong>support-issue-is-open</strong>
              <Badge value={decision} />
            </div>
            <dl>
              <div>
                <dt>Expected behavior</dt>
                <dd>Verified completion</dd>
              </div>
              <div>
                <dt>Outcome verification</dt>
                <dd>
                  {observation === "none"
                    ? "unknown"
                    : observation === "open"
                      ? "verified"
                      : "contradicted"}
                </dd>
              </div>
              <div>
                <dt>Required unknown blocks CI</dt>
                <dd>Enabled</dd>
              </div>
            </dl>
            <pre>{`$ aq report "$EXPERIMENT_ID" --plain\n\ncase  support-issue-is-open\n      ${decision.toUpperCase()} · fixture observation\n\nexit  ${exit}`}</pre>
            <small>
              Customer CI runs the agent. Comparisons reuse frozen evidence.
            </small>
          </div>
        </section>
        <section className="verification-section">
          <h2>
            Observe the systems
            <br />
            your agent changes.
          </h2>
          <div>
            <article>
              <h3>GitHub Issues</h3>
              <p>
                Read-only issue observations: resource identity, configured
                properties and the time the state was recorded.
              </p>
            </article>
            <article>
              <h3>HubSpot Contacts</h3>
              <p>
                Read-only contact observations with only the properties required
                by your outcome contract.
              </p>
            </article>
            <article>
              <h3>Your verifier</h3>
              <p>
                Signed receipts from your infrastructure, with their
                customer-operated provenance kept visible.
              </p>
            </article>
          </div>
        </section>
        <section className="landing-pricing">
          <div className="pricing-heading">
            <h2>Start with one workflow.</h2>
            <p>
              Proposed launch plans. Hard evaluation limits keep your allowance
              explicit.
            </p>
          </div>
          <PricingSelector />
        </section>
        <section className="landing-faq">
          <h2>Before you connect.</h2>
          <div>
            {[
              [
                "What does “verified” establish?",
                "The required properties matched an applicable independent observation at its recorded time. It does not establish that the agent caused the state or that the state remained unchanged afterward.",
              ],
              [
                "What happens when evidence is missing?",
                "The outcome remains unknown. Incomplete traces, expired permissions, stale observations and essential redacted fields do not turn into a pass. Required unknown outcomes block CI by default.",
              ],
              [
                "Where does my agent run?",
                "Your infrastructure runs the agent and regression candidates. Agent Quality receives completed-run telemetry and evaluates it asynchronously. Historical comparison does not repeat production actions.",
              ],
              [
                "How are semantic judgments used?",
                "Focused Jev questions complement deterministic assertions. Typed results are validated; semantic detectors remain review-only until calibration and explicit activation. Model confidence is not guaranteed correctness.",
              ],
              [
                "What leaves Singapore?",
                "Singapore is the primary deployment target. Redacted semantic evaluation context may be processed by Jev outside Singapore. Provider processing and retention terms must be disclosed separately.",
              ],
              [
                "Is this generally available?",
                "This is a preview implementation. Live provider and payment validation, human calibration, production recovery/load checks and external pilots are required release gates.",
              ],
            ].map(([question, answer]) => (
              <details name="product-faq" key={question}>
                <summary>
                  {question}
                  <span>+</span>
                </summary>
                <p>{answer}</p>
              </details>
            ))}
          </div>
        </section>
        <section className="landing-cta">
          <h2>
            Give every claim
            <br />a record to stand on.
          </h2>
          <Link className="btn primary" href="/login">
            Open your workspace
            <ArrowRight size={16} />
          </Link>
        </section>
      </main>
      <MarketingFooter />
    </div>
  );
}
