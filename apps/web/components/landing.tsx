"use client";
import { useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  GitBranch,
  Github,
  FileCheck2,
  Minus,
} from "lucide-react";
import { Badge } from "./ui";
import { Brand, BrandMark } from "./brand";
import { MarketingMotion } from "./marketing-motion";

const offerings = [
  {
    id: "trial",
    name: "Trial",
    price: 0,
    allowance: "1,000",
    members: 3,
    projects: 1,
    description: "Get one workflow on record.",
    period: "for 14 days",
  },
  {
    id: "starter",
    name: "Starter",
    price: 29,
    allowance: "10,000",
    members: 3,
    projects: 3,
    description: "Make verification part of your day.",
    period: "/ month",
  },
  {
    id: "team",
    name: "Team",
    price: 99,
    allowance: "50,000",
    members: 10,
    projects: 20,
    description: "A shared standard for every release.",
    period: "/ month",
  },
];

export function MarketingNav() {
  return (
    <nav className="landing-nav" aria-label="Website navigation">
      <Brand />
      <div className="marketing-links">
        <Link href="/#evidence">Product</Link>
        <Link href="/help">Documentation</Link>
        <Link href="/pricing">Pricing</Link>
      </div>
      <Link className="nav-sign-in" href="/login">
        Sign in
      </Link>
      <Link className="btn primary nav-action" href="/login?mode=signup">
        Create account <ArrowUpRight size={15} />
      </Link>
      <details className="marketing-menu">
        <summary>
          Menu <ChevronDown size={16} />
        </summary>
        <div>
          <Link href="/#evidence">Product</Link>
          <Link href="/help">Documentation</Link>
          <Link href="/pricing">Pricing</Link>
          <Link href="/login">
            Sign in <ArrowUpRight size={15} />
          </Link>
          <Link href="/login?mode=signup">
            Create account <ArrowUpRight size={15} />
          </Link>
        </div>
      </details>
    </nav>
  );
}

export function MarketingFooter() {
  return (
    <footer className="landing-footer">
      <div className="footer-wordmark" aria-hidden="true">
        Aftermark
      </div>
      <div className="footer-content">
        <p>
          Every outcome deserves
          <br />a record to stand on.
        </p>
        <div>
          <Link href="/help">
            Documentation <ArrowUpRight size={14} />
          </Link>
          <Link href="/pricing">
            Plans & pricing <ArrowUpRight size={14} />
          </Link>
          <Link href="/privacy">
            Data & privacy <ArrowUpRight size={14} />
          </Link>
        </div>
        <Link className="footer-workspace" href="/login">
          Open workspace <ArrowUpRight size={18} />
        </Link>
      </div>
      <div className="footer-bottom">
        <span>Aftermark © {new Date().getFullYear()}</span>
        <span>Independent evidence. Explicit uncertainty.</span>
        <a href="#top">Back to top ↑</a>
      </div>
    </footer>
  );
}

export function PricingSelector() {
  return (
    <div className="pricing-comparison" aria-label="Aftermark plans">
      <div className="pricing-table-wrap">
        <table className="pricing-table">
          <thead>
            <tr>
              <th scope="col">
                <span>
                  Choose your
                  <br />
                  working scale.
                </span>
              </th>
              {offerings.map((plan) => (
                <th
                  scope="col"
                  key={plan.id}
                  className={plan.id === "starter" ? "featured-plan" : ""}
                >
                  <h3>{plan.name}</h3>
                  <div className="plan-price">
                    ${plan.price}
                    <span>{plan.period}</span>
                  </div>
                  <p>{plan.description}</p>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Evaluated runs</th>
              {offerings.map((p) => (
                <td key={p.id}>{p.allowance}</td>
              ))}
            </tr>
            <tr>
              <th scope="row">Team members</th>
              {offerings.map((p) => (
                <td key={p.id}>{p.members}</td>
              ))}
            </tr>
            <tr>
              <th scope="row">Projects</th>
              {offerings.map((p) => (
                <td key={p.id}>{p.projects}</td>
              ))}
            </tr>
            <tr>
              <th scope="row">Detailed trace retention</th>
              {offerings.map((p) => (
                <td key={p.id}>30 days</td>
              ))}
            </tr>
            <tr>
              <th scope="row">Human review & CI</th>
              {offerings.map((p) => (
                <td key={p.id}>Included</td>
              ))}
            </tr>
            <tr className="pricing-actions">
              <th scope="row">All prices in USD.</th>
              {offerings.map((p) => (
                <td key={p.id}>
                  <Link
                    className={`btn ${p.id === "starter" ? "primary" : "secondary"}`}
                    href="/login"
                  >
                    {p.id === "trial" ? "Start with Trial" : `Choose ${p.name}`}
                    <ArrowUpRight size={14} />
                  </Link>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <div className="pricing-mobile-plans">
        {offerings.map((plan) => (
          <article
            key={plan.id}
            className={
              plan.id === "starter" ? "mobile-plan featured" : "mobile-plan"
            }
          >
            <header>
              <h3>{plan.name}</h3>
              <div className="plan-price">
                ${plan.price}
                <span>{plan.period}</span>
              </div>
              <p>{plan.description}</p>
            </header>
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
                <dt>Trace retention</dt>
                <dd>30 days</dd>
              </div>
              <div>
                <dt>Human review & CI</dt>
                <dd>Included</dd>
              </div>
            </dl>
            <Link
              className={`btn ${plan.id === "starter" ? "primary" : "secondary"}`}
              href="/login"
            >
              {plan.id === "trial" ? "Start with Trial" : `Choose ${plan.name}`}
              <ArrowUpRight size={15} />
            </Link>
          </article>
        ))}
      </div>
      <p className="pricing-note">
        Hard evaluation limits. No automatic overage charges. Paid plan
        availability is shown in your workspace.
      </p>
    </div>
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
  const verified = observation === "open";
  const outcome =
    observation === "none" ? "unknown" : verified ? "verified" : "contradicted";
  const exit = verified ? 0 : decision === "fail" ? 1 : 2;
  return (
    <MarketingMotion>
      <div id="top" />
      <MarketingNav />
      <main>
        <section className="landing-hero product-hero" id="evidence">
          <div className="hero-copy">
            <h1>
              <span className="hero-line">
                <span>Verify agent</span>
              </span>
              <span className="hero-line">
                <span>outcomes.</span>
              </span>
            </h1>
            <div className="hero-context">
              <p>
                Aftermark checks your agent’s claims against independent system
                evidence. Review uncertain outcomes and turn real findings into
                regression tests.
              </p>
              <div className="hero-account-actions">
                <Link className="btn primary" href="/login?mode=signup">
                  Create your workspace <ArrowUpRight size={17} />
                </Link>
                <Link className="hero-sign-in" href="/login">
                  Sign in <ArrowRight size={15} />
                </Link>
              </div>
            </div>
          </div>
          <div className="evidence-window" data-ui>
            <div className="evidence-toolbar">
              <span>
                <BrandMark /> Outcome record
              </span>
              <span className="example-label">Example</span>
              <Badge value={outcome} />
            </div>
            <div className="evidence-run-header">
              <div>
                <span className="record-scope">
                  Support workflow / issue creation
                </span>
                <h3>Leave the support issue open</h3>
              </div>
              <span className="run-id">run_7a82e9</span>
            </div>
            <div className="evidence-columns">
              <div className="claim-column">
                <span className="field-label">What the agent said</span>
                <blockquote>
                  “I created the support issue and left it open.”
                </blockquote>
                <div className="reported-result">
                  <Check size={16} />
                  <span>
                    Reported tool result<strong>success: true</strong>
                  </span>
                  <span className="source-tag">Agent trace</span>
                </div>
                <p className="evidence-caution">
                  A reported response does not establish the external outcome.
                </p>
              </div>
              <div className="observation-column">
                <span className="field-label">What the system recorded</span>
                <div className="expected-row">
                  <span>Expected state</span>
                  <strong>
                    <Github size={15} /> Issue #42 · open
                  </strong>
                </div>
                <label htmlFor="sample-observation">
                  Independent observation
                  <select
                    id="sample-observation"
                    value={observation}
                    onChange={(e) => setObservation(e.target.value)}
                  >
                    <option value="none">No independent receipt</option>
                    <option value="open">Receipt observed: open</option>
                    <option value="closed">Receipt observed: closed</option>
                  </select>
                </label>
                <div
                  className={`observation-answer answer-${decision}`}
                  role="status"
                  aria-live="polite"
                >
                  <span className="observation-symbol">
                    {verified ? <Check size={18} /> : <Minus size={18} />}
                  </span>
                  <div>
                    <strong>
                      {observation === "none"
                        ? "Completion remains unknown"
                        : verified
                          ? "Expected state observed"
                          : "Observed state contradicts the outcome"}
                    </strong>
                    <p>
                      {observation === "none"
                        ? "The record needs independent evidence."
                        : verified
                          ? "The recorded receipt matches the required state."
                          : "The receipt records closed; the contract requires open."}
                    </p>
                  </div>
                </div>
              </div>
            </div>
            <div className="evidence-bottom">
              <span>
                <span className="record-dot" /> Execution completed
              </span>
              <span>Outcome {outcome}</span>
              <span>Illustrative receipt · no live provider query</span>
            </div>
          </div>
          <div className="hero-end">
            <span>
              For SaaS workflow agents. Your agent runs in your infrastructure.
            </span>
            <Link href="/help#outcomes">
              How verification works <ArrowUpRight size={15} />
            </Link>
          </div>
        </section>

        <section className="case-story">
          <div className="case-story-heading" data-reveal>
            <h2>
              Keep the finding.
              <br />
              Raise the standard.
            </h2>
            <p>
              A useful review outlives the run. Turn the case into a versioned
              test that travels with every release.
            </p>
          </div>
          <div className="case-stages">
            <article data-reveal>
              <h3>Review the gap</h3>
              <p>
                Claim a case, inspect the frozen evidence, and record a decision
                without rewriting the original assessment.
              </p>
              <div className="product-fragment review-fragment" data-ui>
                <div className="fragment-header">
                  <span>Review inbox</span>
                  <Badge value="review" label="Needs review" />
                </div>
                <div className="fragment-case">
                  <FileCheck2 size={20} />
                  <div>
                    <strong>Support issue is open</strong>
                    <span>Independent receipt missing</span>
                  </div>
                </div>
                <div className="fragment-note">
                  “Keep the outcome unknown until the receipt arrives.”
                </div>
                <div className="fragment-footer">
                  <span>Example review note</span>
                  <span className="text-action">
                    Inspect evidence <ArrowRight size={13} />
                  </span>
                </div>
              </div>
            </article>
            <article data-reveal>
              <h3>Preserve the case</h3>
              <p>
                Publish the resolved finding into an immutable dataset. Keep its
                expected behavior, source revision, and policy together.
              </p>
              <div className="product-fragment dataset-fragment" data-ui>
                <div className="fragment-header">
                  <span>Regression dataset</span>
                  <span className="source-tag">Version 1</span>
                </div>
                <div className="dataset-name">
                  <span className="dataset-symbol">
                    <BrandMark />
                  </span>
                  <div>
                    <strong>Support workflow</strong>
                    <span>Agent regression · example</span>
                  </div>
                </div>
                <dl>
                  <div>
                    <dt>Expected behavior</dt>
                    <dd>Verified completion</dd>
                  </div>
                  <div>
                    <dt>Source evidence</dt>
                    <dd>Frozen run revision</dd>
                  </div>
                  <div>
                    <dt>Required unknown</dt>
                    <dd>Blocks CI</dd>
                  </div>
                </dl>
              </div>
            </article>
            <article data-reveal>
              <h3>Check the next release</h3>
              <p>
                Run the candidate in your infrastructure. Compare submitted
                traces against the case, with an explicit result for CI.
              </p>
              <div className="product-fragment ci-fragment" data-ui>
                <div className="fragment-header">
                  <span>
                    <GitBranch size={15} /> Customer CI
                  </span>
                  <Badge value={decision} />
                </div>
                <pre>
                  <code>{`$ aq report "$EXPERIMENT_ID" --plain\n\ncase  support-issue-is-open\n      ${decision.toUpperCase()}\n\nexit  ${exit}`}</code>
                </pre>
                <div className="fragment-footer">
                  <span>Same example observation</span>
                  <span className="ci-exit">Exit {exit}</span>
                </div>
              </div>
            </article>
          </div>
          <Link className="text-link" href="/help#ci" data-reveal>
            Put outcome checks in your release process{" "}
            <ArrowUpRight size={16} />
          </Link>
        </section>

        <section className="verification-section">
          <div className="verification-statement" data-reveal>
            <h2>
              Go to
              <br />
              the source.
            </h2>
            <p>
              Read only the properties your outcome contract requires. Every
              observation keeps its identity, timestamp, and provenance.
            </p>
            <Link className="text-link" href="/help#verifiers">
              Explore verification <ArrowUpRight size={16} />
            </Link>
          </div>
          <div className="verification-sources">
            <article data-reveal>
              <div>
                <Github size={23} />
                <h3>GitHub Issues</h3>
              </div>
              <p>
                Read-only issue observations for the repository, resource, and
                properties your workflow changes.
              </p>
              <span>Independent provider observation</span>
            </article>
            <article data-reveal>
              <div>
                <svg
                  width="23"
                  height="23"
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden="true"
                >
                  <circle
                    cx="15"
                    cy="10"
                    r="4"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  />
                  <path
                    d="M12 7 5 3m10 3V2m-3 11-7 7m13-7 3 3"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  />
                  <circle
                    cx="4"
                    cy="21"
                    r="2"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  />
                </svg>
                <h3>HubSpot Contacts</h3>
              </div>
              <p>
                Contact-read OAuth with an explicit set of properties. Missing
                permissions remain visible.
              </p>
              <span>Independent provider observation</span>
            </article>
            <article data-reveal>
              <div>
                <FileCheck2 size={23} />
                <h3>Your verifier</h3>
              </div>
              <p>
                Signed, timestamped receipts from your infrastructure for the
                systems that matter to you.
              </p>
              <span>Customer-operated provenance</span>
            </article>
          </div>
        </section>

        <section className="landing-pricing" data-reveal>
          <div className="pricing-heading">
            <h2>
              Your workflow.
              <br />
              Your allowance.
            </h2>
            <p>
              An explicit allowance for every scale. Your agent stays in your
              infrastructure.
            </p>
          </div>
          <PricingSelector />
        </section>

        <section className="landing-faq">
          <h2 data-reveal>Clear by design.</h2>
          <div>
            {[
              [
                "What does verified establish?",
                "The required properties matched an applicable independent observation at its recorded time. It does not establish that the agent caused that state or that it remained unchanged afterward.",
              ],
              [
                "What if the evidence is missing?",
                "The outcome stays unknown. Incomplete traces, stale observations and essential redacted fields do not become a pass. Required unknown outcomes block CI by default.",
              ],
              [
                "Where does my agent run?",
                "In your infrastructure. Aftermark receives completed-run telemetry and evaluates it asynchronously. Regression comparisons reuse frozen evidence and repeat no production actions.",
              ],
              [
                "How is Jev used?",
                "Focused semantic questions complement deterministic checks. Typed answers are validated; semantic detectors remain review-only until calibration and explicit activation.",
              ],
              [
                "What happens to my data?",
                "Detailed traces default to 30-day retention. Primary storage targets Singapore; redacted semantic context may be processed by Jev elsewhere. Workspace controls manage access and retention.",
              ],
              [
                "Can my team review together?",
                "Yes. Claim a finding, add a decision and note, and retain the original assessment. Version checks preserve concurrent edits and keep disagreement visible.",
              ],
            ].map(([question, answer]) => (
              <p key={question} data-reveal>
                <strong>{question}</strong> {answer}
              </p>
            ))}
          </div>
        </section>

        <section className="landing-cta" data-reveal>
          <h2>
            Make the next
            <br />
            release count.
          </h2>
          <div>
            <Link className="btn primary" href="/login">
              Open your workspace <ArrowUpRight size={18} />
            </Link>
            <Link className="text-link" href="/help">
              Read the documentation <ArrowRight size={16} />
            </Link>
          </div>
        </section>
      </main>
      <MarketingFooter />
    </MarketingMotion>
  );
}
