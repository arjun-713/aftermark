import {
  MarketingNav,
  MarketingFooter,
  PricingSelector,
} from "../../components/landing";
export default function Pricing() {
  return (
    <div className="marketing">
      <MarketingNav />
      <main className="pricing-page">
        <h1>Plans for real workloads.</h1>
        <p>
          Proposed launch prices in USD. Choose an allowance for your team;
          quotas remain separate from payment state and trace storage.
        </p>
        <PricingSelector />
        <section className="pricing-explanation">
          <h2>What a standard evaluation covers</h2>
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
            Private preview: merchant approval and complete sandbox lifecycle
            validation are required before paid launch.
          </p>
        </section>
      </main>
      <MarketingFooter />
    </div>
  );
}
