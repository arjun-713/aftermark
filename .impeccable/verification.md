# Aftermark frontend verification

The frontend was developed in `/tmp/aq-premium-frontend` with its own dependencies and Next output. The original root build and running services were kept separate.

## Scope

- Display identity: Aftermark, custom SVG mark and favicon, local Anton / Work Sans typography, mineral-green fields and a restrained application frame.
- Public landing, pricing, data handling and authentication pages; shared application shell, controls, data typography and mobile views.
- Documentation: sticky contents, current-section indication, deep links, focus handling and a mobile overlay that does not move the document.
- All backend/API/SDK/environment/issuer/database identifiers remain unchanged.

## User-directed follow-up

The user explicitly replaced the earlier type-only opening with one hero containing the product purpose and the complete interactive evidence example. The revised heading is “Verify agent outcomes.” The primary action opens `/login?mode=signup`. Sign in / Create account tabs remain visible regardless of backend mode. Google and GitHub links appear only when the API confirms availability; activation was explicitly deferred.

## Completed checks

- Production web build and TypeScript checks pass.
- Nine existing browser workflows were validated at desktop 1440, tablet 834 and phone 390. A later phone review rerun passed after the external evaluation worker was restarted. The flow covers onboarding, evidence, review claim/decision, dataset publication and comparison; the commerce flow covers invitations, retention, billing state, alerts and operations.
- The updated public workflow checks the interactive observation and CI result, plan allowances, documentation deep links/current location, responsive overflow, permanent account tabs and backend-driven signup/provider availability.
- The revised public/authentication workflow passed at all three widths against the hosted backend's real signup configuration. These checks read configuration and exercised navigation; they did not submit signup requests or send confirmation emails.
- Native mobile policy selection, dataset version opening, experiment report opening and documentation navigation were checked in the real browser. Opening mobile contents moved the document by 0px.
- Forty-two baseline production viewport captures showed no page overflow or browser errors. The required views were opened during QA. The revised hero/authentication captures replace their predecessors; the application and documentation remain covered by the baseline evidence.
- Reduced-motion capture retained visible content with 0 running animations.
- One Impeccable mechanical scan of the baseline changed targets returned an empty finding list. The later user-directed hero/auth correction receives a fresh rendered review.

## Design gates

The baseline landing passed Taste at 1440, 834, 768 and 390; the authenticated overview passed at 1440, 834 and 390. Both reported 0 FAIL. The revised hero passed at 1440, 834 and 390 with 0 FAIL and 5 WARN, recorded separately in `.taste-skill/user-hero/landing/`. The nine images listed by that report and the nine revised hero/sign-in/signup captures were opened during the final visual check. All three widths reported zero overflow and browser errors.

Defended warnings: this software is pictured through its real interface fragments rather than unrelated photographs or footage; public typography includes a large footer wordmark and distinct functional sizes; the measured text ink edges differ while section containers keep equal padding. The app retains 11–12px metadata/status sublines alongside larger primary data, and the decision-distribution chart is secondary to the actionable cases.

The revised tablet inspector also flags a name-only heading at its 834×521 viewport. The heading states the product action, and a visible paragraph beside it explains independent evidence, uncertain outcomes and regression tests. The rendered tablet capture confirms that description is in the first viewport; no additional marketing label is needed.

## Evidence locations

Generated QA files stay ignored:

- `.impeccable/review/`: viewport captures, browser and component checks, header bounds, mechanical detector output and seed reproduction.
- `.taste-skill/`: before/after inspectors, direction sheets, critique notes and local capture helpers.

The independent finish reviewer owns the final disposition. DESIGN.md and `.impeccable/design.json` are recorded by the separate documenter after review; this receipt does not substitute for those gates.
