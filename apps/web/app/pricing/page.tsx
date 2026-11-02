import {
  MarketingNav,
  MarketingFooter,
  PricingSelector,
} from "../../components/landing";
export default function Pricing() {
  return (
    <div className="marketing" id="top">
      <MarketingNav />
      <main className="pricing-page">
        <h1>
          Plans for
          <br />
          your workflow.
        </h1>
        <p>
          Choose an allowance that fits your workflows. Keep evaluation usage,
          trace storage, and team access explicit as you grow.
        </p>
        <PricingSelector />
        <section className="pricing-explanation">
          <h2>One run. A clear allowance.</h2>
          <p>
            One frozen run revision under one policy, with up to 12 checks and a
            bounded semantic request budget. Essential evidence is never
            silently cut to fit. Larger analyses require an explicit additional
            reservation.
          </p>
          <p>
            Trial: 14 days. Paid allowances apply per billing period. Hard usage
            limits prevent automatic overage charges. The billing portal handles
            changes and cancellation after a subscription is configured.
          </p>
          <p>
            Checkout availability and your current entitlement are shown in your
            workspace. A checkout return never changes access on its own;
            billing follows verified payment-provider state.
          </p>
        </section>
      </main>
      <MarketingFooter />
    </div>
  );
}
