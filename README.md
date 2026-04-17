# ⚡ FRIDAY CLI

> A witty, autonomous AI agent that lives in your terminal — powered by Gemini or a local Ollama model.

FRIDAY follows the **ReAct (Reason → Act)** framework: she thinks out loud, decides on an action, executes it, reads the result, and loops — all without you lifting a finger. She can browse the web, run shell commands, navigate directories, stream files to disk, and even launch long-running processes in the background without losing the interactive session.

---

## Features

| Capability                  | Details                                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------------- |
| 🧠 **Multi-model support**  | Switch between Gemini, Mistral Nemo, Qwen, Gemma and more via the `-m` flag                        |
| 🕸️ **Web search**           | Google-backed text and image search via [Serper](https://serper.dev) — no scraping, no rate limits |
| 🤖 **Bash execution**       | Runs shell commands with real-time streaming output and an elapsed timer for long waits            |
| 🎮 **Interactive stdin**    | Interactive prompts from tools like `create-next-app` are wired to your keyboard — no hangs        |
| 🌙 **Background processes** | Long-running daemons (dev servers, watchers) are detached and logged — FRIDAY stays responsive     |
| 🗂️ **Process registry**     | Background PIDs are persisted to `~/.friday-bg.json` so they survive across sessions               |
| 📂 **Directory navigation** | `cd` is handled natively in-process so her working directory actually changes                      |
| ⬇️ **Streaming downloads**  | Fetches files directly to disk with a live progress bar — no buffering the whole file in memory    |
| 🎵 **Spotify playback**     | Play any song by name via `spotify_player` — auto-starts a local device if none is active          |
| 🔄 **Conversational loop**  | After completing a task, FRIDAY stays alive and waits for your next order                          |
| 🛡️ **Safety bouncer**       | Any non-read-only command or download requires explicit `[y/N]` approval before execution          |
| 🔁 **Self-correction**      | If the model returns malformed JSON, FRIDAY automatically asks it to retry                         |

---

## Architecture

FRIDAY is a single-file TypeScript agent (`index.ts`) built on the [Vercel AI SDK](https://sdk.vercel.ai). The core is a `while` loop (max 10 steps) that:

1. Sends the conversation history to the LLM
2. Strips everything outside the JSON response
3. Routes the parsed response to one of five **interceptors**:

```
LLM Response
    │
    ├── type: "search"             → serperSearch() → injects results into context
    ├── type: "command"            → askPermission()
    │       ├── background: true   → spawnBackground() → detached process + registry entry
    │       └── background: false  → spawnAsync() → real-time stdout/stderr stream
    ├── type: "download"           → askPermission() → streaming fetch → disk
    ├── type: "music"              → search track → activate PC device → playback start
    └── type: "chat"               → prints message → reads your next input
```

The step counter resets to `0` every time FRIDAY enters a `chat` turn, giving her a fresh 10-step runway for each new task in the same session.

---

## Prerequisites

- **Node.js** v18+ (for native `fetch` and Web Streams)
- **pnpm** (or npm/yarn)
- One or more of the following backends:
  - [Ollama](https://ollama.com) running locally with the desired model pulled
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

| Variable         | Required             | Description                                                        |
| ---------------- | -------------------- | ------------------------------------------------------------------ |
| `GEMINI_API_KEY` | Only for `-m gemini` | Get one free at [aistudio.google.com](https://aistudio.google.com) |
| `SERPER_API_KEY` | For web search       | Get 2,500 free queries/month at [serper.dev](https://serper.dev)   |

---

## Usage

```bash
friday [-m <model>] <your task>
```

### Model Selection

Use the `-m` flag (or `--model`) to choose a model. The default is `mistral-nemo` (local Ollama).

| Flag value | Model                    | Backend      |
| ---------- | ------------------------ | ------------ |
| `nemo`     | `mistral-nemo` (default) | Local Ollama |
| `gemma`    | `gemma2:9b`              | Local Ollama |
| `qwen`     | `qwen2.5-coder:7b`       | Local Ollama |
| `ollama`   | `gemma2:9b`              | Local Ollama |
| `gemini`   | Gemini 2.0 Flash         | Google Cloud |

### Examples

```bash
# Run with the default model (mistral-nemo)
friday find all .log files older than 7 days and delete them

# Run with Gemini
friday -m gemini summarise the git log from the last week and tell me what changed

# Use Qwen for a coding task
friday -m qwen refactor the utils.ts file to add JSDoc comments

# Search the web
friday -m gemini what is the latest stable version of Node.js

# Download a file
friday -m gemini download the latest Alpine Linux ISO and save it as alpine.iso

# Start a dev server in the background (FRIDAY detects it needs backgrounding)
friday start the dev server for this project

# Stop a background process in a new session
friday stop the dev server
```

### Interactive Session

Once FRIDAY completes a task and enters a `chat` turn, she waits for your next input at the `❯` prompt. Type `exit` or `quit` to end the session.

```
✨ FRIDAY: Done! The server is running on PID 43291. Logs at /tmp/friday-bg-1234.log. What's next?
❯ now open the browser at localhost:3000
❯ exit
👋 FRIDAY: Catch ya later, boss.
```

---

## Spotify Music Playback

FRIDAY can play songs on Spotify via [`spotify_player`](https://github.com/aome510/spotify-player). Just ask naturally:

```bash
friday -m gemini "play Back in Black"
friday -m gemini "put on some Plini"
friday -m gemini "I want to listen to Hotel California"
```

### Setup

**1. Install `spotify_player`**

Download the pre-built binary for your platform from the [releases page](https://github.com/aome510/spotify-player/releases) and place it in `~/.local/bin`.

**2. Create a Spotify app**

Go to [developer.spotify.com](https://developer.spotify.com/dashboard), create an app, and add `http://localhost:8888/callback` as a redirect URI.

**3. Configure `spotify_player`**

Run `spotify_player` once — it generates `~/.config/spotify-player/app.toml`. Add your credentials:

```toml
[app_config]
client_id = "your_client_id"
client_secret = "your_client_secret"
```

Then run `spotify_player` again to authenticate via the browser.

### How it works

1. FRIDAY searches for the track by name and retrieves its Spotify ID
2. It checks your active devices, preferring **Computer** type (browser/desktop app) to avoid accidentally playing on a remote speaker
3. If no PC device is found, it auto-starts `spotify_player` in the background as a local audio device (requires `streaming` feature — included in pre-built binaries)
4. Connects to the device and starts playback
5. Falls back to opening Spotify in the browser if any step fails

> **Note:** Spotify must be open on at least one device (browser, phone, or desktop app) unless `spotify_player` is running as a local device.

---

## How the Safety System Works

Before running any **non-read-only command** or initiating a **download**, FRIDAY pauses and asks:

```
⚠️ Allow execution? [y/N]:
⚠️ Allow download? [y/N]:
```

Commands that only read the filesystem (`ls`, `cat`, `find`, `grep`, `head`, `tail`, `echo`, `wc`, `which`, `pwd`, `whoami`) are automatically approved. Any command containing shell operators (`>`, `<`, `;`, `&`, `$`, `` ` ``) is **always** sent to the permission gate.

---

## Background Processes

When FRIDAY decides a command is a long-running daemon she uses `"background": true` in her JSON, which:

1. Spawns the process **fully detached** from FRIDAY's event loop
2. Redirects stdout + stderr to a timestamped log file at `/tmp/friday-bg-<timestamp>.log`
3. Writes the PID, command, log path, and cwd to **`~/.friday-bg.json`**
4. Returns the PID and log path to you immediately

**Checking logs:**

```bash
tail -f /tmp/friday-bg-1234567890.log
```

**Stopping a background process:**

```bash
# Ask FRIDAY — she'll read ~/.friday-bg.json and issue the kill
friday stop the dev server

# Or do it yourself
kill <pid>
```

On every FRIDAY startup, dead PIDs are automatically pruned from `~/.friday-bg.json`. If any processes from a previous session are still alive, FRIDAY warns you at launch.

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
