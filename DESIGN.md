---
name: "Aftermark"
description: "Agent outcomes, on record."
colors:
  ground: "#edf0ec"
  surface: "#ffffff"
  raised: "#f6f8f5"
  active: "#e1e7df"
  border: "#e4e9e2"
  rule: "#edf0eb"
  control: "#c5cfc5"
  text: "#24312b"
  muted: "#5b685f"
  accent: "#28634a"
  positive: "#236547"
  negative: "#a43743"
  brand-paper: "#edf2e8"
  brand-ink: "#153d31"
  brand-dark: "#153d31"
  brand-light: "#e9f0df"
  focus: "#387653"
  primary-hover: "#265742"
  badge-caution-ink: "#7c5b18"
  badge-caution-field: "#f5edda"
  badge-positive-ink: "#22573b"
  badge-positive-field: "#e8f1e3"
  badge-negative-ink: "#94323e"
  badge-negative-field: "#f9e9e9"
  danger-button: "#a2343b"
  badge-neutral-ink: "#606a72"
  badge-neutral-field: "#f0f2f3"
  badge-inherited-positive-ink: "#286447"
  badge-inherited-positive-field: "#e9f4ed"
  badge-inherited-caution-ink: "#8a5c12"
  badge-inherited-caution-field: "#faf1de"
  badge-inherited-negative-ink: "#9e343c"
  badge-inherited-negative-field: "#fbebed"
  badge-inherited-quiet-ink: "#5e6870"
  distribution-pass: "#40866c"
  distribution-fail: "#b94f56"
  distribution-review: "#b2965f"
  distribution-unknown: "#b8bfc4"
typography:
  display:
    fontFamily: "Anton, sans-serif"
    fontSize: "clamp(64px, 5.45vw, 80px)"
    fontWeight: 400
    lineHeight: 1.05
    letterSpacing: "-0.015em"
  headline:
    fontFamily: "Anton, sans-serif"
    fontSize: "clamp(36px, 4.15vw, 60px)"
    fontWeight: 400
    lineHeight: 1.08
    letterSpacing: "-0.015em"
  title:
    fontFamily: "Work Sans, sans-serif"
    fontSize: "26px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.03em"
  body:
    fontFamily: "Work Sans, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  reading-body:
    fontFamily: "Work Sans, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.85
  label:
    fontFamily: "Work Sans, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.5
  button:
    fontFamily: "Work Sans, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.5
  public-button:
    fontFamily: "Work Sans, sans-serif"
    fontSize: "14px"
    fontWeight: 500
    lineHeight: 1.4
  reading-title:
    fontFamily: "Work Sans, sans-serif"
    fontSize: "46px"
    fontWeight: 500
    lineHeight: 1.16
    letterSpacing: "-0.04em"
  code:
    fontFamily: "IBM Plex Mono, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.8
  reading-code:
    fontFamily: "IBM Plex Mono, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.9
rounded:
  compact: "4px"
  control: "6px"
  panel: "8px"
  sheet: "16px"
spacing:
  tight: "8px"
  control-x: "12px"
  gap: "16px"
  panel: "20px"
  stack: "24px"
  pad: "28px"
  public-edge: "40px"
components:
  button-primary:
    backgroundColor: "{colors.brand-ink}"
    textColor: "{colors.surface}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "7px 12px"
    height: "35px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "7px 12px"
    height: "35px"
  button-public-primary:
    backgroundColor: "{colors.brand-ink}"
    textColor: "{colors.surface}"
    typography: "{typography.public-button}"
    rounded: "{rounded.compact}"
    padding: "12px 19px"
    height: "48px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "7px 10px"
    height: "36px"
  navigation-item:
    textColor: "#58665d"
    rounded: "{rounded.control}"
    padding: "7px 12px"
    height: "38px"
  navigation-item-active:
    backgroundColor: "{colors.active}"
    textColor: "#233b2c"
  badge-unknown:
    backgroundColor: "{colors.badge-caution-field}"
    textColor: "{colors.badge-caution-ink}"
    rounded: "{rounded.compact}"
    padding: "2px 7px"
  badge-pass:
    backgroundColor: "{colors.badge-positive-field}"
    textColor: "{colors.badge-positive-ink}"
    rounded: "{rounded.compact}"
    padding: "2px 7px"
  badge-fail:
    backgroundColor: "{colors.badge-negative-field}"
    textColor: "{colors.badge-negative-ink}"
    rounded: "{rounded.compact}"
    padding: "2px 7px"
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.panel}"
    padding: "{spacing.panel}"
  docs-navigation-item:
    textColor: "#5c6c5a"
    rounded: "{rounded.compact}"
    padding: "10px 12px"
  docs-navigation-item-active:
    backgroundColor: "#dbe7d2"
    textColor: "{colors.brand-ink}"
  outcome-record:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.panel}"
  button-danger:
    backgroundColor: "{colors.danger-button}"
    textColor: "{colors.surface}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "7px 12px"
    height: "35px"
  button-public-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    typography: "{typography.public-button}"
    rounded: "{rounded.compact}"
    padding: "12px 19px"
    height: "48px"
  auth-mode-tab:
    backgroundColor: "transparent"
    textColor: "#5b6a55"
    rounded: "3px"
    padding: "8px 12px"
    height: "38px"
  auth-mode-tab-selected:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.brand-ink}"
---

# Design System: Aftermark

## Overview

**Creative North Star: "Standards field manual"**

Aftermark gives short, forceful statements and structured evidence a common visual language. Mineral-green surfaces and deep forest ink establish a calm, practical tone. The custom converging A mark is the identity cue; condensed display type carries the strongest public expression.

Working content sits on white sheets within a pale frame. Rows, modest labels, aligned values, and explicit state colors keep the record legible. Reading surfaces share the same palette but use open Work Sans typography, a persistent contents rail, and generous line spacing. The visual system makes provenance and uncertainty visible without turning an example into customer proof.

The implemented source is `apps/web/app/styles.css`, followed by `apps/web/app/premium.css` in the root layout. The latter supplies the current identity and overrides. Font files are imported in `apps/web/app/layout.tsx`; the mark is the inline vector in `apps/web/components/brand.tsx`. This document records the shared visual system. Individual page composition belongs in its surface brief.

**Key Characteristics:**

- Flat mineral-green fields and deep forest ink.
- Anton statements paired with Work Sans reading and working type.
- A custom converging A mark and a quiet, framed application sheet.
- Structured evidence, readable statuses, and aligned technical values.
- Brief public motion with a complete reduced-motion state.

## Colors

Mineral greens carry the identity; the working canvas stays pale and white, with forest ink providing the strongest contrast. The frontmatter preserves the source hex values. The sidecar's tonal ramps are generated preview swatches, not additional application tokens.

### Primary

- **Forest Ink** (`brand-ink`, also `brand-dark`): the mark, public text, primary actions, and dark public fields. The two source names deliberately share one value.
- **Mineral Paper** (`brand-paper`): the public and reading page ground.
- **Light Mineral** (`brand-light`): text on dark public fields.
- **Action Green** (`accent`): carets and selected functional details.
- **Primary Hover** (`primary-hover`): the primary action's darker interaction state.
- **Focus Green** (`focus`): the common visible keyboard outline.

### Neutral

- **Frame Ground** (`ground`): the application's quiet surrounding frame.
- **White Sheet** (`surface`): the working sheet, fields, panels, and dialogs.
- **Raised Tint** (`raised`): contained secondary areas such as previews.
- **Selected Tint** (`active`): the active app destination and small control states.
- **Border**, **Rule**, and **Control Stroke** (`border`, `rule`, `control`): separate structural boundaries, quiet row dividers, and control outlines.
- **Working Ink** and **Muted Ink** (`text`, `muted`): the primary and supporting app text.

### Functional states

Status families carry meaning independently of the brand palette. Always keep their text labels; a colored dot alone is insufficient.

| Token family | Current meaning |
| --- | --- |
| `badge-caution` | Unknown, review, and pending badges. |
| `badge-positive` | Verified, pass, completed, and healthy badges. |
| `badge-negative` | Contradicted, fail, and failed badges. |
| `badge-neutral` | The base treatment for unmatched states. |
| `badge-inherited-positive` | Connected and active states retained from the base stylesheet. |
| `badge-inherited-caution` | Medium, disputed, and degraded states retained from the base stylesheet. |
| `badge-inherited-negative` | High severity retained from the base stylesheet. |
| `badge-inherited-quiet` | Disconnected, partial, running, and trialing text on the neutral badge field. |
| `positive`, `negative` | Existing positive details, negative controls, and error icons. |
| `danger-button` | Destructive action buttons. |
| `distribution-pass`, `distribution-fail`, `distribution-review`, `distribution-unknown` | Assessment distribution marks; unknown is gray in this visualization. |

The functional families above record the current cascade. They are not interchangeable brand accents.

**The Evidence Rule.** Keep claims, reported tool results, and independent observations visibly distinct. Unknown stays explicit until the record supports a conclusion.

## Typography

**Display Font:** Anton, with sans-serif fallback.
**Body Font:** Work Sans, with sans-serif fallback.
**Label/Mono Font:** Work Sans for labels; IBM Plex Mono, with monospace fallback, for technical code.

**Character:** Condensed uppercase statements give public pages their force. Open, modestly weighted Work Sans keeps the product and reading surfaces precise. The wordmark uses Work Sans rather than the condensed display face.

### Hierarchy

- **Display:** the short public opening statement. Its desktop values are in `typography.display`; the current responsive statement uses 64px at the 1100px boundary, 62px at 900px, and 47px at 600px.
- **Headline:** public section statements, using `typography.headline`.
- **Title:** application page titles use `typography.title`. The documentation introduction uses the larger, non-uppercase `typography.reading-title`; the privacy introduction keeps its own closely related component values.
- **Body:** application text uses `typography.body`. Documentation prose uses `typography.reading-body`, with a maximum measure of 72ch in the current reading layout.
- **Label:** compact form labels use `typography.label`. Other small record labels remain regular weight where the source does so.
- **Buttons:** application and public action labels have distinct `button` and `public-button` roles.
- **Code:** technical values use `typography.code`; documentation blocks use `typography.reading-code`. The illustrative CI fragment deliberately uses Work Sans to match its product fragment.

Work Sans weights 400, 500, and 600, Anton 400, and IBM Plex Mono 400 are supplied locally through the imported font packages. Technical figures use tabular numerals where the component requests them. Avoid synthesizing new font weights.

**The Two Type Roles Rule.** Use Anton for short public statements. Use Work Sans for work, instructions, navigation, forms, and long reading.

## Layout

Public fields use broad horizontal bands with a common edge: 40px at desktop, 28px at the 1100px breakpoint, and 20px at the 600px breakpoint. At widths of at least 1600px, the large public sections increase their edges with `max(40px, calc((100vw - 1440px) / 2))`. These are shared spacing behaviors; preserve each surface's own composition.

The desktop application is a 228px navigation column and a flexible white sheet. At 1200px and below the navigation becomes 210px; at 1000px and below it moves into a modal drawer. The desktop sheet has an 8px inset at its right and bottom, the `pad` horizontal spacing token, and a 26px top inset after the current override. Peer columns share the `gap` token. At 700px and below, the sheet reaches the viewport edges with 20px 18px 32px padding and task actions stay near the page title.

The app top bar is 56px high. The phone base control rule is a 44px minimum; scoped variants retain their implemented sizes, including compact header actions, filters, and the 38px account-mode tabs. Dense run records become stacked rows; dataset and experiment tables use labeled stacked cells. The selected policy version becomes a visible select control on phone layouts. Other data tables retain horizontal scrolling with the identity column available.

Documentation has a maximum width of 1200px with a 200px contents rail, an 80px gutter, and a flexible article. The rail narrows and the gutter tightens at 1100px. At 800px and below, contents become a sticky bar with an overlaid two-column list; opening it does not reflow the article. Reading section anchors account for the sticky navigation and contents bar.

The privacy page uses a narrower 910px maximum container. Authentication uses a bounded form and a supporting story at larger widths; the phone layout gives the form its own white sheet. Persistent Sign in and Create account modes keep account access explicit. Provider actions use the same secondary-button language and appear only when the backend advertises that provider. Preserve visible actions, focus, current selections, and meaningful reading order when adapting any surface.

## Elevation & Depth

The system is flat at rest. Broad tonal fields separate public sections; a pale frame distinguishes the white working sheet; fine borders and spacing separate data. Evidence panels and ordinary cards do not use decorative shadows.

The implemented floating dialog uses the `floating-dialog` shadow in the sidecar. Transient notifications use `floating-notification`. Their exact values belong in the sidecar because the frontmatter component schema does not carry shadows. Dialogs and mobile navigation share the green-black translucent overlay.

**The Flat Surface Rule.** Use fields, spacing, and fine dividers for hierarchy. Reserve the implemented shadows for floating dialogs and notifications.

## Shapes

Compact public controls, provenance tags, badges, and documentation navigation use the `compact` radius. App inputs and buttons use `control`; app panels and evidence containers use `panel`; the desktop working sheet and dialogs use `sheet`. Phone sheet edges become square where the layout meets the viewport. Circular avatars and tiny status dots remain small functional exceptions.

Edges are crisp and understated: control strokes carry affordance, quiet rules separate rows, and contained evidence clips cleanly to its corners. Do not add oversized rounding or floating decoration to an ordinary working panel.

## Components

### Buttons

Direct, compact actions with readable labels.

- **Primary:** forest ink with white text. The app variant uses the control radius and compact padding; the public variant uses the compact radius and a larger minimum height.
- **Secondary:** white on the app sheet; the public variant is transparent. Both retain a visible control stroke.
- **Destructive:** the existing danger fill and white label.
- **Text and icon actions:** quiet, compact utilities whose labels or accessible names remain intact.
- **States:** app primary hover changes fill and border; app secondary hover lightly tints the field. Public button fills retain their scoped treatment while border and brightness feedback remain visible. The common focus outline is 2px with a 4px offset. Pressing an action moves it down 1px. Disabled controls lower opacity to 0.65.
- **Motion:** color and border changes use 180ms; the small press or arrow response uses the implemented easing. Working screens use direct feedback.

### Chips

Small state records, not decorative pills.

- **Shape:** compact corners, 2px 7px padding, a small current-color dot, and a capitalized text label.
- **Color:** use the exact functional families in Colors. Keep the distinction between semantic badges and the muted provenance tag.
- **Behavior:** badges communicate state and do not imply an action when the source component is a span.

### Cards / Containers

Quiet, bounded work areas.

- **Application panels:** white, a fine structural border, the panel radius, and 20px internal padding.
- **Working sheet:** the major white canvas inside the tinted frame; its desktop rounding recedes on compact screens.
- **Evidence record:** a white, clipped record with a quiet toolbar and separate claim and observation areas. Keep provenance and the illustrative-example label visible.
- **Depth:** use the flat surface rule. Hovering a data row adds only a subtle background tint.

### Inputs / Fields

Familiar fields with precise labels.

- **Default:** white field, control stroke, control radius, and 7px 10px padding. The ordinary desktop minimum is 36px; the phone base rule grows fields to a 44px minimum while scoped controls retain their source overrides.
- **Authentication:** uses the public compact corner treatment and a 44px minimum.
- **Focus:** use the shared visible outline and action-green caret. Keep the label and help text associated with the field.
- **Error / disabled:** preserve the source's text feedback, alert semantics, and disabled behavior. Color supports the message.

### Navigation

The application sidebar uses receding labels and light-stroke icons; its current destination has a selected tint and stronger text. Review counts stay aligned at the far edge. At compact widths the same destinations move into a labeled modal drawer.

Public navigation pairs the custom mark and wordmark with readable links and the workspace action. Its smaller layouts use the existing disclosure menu. Documentation contents expose the current section, retain deep links, and return keyboard focus to the destination section.

### Authentication modes

The account form keeps Sign in and Create account visible as two tabs. A quiet mineral track surrounds the selected white tab. Selection changes the form and its accessible tab-panel relationship; arrow keys move between the modes. Provider actions appear only when supplied by the backend configuration. The visual system does not imply that Google or GitHub access is active in every environment.

### Outcome record

The signature pattern makes an agent claim, a reported tool result, an expected state, and an independently recorded observation separately readable. The illustrative landing record sits beside the product purpose in one hero and changes the outcome and CI result when its observation changes. Keep the example label and provenance beside the record, and preserve unknown as a visible, useful state.

Public motion supports the statement and evidence rather than delaying access. The source uses a masked line rise, short content travel, section reveals, and a small scroll-linked evidence movement. It runs only when reduced motion is not requested. Content is present before animation; reduced-motion styles retain the complete final state. Exact motion and breakpoint metadata are recorded in the sidecar.

## Do's and Don'ts

### Do:

- **Do** use the mineral-green fields and forest ink as the common identity across public, reading, and working surfaces.
- **Do** keep short public statements distinct from the Work Sans typography used for tasks and reading.
- **Do** show a text label with every status color and keep provenance labels beside their evidence.
- **Do** preserve the white working sheet, quiet frame, aligned data, and nearby primary action.
- **Do** keep complete content visible before motion runs and honor reduced-motion preferences.
- **Do** label illustrative records and preserve technical names such as agent-quality and aq.

### Don't:

- **Don't** apply the condensed public display face to app tables, navigation, forms, or documentation prose.
- **Don't** turn unknown or contradicted outcomes into brand-green success signals.
- **Don't** add decorative shadows or gradients to supply hierarchy that the established fields, spacing, and dividers already provide.
- **Don't** hide phone actions or the selected policy version when adapting dense work screens.
- **Don't** imply that an illustrative record is live provider evidence or customer proof.
