# ⚡ Friday CLI

> A witty, autonomous AI agent that lives in your terminal — powered by Gemini or a local Ollama model.

Friday follows the **ReAct (Reason → Act)** framework: she thinks out loud, decides on an action, executes it, reads the result, and loops — all without you lifting a finger. She can browse the web, run shell commands, navigate directories, and stream files directly to disk.

---

## Features

| Capability                  | Details                                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------------- |
| 🧠 **Dual model support**   | Switch between Google Gemini 2.0 Flash (cloud) and a local Ollama model with a flag                |
| 🕸️ **Web search**           | Google-backed text and image search via [Serper](https://serper.dev) — no scraping, no rate limits |
| 🤖 **Bash execution**       | Runs shell commands, with a read-safe allowlist and a permission gate for anything risky           |
| 📂 **Directory navigation** | Handles `cd` natively in-process so her working directory actually changes                         |
| ⬇️ **Streaming downloads**  | Fetches files directly to disk with a live progress bar — no buffering the whole file in memory    |
| 🔄 **Conversational loop**  | After completing a task, Friday stays alive and waits for your next order                          |
| 🛡️ **Safety bouncer**       | Any non-read-only command or download requires explicit `[y/N]` approval before execution          |
| 🔁 **Self-correction**      | If the model returns malformed JSON, Friday automatically asks it to retry                         |

---

## Architecture

Friday is a single-file TypeScript agent (`index.ts`) built on the [Vercel AI SDK](https://sdk.vercel.ai). The core is a `while` loop (max 10 steps) that:

1. Sends the conversation history to the LLM
2. Strips everything outside the JSON response
3. Routes the parsed response to one of four **interceptors**:

```
LLM Response
    │
    ├── type: "search"   → serperSearch() → injects results into context
    ├── type: "command"  → askPermission() → execAsync() / process.chdir()
    ├── type: "download" → askPermission() → streaming fetch → disk
    └── type: "chat"     → prints message → reads your next input
```

The step counter resets to `0` every time Friday enters a `chat` turn, giving her a fresh 10-step runway for each new task in the same session.

---

## Prerequisites

- **Node.js** v18+ (for native `fetch` and Web Streams)
- **pnpm** (or npm/yarn)
- One of the following backends:
  - [Ollama](https://ollama.com) running locally with `qwen2.5-coder:7b` pulled
  - A Google Gemini API key for cloud mode

---

## Installation

```bash
# Clone the repo
git clone https://github.com/your-username/friday-cli.git
cd friday-cli

# Install dependencies
pnpm install

# Link the command globally
pnpm link --global
```

---

## Configuration

Create a `.env` file in the project root:

```env
GEMINI_API_KEY=your_gemini_api_key_here
SERPER_API_KEY=your_serper_api_key_here
```

| Variable         | Required           | Description                                                        |
| ---------------- | ------------------ | ------------------------------------------------------------------ |
| `GEMINI_API_KEY` | Only for `-g` flag | Get one free at [aistudio.google.com](https://aistudio.google.com) |
| `SERPER_API_KEY` | For web search     | Get 2,500 free queries/month at [serper.dev](https://serper.dev)   |

---

## Usage

```bash
friday [flags] <your task>
```

### Flags

| Flag       | Alias | Description                                             |
| ---------- | ----- | ------------------------------------------------------- |
| `--gemini` | `-g`  | Use Google Gemini 2.0 Flash (requires `GEMINI_API_KEY`) |
| `--qwen`   | `-q`  | Use local Ollama model — `qwen2.5-coder:7b` (default)   |

### Examples

```bash
# Run with the local Ollama model (default)
friday find all .log files older than 7 days and delete them

# Run with Gemini
friday -g summarise the git log from the last week and tell me what changed

# Search the web
friday -g what is the latest stable version of Node.js

# Download a file
friday -g download the latest Alpine Linux ISO and save it as alpine.iso
```

### Interactive Session

Once Friday completes a task and enters a `chat` turn, she waits for your next input at the `❯` prompt. Type `exit` or `quit` to end the session.

```
❯ now set the wallpaper to the image you just downloaded
❯ exit
```

---

## How the Safety System Works

Before running any **non-read-only command** or initiating a **download**, Friday pauses and asks:

```
⚠️ Allow execution? [y/N]:
⚠️ Allow download? [y/N]:
```

Commands that only read the filesystem (`ls`, `cat`, `find`, `grep`, `head`, `tail`, `echo`, `wc`, `which`, `pwd`, `whoami`) are automatically approved and run silently. Any command containing shell operators (`>`, `<`, `;`, `&`, `$`, `` ` ``) is **always** blocked and sent to the permission gate.

---

## Project Structure

```
friday-cli/
├── index.ts          # Main agent loop — all interceptors live here
├── utils.ts          # isSafeRead() — command allowlist and operator filter
├── tsconfig.json     # TypeScript config (ESNext, bundler resolution)
├── package.json
└── .env              # API keys (never commit this)
```

---

## Dependencies

| Package              | Role                                              |
| -------------------- | ------------------------------------------------- |
| `ai`                 | Vercel AI SDK — unified interface to any LLM      |
| `@ai-sdk/openai`     | OpenAI-compatible adapter (used for local Ollama) |
| `@ai-sdk/google`     | Google Gemini adapter                             |
| `dotenv`             | Loads `.env` at startup                           |
| `tsx` _(dev)_        | Runs TypeScript directly without a build step     |
| `typescript` _(dev)_ | Type checking                                     |

---

## License

ISC © Asutosh
