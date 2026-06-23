---
name: Claude Web Agent
description: A calm, friendly chat console for Claude across multiple providers, with the security boundary kept visible.
colors:
  accent-blue: "#2563eb"
  accent-blue-deep: "#1d4ed8"
  accent-tint: "#dbeafe"
  accent-ink: "#1e3a8a"
  focus-ring: "#60a5fa"
  canvas: "#f9fafb"
  surface: "#ffffff"
  surface-sunken: "#f3f4f6"
  hairline: "#e5e7eb"
  ink: "#111827"
  ink-secondary: "#374151"
  ink-muted: "#4b5563"
  faint: "#6b7280"
  agent-tint: "#fffbeb"
  agent-hairline: "#fcd34d"
  agent-ink: "#92400e"
  agent-warn: "#b45309"
  notice-tint: "#fef9c3"
  notice-ink: "#854d0e"
  danger: "#dc2626"
  danger-stop: "#dc2626"
  danger-tint: "#fef2f2"
  danger-hairline: "#fca5a5"
  danger-ink: "#991b1b"
typography:
  title:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "normal"
  heading:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "normal"
  body:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "normal"
  ui:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "normal"
  label:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "normal"
  meta:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "normal"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
rounded:
  sm: "0.25rem"
  md: "0.375rem"
  lg: "0.5rem"
  xl: "0.75rem"
  bubble: "1rem"
  pill: "9999px"
spacing:
  1: "0.25rem"
  2: "0.5rem"
  3: "0.75rem"
  4: "1rem"
  5: "1.25rem"
  6: "1.5rem"
components:
  button-primary:
    backgroundColor: "{colors.accent-blue}"
    textColor: "{colors.surface}"
    typography: "{typography.label}"
    rounded: "{rounded.lg}"
    padding: "0.5rem 1rem"
    height: "2.75rem"
  button-primary-hover:
    backgroundColor: "{colors.accent-blue-deep}"
    textColor: "{colors.surface}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-secondary}"
    typography: "{typography.ui}"
    rounded: "{rounded.lg}"
    padding: "0.5rem 1rem"
    height: "2.75rem"
  button-danger:
    backgroundColor: "{colors.danger-stop}"
    textColor: "{colors.surface}"
    typography: "{typography.label}"
    rounded: "{rounded.lg}"
    padding: "0.5rem 1rem"
    height: "2.75rem"
  input-field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "0.5rem 0.75rem"
  message-user:
    backgroundColor: "{colors.accent-blue}"
    textColor: "{colors.surface}"
    typography: "{typography.body}"
    rounded: "{rounded.bubble}"
    padding: "0.5rem 1rem"
  message-assistant:
    backgroundColor: "{colors.surface-sunken}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.bubble}"
    padding: "0.5rem 1rem"
  tool-card:
    backgroundColor: "{colors.agent-tint}"
    textColor: "{colors.agent-ink}"
    typography: "{typography.meta}"
    rounded: "{rounded.md}"
    padding: "0.5rem 0.75rem"
  sidebar-item-active:
    backgroundColor: "{colors.accent-tint}"
    textColor: "{colors.accent-ink}"
    typography: "{typography.ui}"
    rounded: "{rounded.lg}"
    padding: "0.5rem 0.5rem"
---

# Design System: Claude Web Agent

## 1. Overview

**Creative North Star: "The Calm Console"**

This is a chat app first and an operator's console second, and both readings have to be true at
once. In front: a clean, friendly conversation surface in the lineage of Claude.ai and ChatGPT, the
message stream is the page, and everything else recedes. Behind it: a real console, this server can
run an agent that reads, writes, and executes on the host, and it can be reached from a phone on the
LAN or a stranger on a tunnel. So the design never lets the power go invisible. The token, the
connection state, the permission prompt, and the amber "the agent is doing something" cards are all
legible without being loud.

The palette is restrained by intent: a near-white canvas, white surfaces, a single blue that means
"primary action / current selection / focus" and nothing decorative, and a disciplined gray ramp for
text. Color carries meaning, never mood, blue for intent, amber for agent activity, red for danger
and destructive actions. Type is a single system sans at a fixed rem scale (no fluid headings; a
console is viewed at steady DPI), with a monospace channel reserved for the things you copy and paste:
tokens, URLs, working directories, tool JSON. Surfaces are flat at rest and earn shadow only as they
rise off the page, an inline card has a hairline border, a modal has a real shadow.

What it explicitly is not: a generic AI SaaS dashboard (no cream/sand backgrounds, no identical card
grids, no gradient text, no tracked-uppercase eyebrow over every panel, no hero-metric template); not
gaudy or motion-heavy (no full-saturation accents at rest, no decorative animation, no glassmorphism);
and not cramped or sluggish (no dense unreadable text, no muted-gray-on-tint, no transitions that make
the operator wait on their own tool).

**Key Characteristics:**
- Chat foreground, console background: the conversation dominates; power stays legible, never loud.
- One blue, used only for intent (primary action, selection, focus), never decoration.
- Meaningful color only: amber = agent activity, red = danger, blue = intent.
- Fixed rem type scale, system sans, with a monospace channel for copy/paste material.
- Flat by default; elevation rises with the component (border → shadow-sm → shadow-lg → shadow-xl).
- Legibility is non-negotiable: every text/background pair clears WCAG AA.

## 2. Colors

A restrained, near-monochrome product palette: one blue accent and a gray ramp on a near-white
canvas, with amber and red reserved as semantic signals.

### Primary
- **Intent Blue** (#2563eb): The single accent. Primary buttons, the user's own message bubbles, the
  selected sidebar chat (as a tint), and, as a lighter ring (#60a5fa), the keyboard focus indicator.
  Used for action / selection / focus only, never to decorate a surface.
- **Intent Blue Deep** (#1d4ed8): The hover/active state for primary buttons.
- **Selection Tint** (#dbeafe) + **Selection Ink** (#1e3a8a): The active sidebar row, a quiet tinted
  pill rather than a saturated fill, so navigation never competes with the chat.

### Secondary (Agent activity)
- **Agent Tint** (#fffbeb) + **Agent Hairline** (#fcd34d) + **Agent Ink** (#92400e): The amber tool
  card that appears inline when the local-agent calls a tool. Amber means "the machine is acting on
  your behalf," distinct from both blue intent and red danger.
- **Notice Tint** (#fef9c3) + **Notice Ink** (#854d0e): The connection-dropped banner in the header.

### Neutral
- **Canvas** (#f9fafb): The app background and chat scroll area. Near-white, chroma-free, never warm.
- **Surface** (#ffffff): Header, sidebar new-chat zone, cards, modals, inputs.
- **Sunken Surface** (#f3f4f6): The assistant's message bubble and inline code/JSON blocks.
- **Hairline** (#e5e7eb): Default borders and dividers; also the sidebar hover background.
- **Ink** (#111827): Primary text and the assistant's message body.
- **Ink Secondary** (#374151): Form labels.
- **Ink Muted** (#4b5563): Supporting sentences inside cards and modals.
- **Faint** (#6b7280): The lowest readable gray, timestamps and hints. This is the floor; nothing
  text-bearing sits below it.

### Danger
- **Danger** (#dc2626): Destructive actions (delete), error text and icons, the Stop button.
- **Danger Tint** (#fef2f2) + **Danger Hairline** (#fca5a5) + **Danger Ink** (#991b1b): The error
  message row and inline validation surfaces.

### Named Rules
**The One Blue Rule.** There is exactly one accent hue. Blue marks intent (primary action), selection
(current chat), and focus (keyboard ring), and is forbidden as decoration. If a blue rectangle is not
clickable, currently-selected, or focused, it is wrong.

**The Floor Rule.** #6b7280 (Faint) is the lightest gray any text may use. #9ca3af and below are for
non-text only (disabled fills, hairlines). Text on tint follows the same AA bar as text on white.

## 3. Typography

**Display / Body / UI Font:** System sans stack (`ui-sans-serif, system-ui, sans-serif`) — SF Pro,
Segoe UI, Roboto depending on platform.
**Mono Font:** System monospace (`ui-monospace, SFMono-Regular, Menlo, monospace`).

**Character:** One family, no display face. A console earns trust through familiarity and legibility,
not personality fonts; weight and size carry the whole hierarchy. The monospace channel is functional,
not stylistic: it marks exactly the strings the operator will select and copy (tokens, URLs, cwd
paths, tool JSON), so "this is literal, copy it verbatim" reads at a glance.

### Hierarchy
- **Title** (semibold 600, 1.125rem/18px, 1.4): The app name in the header, page titles ("Settings —
  Connections"), modal headings.
- **Heading** (semibold 600, 1rem/16px, 1.4): Section headings inside panels ("Add connection",
  "Connect from elsewhere / Harness").
- **Body** (regular 400, 1rem/16px, 1.6): Message content (rendered markdown via `prose prose-sm`),
  inputs, and the chat textarea. Prose wraps well before 75ch inside the capped bubble width.
- **UI** (regular 400, 0.875rem/14px, 1.4): The default control text, buttons, list rows, connection
  meta.
- **Label** (medium 500, 0.875rem/14px, 1.4): Form field labels.
- **Meta** (regular 400, 0.75rem/12px, 1.4): Timestamps, hints, the harness panel's helper lines.

### Named Rules
**The 12px Floor Rule.** 0.75rem (12px) is the smallest type in the system. Sub-12px sizes (the old
10px QR labels) are prohibited, they fail both the readable-text floor and the mobile target audience
who actually use the QR panel.

**The Mono-Means-Copy Rule.** Monospace is reserved for literal copy/paste strings (tokens, URLs, cwd,
tool JSON). Never use it for emphasis or flavor.

## 4. Elevation

The system is flat by default and lifts deliberately. Depth is not decoration; a component's shadow
encodes how far off the page it sits and how modal it is. Inline content (cards, list rows, the tool
card, message bubbles) is flat with a hairline border. As a surface rises, it trades the border for a
progressively softer, larger shadow.

### Shadow Vocabulary
- **Resting** (`border: 1px solid #e5e7eb`, no shadow): Cards, list rows, inputs, message bubbles.
  Inline content lying flat on the canvas.
- **Raised** (`box-shadow: 0 1px 2px rgba(0,0,0,0.05)` — Tailwind `shadow-sm`): The standalone Login
  card, the one surface floating on an otherwise empty screen.
- **Drawer** (`box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1)` — `shadow-lg`, mobile only,
  `md:shadow-none`): The slide-in navigation drawer below the `md` breakpoint. On desktop the rail is
  docked and flat.
- **Modal** (`box-shadow: 0 20px 25px -5px rgba(0,0,0,0.1)` — `shadow-xl`, over a `rgba(0,0,0,0.4)`
  backdrop): Permission and New Chat dialogs, the highest layer.

### Named Rules
**The Earned-Shadow Rule.** A surface gets a shadow only when it has physically left the page (a
floating card, a drawer, a modal). Flat inline content uses a hairline border, never a shadow, to
imply separation.

## 5. Components

### Buttons
- **Shape:** Gently rounded (0.5rem / `rounded-lg`). Touch-first controls hold a 44px minimum height
  (`min-h-[44px]`) so they clear the mobile target floor.
- **Primary:** Intent Blue (#2563eb) fill, white text, medium weight, `0.5rem 1rem` padding. Hover →
  Intent Blue Deep (#1d4ed8). The send button, create/save actions, the empty-state "new chat" CTA.
- **Secondary:** White fill, hairline border, ink-secondary text. Cancel, close, "Settings", copy
  buttons, the folder Browse button.
- **Danger / Stop:** Solid Danger (#dc2626) with white text for the in-flight Stop button; ghost
  danger (Danger text on a `hover:bg-red-50` wash) for the delete action in lists.
- **Disabled:** `opacity-40`, no pointer affordance.
- **Hover / Focus:** Background shift on hover (150ms). Keyboard focus shows a 2px Focus Ring
  (#60a5fa) — present on inputs today, and the standing requirement for every interactive element.

### Message Bubbles (signature)
- **User:** Intent Blue (#2563eb) fill, white text, large 1rem (`rounded-2xl`) corners, right-aligned,
  capped at 88% width (80% at `sm+`).
- **Assistant:** Sunken Surface (#f3f4f6) fill, Ink (#111827) text, same bubble radius, left-aligned.
  Body is rendered markdown (`prose prose-sm`); inline tool cards stack above the text.
- **Error:** Centered, Danger Tint (#fef2f2) fill, Danger Hairline border, Danger Ink (#991b1b) text,
  prefixed with a ⚠ glyph. A system note, not a participant in the conversation.

### Tool Card (signature)
- **Style:** Agent Tint (#fffbeb) fill, Agent Hairline (#fcd34d) border, `rounded-md`. The tool name
  in Agent Ink semibold with a ⚙ glyph; the arguments in a monospace JSON block beneath.
- **Meaning:** Amber is the "the agent is acting" channel, visually distinct from blue intent and red
  danger so an operator scanning the stream can see machine activity at a glance.

### Inputs / Fields
- **Style:** White fill, hairline border, `rounded-lg`, `0.5rem 0.75rem` padding. Monospace variant for
  token / URL / cwd fields; `type="password"` for secrets (token, API key).
- **Focus:** Border-less ring, 2px Focus Ring (#60a5fa) via `focus:ring-2` (`outline-none` is only ever
  paired with this ring, never used alone).
- **Error:** Danger Hairline border + a Danger Ink message row beneath the field group.

### Navigation (Sidebar)
- **Style:** A 16rem (`w-64`) rail on Canvas with a right hairline. Docked at `md+`; below `md` it
  becomes a `shadow-lg` drawer that slides in over a `bg-black/40` backdrop (200ms transform).
- **Rows:** UI-size text, `rounded-lg`. Active = Selection Tint (#dbeafe) fill + Selection Ink
  (#1e3a8a). Inactive hover = Hairline (#e5e7eb) wash. Per-row rename/delete actions sit at the trailing
  edge.

### Modals
- **Style:** Centered card at `sm+`, **bottom sheet** (`items-end`) on mobile, `rounded-xl`,
  `shadow-xl`, `bg-black/40` backdrop, `z-50`. Actions right-aligned, primary on the right.
- **Permission dialog (signature):** The security seam. Names the tool in monospace, shows the full
  argument JSON, and offers Deny (secondary) / Allow (primary). This dialog is where principle 2 lives:
  the operator approves machine action explicitly.

## 6. Do's and Don'ts

### Do:
- **Do** keep every text/background pair at **WCAG AA** — body ≥ 4.5:1, large/bold ≥ 3:1, placeholders
  at the same 4.5:1. When a gray is even close, step it toward Ink, never toward elegant light gray.
- **Do** keep **#6b7280 (Faint) as the lightest text**, on white and on tint alike. #9ca3af and below
  are non-text only.
- **Do** keep type at **12px and up**; the people using the QR/harness panel are often on a phone.
- **Do** give every interactive element a visible **2px Focus Ring (#60a5fa)** and a working keyboard
  path; icon-only controls get an `aria-label`.
- **Do** keep touch targets **≥ 44×44px** on the mobile surface; reveal row actions on focus and touch,
  not hover alone.
- **Do** reserve **monospace** for literal copy/paste strings (tokens, URLs, cwd, tool JSON).
- **Do** let color mean one thing: **blue = intent, amber = agent activity, red = danger.**
- **Do** keep transitions in the **150–250ms** band with ease-out; honor `prefers-reduced-motion`.

### Don't:
- **Don't** ship the generic AI SaaS look: no cream/sand/parchment backgrounds, no identical card
  grids, no gradient text, no tracked-uppercase eyebrow over every panel, no hero-metric template.
- **Don't** go gaudy or motion-heavy: no full-saturation accents at rest, no decorative animation that
  doesn't convey state, no glassmorphism, no bounce/elastic easing.
- **Don't** go cramped or sluggish: no dense unreadable text, no muted gray on tinted near-white, no
  transition slow enough to make the operator wait.
- **Don't** put **gray text on a colored fill** (e.g. a gray hint inside a blue bubble); use white or a
  tint of the fill's own hue.
- **Don't** use **blue except for intent/selection/focus.** A non-interactive blue rectangle is a bug.
- **Don't** rely on **hover-only** affordances for primary row actions; they vanish on touch and for
  keyboard users.
- **Don't** drop below the **44px** touch target or the **12px** type floor for any interactive or
  text-bearing element.
