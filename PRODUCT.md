# Product

## Register

product

## Users

Self-hosting developers who run this on their own machine and reach it from anywhere — desktop on
the same box, a phone on the LAN (scan the startup QR), or an outside device through a tunnel
(cloudflared / ngrok). A single bearer token gates every surface, so "users" is usually one trusted
operator plus whatever harnesses they point at the `/v1` gateway. Because the server can be exposed
to the open internet behind a tunnel, the audience at the edge is not always technical and not always
trusted — the interface has to make the security boundary obvious. The job to be done: hold a real
conversation with Claude (or any configured provider) and, in full-agent mode, let it read / write /
run on the host — from whatever device is in hand.

## Product Purpose

A local, self-hosted web app for chatting with Claude across three provider types — `local-agent`
(full Claude Agent SDK: tool use, streaming, per-chat working directory, permission prompts),
`anthropic-api` (stateless API chat), and `openai-compatible` (OpenRouter / Ollama / LM Studio / any
SSE endpoint). It doubles as an LLM gateway: a stateless `/v1` compatibility surface (OpenAI and
Anthropic wire formats) lets external harnesses (open-webui, Claude Code, claude-cli) route through
the same connections. Success is simple: the operator opens it on any device, picks a connection, and
talks to the model — with the agent's powers and the security boundary both legible at a glance.

## Brand Personality

Clean and friendly, in the lineage of Claude.ai and ChatGPT — the chat is the centerpiece and the
chrome stays quiet. Approachable, not corporate; calm, not flashy. Three words: **clear,
trustworthy, unobtrusive**. The interface should feel like a well-made consumer chat app that happens
to expose real power (agent tools, multi-provider routing, a gateway) without making the operator
feel they are flying a cockpit.

## Anti-references

- **Generic AI SaaS dashboard.** No cream / sand / parchment backgrounds, no endless identical card
  grids, no gradient text, no tiny tracked uppercase eyebrow over every section, no hero-metric
  template. The 2026 AI-slop look.
- **Gaudy / motion-heavy.** No loud full-saturation accents on resting state, no decorative animation
  that does not convey state, no glassmorphism-as-default, no bounce / elastic easing.
- **Cramped or sluggish.** No dense unreadable text, no muted gray on tinted near-white, no
  transitions slow enough to make the operator wait on the tool.

## Design Principles

1. **Readable before decorated.** Legibility is the product. Every text / background pair clears WCAG
   AA; when contrast is even close, push toward ink, never toward elegant light gray. This is the
   explicit bar for the current work and the standing default.
2. **The security boundary is part of the UI.** The server LAN-binds and can be tunneled to the open
   internet; the token, the auth state, and the `-auto` "runs and writes on the host" warning must
   read clearly, not hide in a corner. The operator should always know who can do what on their
   machine.
3. **The tool disappears into the conversation.** Chat is the centerpiece; connection management,
   settings, and the harness panel are support — styled quietly so they never compete with the
   message stream.
4. **One surface, phone and desktop.** Mobile is first-class (QR / LAN entry, responsive drawer,
   dvh-aware input), not a shrunk desktop. Touch targets, reachability, and reflow are designed, not
   inherited.
5. **Familiar over clever.** Standard affordances for standard tasks (real selects, modals only when
   earned, native form controls). Earned familiarity — a user fluent in Claude.ai / ChatGPT trusts it
   on sight — beats invented flair.

## Accessibility & Inclusion

Target **WCAG 2.1 AA**:

- Body text ≥ 4.5:1, large / bold text ≥ 3:1, placeholder text held to the same 4.5:1 (no
  muted-gray-on-tint).
- Visible keyboard focus indicators on every interactive element; the app is fully operable without a
  pointer.
- Touch targets ≥ 44×44px on the mobile surface.
- Every animation has a `prefers-reduced-motion: reduce` alternative (crossfade or instant).
- Semantic HTML and ARIA labels on icon-only controls; form inputs properly labelled and associated.
