# AGENTS.md

## Project

This is `reut-music-player`.

Goal: create a minimal Xpell 2 starter app for real-time vibe coding.


---

## Foundation

Follow these repo-local Codex skills from `skills/Codex`:

- `xpell-contract`
- `xpell-core`
- `xpell-node`
- `xpell-ui`
- `server-xvm`
- `vibe-server`
- `vibe-client`
- `xpell-app`

These skills are authoritative for architecture, transport, persistence, UI rules, and code generation.

Runtime generation knowledge lives in:

```text
skills/xpell

Use skills/xpell for Vibe AI prompt-building and XUI generation context.

Do not treat skills/xpell as Codex instruction contracts.

⸻

Scope

This starter focuses only on:
	•	loading an app from the server
	•	previewing prompt-driven UI/app changes
	•	applying and persisting confirmed changes
	•	minimal demo data, such as users

This project intentionally excludes:
	•	multi-tenant SaaS logic
	•	payments
	•	chatbot / agent flows
	•	onboarding systems
	•	admin systems
	•	voice features
	•	external channel APIs
	•	product analytics / billing

Do not introduce these features.

⸻

Stack
	•	TypeScript, ESM, NodeNext
	•	@xpell/node
	•	@xpell/ui
	•	Wormholes v2
	•	built-in ServerXVMModule
	•	optional XDB filesystem storage for demo entities

⸻

Architecture

Server
	•	Entry: server/src/main.ts
	•	Uses XNode.start()
	•	Wormholes is handled by XNode / XWebServer internally
	•	ServerXVMModule is already loaded by XNode
	•	Do not reimplement or duplicate ServerXVMModule

Server modules in this starter:
	•	users → simple demo data
	•	vibe → prompt → preview/apply flow
	•	vibe-ai → prompt knowledge selection + XAI generation pipeline
	•	xai → model provider abstraction loaded by @xpell/node

Client
	•	Uses XVM / XUI
	•	Loads app structure from the server
	•	Uses JSON-defined app/views
	•	Uses Wormholes for client ↔ server communication
	•	No React / Vue / JSX

⸻

Core Flow
	1.	Client loads current app from server-xvm
	2.	User writes a prompt
	3.	Server generates updated JSON
	4.	Client previews the change in memory only
	5.	User confirms
	6.	Server persists through server-xvm

This repo must preserve the distinction:
	•	preview = temporary, client-side / in-memory
	•	apply = persisted, authoritative

⸻

Server Rules
	•	All externally visible behavior must flow through _x.execute(xcmd)
	•	Use XModule as the only extension point
	•	Expose operations through underscore-prefixed XModule methods, for example _generate_view
	•	No transport logic inside modules
	•	No persistence logic in constructors
	•	No timers, polling, or autonomous background loops
	•	Params must use _snake_case
	•	Use structured errors
	•	Use _xlog, never console.log
	•	Never log secrets

⸻

Persistence Rules

Use the vibe-server persistence style, simplified for the starter:
	•	Use repository + codec boundaries where persistence is needed
	•	Module ops call repositories
	•	Repositories never call modules
	•	App/view persistence goes through server-xvm
	•	Business/demo data may use XDB filesystem storage

Do not add:
	•	tenant-aware storage
	•	multi-instance storage orchestration
	•	hidden persistence
	•	direct manual mutation of authoritative app state outside server-xvm

⸻

Transport Rules
	•	Wormholes v2 is the canonical transport
	•	Do not manually implement Wormholes gateway code in this repo
	•	Do not add Express endpoints for core app logic
	•	Transport is untrusted
	•	Server-controlled context must remain authoritative

⸻

UI Rules
	•	Client UI must be JSON-first
	•	Use XUI/XVM conventions
	•	No JSX
	•	No inline persisted JS handlers
	•	Use Nano-Commands v2 compatible data forms for persisted behavior
	•	No direct server logic inside UI components

⸻

Minimal Domain Model

Keep the starter very small.

Allowed starter entities/modules:
	•	users
	•	app/views through server-xvm

Optional later, but not now:
	•	products
	•	conversations
	•	messages
	•	outbox

These exist in the original vibe-server scope, but they are not needed for this starter.

⸻

Coding Guidelines
	•	Keep code deterministic and small
	•	Prefer simple, auditable modules
	•	No hidden state
	•	No framework assumptions
	•	Use ESM imports only
	•	Keep names stable
	•	Keep the repo easy for coding agents to understand

⸻

Feature Rule

Every feature in this repo must support this path:

prompt → preview → apply → persist

If a feature does not support that flow, do not add it.

⸻

Output Rules for Coding Agents
	•	Keep output as short as possible
	•	Do not print full files unless explicitly requested
	•	When modifying files, output only:
	•	changed filename
	•	one-line description
	•	Avoid repeating unchanged information
	•	Keep explanations minimal, preferably 1–3 lines

