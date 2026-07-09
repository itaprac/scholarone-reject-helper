---
name: ScholarOne Reject Helper
description: A calm technical control panel for safe editorial automation.
colors:
  control-blue: "#145c9e"
  workspace-fog: "#f7f8fa"
  quiet-surface: "#fbfcfe"
  editorial-ink: "#1f2328"
  slate-copy: "#626a73"
  structural-line: "#d8dee4"
  secondary-surface: "#eef1f4"
  action-red: "#a32828"
  action-red-soft: "#f7e7e7"
typography:
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 650
    lineHeight: 1.25
  section:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 650
    lineHeight: 1.35
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.3
rounded:
  control: "6px"
  pill: "999px"
spacing:
  xs: "5px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-secondary:
    backgroundColor: "{colors.quiet-surface}"
    textColor: "{colors.editorial-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
  button-danger:
    backgroundColor: "{colors.action-red-soft}"
    textColor: "{colors.action-red}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
  input:
    backgroundColor: "{colors.quiet-surface}"
    textColor: "{colors.editorial-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "8px 9px"
  count-pill:
    backgroundColor: "{colors.secondary-surface}"
    textColor: "{colors.editorial-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.pill}"
    padding: "2px 7px"
---

# Design System: ScholarOne Reject Helper

## Overview

**Creative North Star: "The Editorial Control Desk"**

This system should feel like a dependable local utility used during focused editorial work. It is compact, restrained, and explicit: configuration is easy to scan, reports carry the visual priority, and irreversible actions never look casual.

The interface uses familiar product controls, a light workspace suited to daytime desktop use, and a single blue accent reserved for focus and selection. It explicitly rejects colorful analytics dashboards, decorative SaaS cards, marketing-style hero sections, excessive animation, and hidden controls.

**Key Characteristics:**

- Calm technical density
- Familiar native controls
- Flat tonal hierarchy
- Context-rich destructive actions
- Keyboard-visible state

## Colors

The palette is a cool editorial neutral field with one controlled blue voice and a separate semantic red vocabulary.

### Primary

- **Control Blue** (`#145c9e`): focus rings, selected report state, and primary navigation feedback. It is functional, never decorative.

### Neutral

- **Workspace Fog** (`#f7f8fa`): application background.
- **Quiet Surface** (`#fbfcfe`): controls, tables, and raised working surfaces without using pure white.
- **Editorial Ink** (`#1f2328`): primary text.
- **Slate Copy** (`#626a73`): secondary labels and metadata.
- **Structural Line** (`#d8dee4`): borders and section dividers.
- **Secondary Surface** (`#eef1f4`): table headers, neutral pills, and inactive tonal separation.
- **Action Red** (`#a32828`): destructive action text and state.
- **Action Red Soft** (`#f7e7e7`): destructive action background.

**The One Blue Voice Rule.** Control Blue is reserved for focus, selection, and primary interactive state. It must not become decoration.

**The Explicit Danger Rule.** Red appears only when the action is destructive or a failure requires attention.

## Typography

**Display Font:** System UI (`-apple-system`, BlinkMacSystemFont, `Segoe UI`, `system-ui`, sans-serif)
**Body Font:** System UI (`-apple-system`, BlinkMacSystemFont, `Segoe UI`, `system-ui`, sans-serif)
**Label/Mono Font:** System UI for labels; `ui-monospace`, SFMono-Regular, Menlo, Consolas for paths and logs

**Character:** Native, compact, and dependable. One sans-serif family keeps the tool familiar, while monospace is limited to machine output and file paths.

### Hierarchy

- **Title** (650, 18px, 1.25): application identity only.
- **Section** (650, 15px, 1.35): workflow sections and report headings.
- **Body** (400, 14px, 1.45): controls, values, and supporting copy.
- **Label** (600, 12px, 1.3): concise field labels and table headers.

**The Operational Type Rule.** Labels remain short and familiar. Technical identifiers may use monospace; ordinary instructions must not.

## Elevation

The system is flat by default and uses tonal layering plus one-pixel borders instead of shadows. Depth is structural: the workspace, surfaces, selected rows, and dark job log are differentiated by color and boundaries.

**The Flat Control Desk Rule.** No decorative shadows. A surface earns separation through role, tone, or a one-pixel border.

## Components

### Buttons

- **Shape:** Gently curved technical controls (6px radius).
- **Secondary:** Quiet Surface background, Editorial Ink text, one-pixel Structural Line border, and 8px by 12px padding.
- **Danger:** Action Red Soft background with Action Red text and a muted red border.
- **Hover / Focus:** Hover shifts border and text toward Control Blue. Focus uses a clearly visible Control Blue ring. Active state remains immediate, with no decorative motion.

### Chips

- **Style:** Secondary Surface background, Editorial Ink text, pill shape, and compact numeric padding.
- **State:** Counts remain neutral unless they communicate a destructive or failure state.

### Cards / Containers

- **Corner Style:** Sections are not cards. Workflow groups use spacing and horizontal dividers.
- **Background:** Workspace Fog for the page, Quiet Surface for tables and controls.
- **Shadow Strategy:** None.
- **Border:** One-pixel Structural Line where separation is required.
- **Internal Padding:** 12px to 24px according to hierarchy.

### Inputs / Fields

- **Style:** Quiet Surface background, one-pixel Structural Line border, 6px radius, and 8px by 9px padding.
- **Focus:** Control Blue border plus a visible external focus ring.
- **Error / Disabled:** Native invalid semantics remain available; disabled controls reduce contrast but retain legible labels.

### Navigation

The compact top bar carries the product name, live job status, and a secondary refresh action. It remains visually quieter than the workflow content.

### Reports Table

Reports use a dense table with a tonal header, explicit selection state, and keyboard-operable rows. File paths are secondary metadata; human-readable state and counts carry priority.

## Do's and Don'ts

### Do:

- **Do** preserve a restrained palette with Control Blue limited to interaction and selection.
- **Do** place reports and current job state close to the actions they explain.
- **Do** use one-pixel Structural Line borders and tonal surfaces instead of shadows.
- **Do** keep every report selection and destructive action operable by keyboard.
- **Do** keep technical detail available without forcing it into the primary path.

### Don't:

- **Don't** create colorful analytics dashboards or decorative SaaS cards.
- **Don't** add marketing-style hero sections, excessive animation, or hidden controls.
- **Don't** make destructive actions look casual or equivalent to ordinary settings changes.
- **Don't** use glassmorphism, gradient text, or colored side-stripe borders.
- **Don't** use pure black or pure white surfaces.
