import { MarketingNav, MarketingFooter } from "../../components/landing";
export default function Privacy() {
  return (
    <div className="marketing" id="top">
      <MarketingNav />
      <main className="privacy-page">
        <h1>Data handling, plainly.</h1>
        <p>
          Understand what Aftermark records, how access is controlled, and where
          your evidence goes. Your workspace’s configuration determines the
          retention and connections that apply.
        </p>
        <section>
          <h2>What is recorded</h2>
          <p>
            Workspaces store redacted run events, expected outcomes, timestamped
            observations, immutable policies, evaluations and review decisions.
            The SDK redacts common personal and credential fields before
            transmission. You remain responsible for avoiding sensitive
            information in identifiers and for checking your redaction
            configuration.
          </p>
        </section>
        <section>
          <h2>Where processing happens</h2>
          <p>
            Singapore is the primary hosting and storage target. GitHub,
            HubSpot, Dodo and email services process the information necessary
            for their configured functions. Redacted semantic context may be
            sent to Jev outside Singapore. Upstream processing and retention
            follow the provider agreement; this product makes no upstream
            zero-retention promise.
          </p>
          <a
            href="https://docs.typesafe.ai/legal"
            target="_blank"
            rel="noreferrer"
          >
            Jev / TypeSafe data handling terms ↗
          </a>
        </section>
        <section>
          <h2>Retention and deletion</h2>
          <table>
            <tbody>
              <tr>
                <th>Detailed traces, evidence and evaluations</th>
                <td>
                  30 days by default; owner-configurable shorter retention
                </td>
              </tr>
              <tr>
                <th>Content-free aggregate metrics</th>
                <td>90 days</td>
              </tr>
              <tr>
                <th>Administrative audit metadata</th>
                <td>365 days</td>
              </tr>
              <tr>
                <th>Curated regression datasets</th>
                <td>Until customer deletion, within storage quota</td>
              </tr>
              <tr>
                <th>Independent recovery backups</th>
                <td>7 days</td>
              </tr>
            </tbody>
          </table>
          <p>
            Active deletion covers source records, payload objects and derived
            curated copies. A content-free deletion journal is reapplied during
            restoration. Backup expiry is separate from immediate active
            deletion.
          </p>
        </section>
        <section>
          <h2>Access and credentials</h2>
          <p>
            Workspace roles and project-scoped keys control access. Connector
            credentials use authenticated envelope encryption in production,
            with a Singapore KMS key. Payload downloads and exports require
            authorization; signed URLs are short-lived. Application logs exclude
            trace bodies, credentials and semantic context.
          </p>
        </section>
        <section>
          <h2>Contact and requests</h2>
          <p>
            Workspace owners manage exports, retention and deletion from the
            application. Contact your workspace owner for access or data
            requests. Example records and sample receipts are labeled wherever
            they appear.
          </p>
        </section>
      </main>
      <MarketingFooter />
    </div>
  );
}
