#!/usr/bin/env tsx
import 'dotenv/config';

// node dependencies
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import * as os from 'os';
import * as readline from 'readline/promises';

// internal dependencies
import { isSafeRead } from './utils.js';

// external dependencies
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';

const SERPER_API_KEY = process.env.SERPER_API_KEY;

const MAX_STEPS = 10;

// 🚀 spawnAsync — streaming executor that:
//   • wires stdin so interactive prompts (e.g. create-next-app) reach the user
//   • streams stdout/stderr in real-time instead of buffering
//   • returns the full combined output for FRIDAY's memory
function spawnAsync(
  cmd: string,
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', cmd], {
      cwd,
      // 'pipe' for stdout/stderr so we can stream and capture simultaneously;
      // 'inherit' for stdin so interactive prompts go straight to the user's keyboard
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    let stdoutBuf = '';
    let stderrBuf = '';

    child.stdout!.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdoutBuf += text;
      process.stdout.write(text); // real-time stream to terminal
    });

    child.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderrBuf += text;
      process.stderr.write(text); // real-time stream to terminal
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout: stdoutBuf, stderr: stderrBuf });
      } else {
        const err: any = new Error(
          `Process exited with code ${code}\n${stderrBuf || stdoutBuf}`,
        );
        err.stdout = stdoutBuf;
        err.stderr = stderrBuf;
        reject(err);
      }
    });

    child.on('error', reject);
  });
}

// ─────────────────────────────────────────────
// 🗂️ Background Process Registry (~/.friday-bg.json)
// ─────────────────────────────────────────────
interface BgProcess {
  pid: number;
  cmd: string;
  logFile: string;
  cwd: string;
  startedAt: string;
}

const BG_REGISTRY = path.join(os.homedir(), '.friday-bg.json');

function readRegistry(): BgProcess[] {
  try {
    return JSON.parse(fs.readFileSync(BG_REGISTRY, 'utf-8'));
  } catch {
    return [];
  }
}

function writeRegistry(entries: BgProcess[]): void {
  fs.writeFileSync(BG_REGISTRY, JSON.stringify(entries, null, 2));
}

// Remove entries whose processes are no longer alive
function pruneRegistry(): BgProcess[] {
  const alive = readRegistry().filter((entry) => {
    try {
      process.kill(entry.pid, 0); // signal 0 = existence check only
      return true;
    } catch {
      return false; // process gone
    }
  });
  writeRegistry(alive);
  return alive;
}

function addToRegistry(entry: BgProcess): void {
  const entries = readRegistry();
  entries.push(entry);
  writeRegistry(entries);
}

// 🌙 spawnBackground — fires a command fully detached so FRIDAY stays responsive
function spawnBackground(
  cmd: string,
  cwd: string,
): { pid: number; logFile: string } {
  const timestamp = Date.now();
  const logFile = `/tmp/friday-bg-${timestamp}.log`;
  const logStream = fs.openSync(logFile, 'w');

  const child = spawn('bash', ['-c', cmd], {
    cwd,
    stdio: ['ignore', logStream, logStream],
    detached: true,
  });

  child.unref(); // detach from FRIDAY's event loop

  const pid = child.pid!;
  addToRegistry({
    pid,
    cmd,
    logFile,
    cwd,
    startedAt: new Date().toISOString(),
  });

  return { pid, logFile };
}

// ─────────────────────────────────────────────
// 🔍 Daemon Pattern Heuristics
// Commands matching these patterns will run forever and must be backgrounded.
// ─────────────────────────────────────────────
const DAEMON_PATTERNS: RegExp[] = [
  /^npm\s+(run\s+)?(dev|start|serve|watch|preview)/,
  /^pnpm\s+(run\s+)?(dev|start|serve|watch|preview)/,
  /^yarn\s+(run\s+)?(dev|start|serve|watch|preview)/,
  /^bun\s+(run\s+)?(dev|start|serve|watch|preview)/,
  /^node\s+.*(server|app|index)\.(js|ts|mjs)$/,
  /^nodemon\b/,
  /^ts-node-dev\b/,
  /^next\s+(dev|start)/,
  /^vite(\s+dev)?\b/,
  /^nuxt\s+(dev|start)/,
  /^remix\s+dev/,
  /^astro\s+dev/,
  /^svelte-kit\s+dev/,
  /^expo\s+start/,
  /^react-native\s+start/,
  /^python.*manage\.py\s+runserver/,
  /^flask\s+run/,
  /^uvicorn\b/,
  /^gunicorn\b/,
  /^rails\s+server/,
  /^php\s+-S\b/,
  /^ruby\s+.*server/,
  /^tail\s+-f/,
  /^watch\b/,
];

function looksLikeDaemon(cmd: string): boolean {
  return DAEMON_PATTERNS.some((pattern) => pattern.test(cmd.trim()));
}

const currentDir: string = process.cwd();
const currentOS: string = `${os.type()} ${os.release()} (${os.platform()})`;
const desktopEnv: string =
  process.env.XDG_CURRENT_DESKTOP ||
  process.env.DESKTOP_SESSION ||
  'Unknown (possibly headless/SSH)';
const sessionType: string = process.env.XDG_SESSION_TYPE || 'unknown';
const currentDate: string = new Date().toLocaleDateString('en-IN', {
  weekday: 'long',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});

const systemPrompt: string = `You are FRIDAY, an Australian female witty autonomous CLI agent currently operating in: ${currentDir}
Today's date is: ${currentDate}
Operating System: ${currentOS}
Desktop Environment: ${desktopEnv} (${sessionType})

You MUST follow the ReAct (Reason -> Act) framework. NEVER guess absolute paths, system states, or URLs. If you lack information, execute a command to investigate first (e.g., using 'find', 'ls', 'cat', 'which').
Do not chain investigation and execution into a single bash command. Always investigate first, read the terminal output in the next step, and THEN execute the final action. Never pipe output to a file if you need to know the result yourself.
You MUST respond ONLY in valid JSON matching one of these THREE structures:

CRITICAL RULE: If the user is just greeting you, making small talk, or hasn't given a concrete task, DO NOT execute any commands. Simply use the 'chat' type to reply conversationally.

Treat these as EXAMPLES ONLY, do not copy them directly.

1. You have the ability to surf the web. To search the web (use "search_type": "text" for info/PDFs/pages, or "images" for pictures):
{
  "thought": "I need to find a high-res image URL of Joel from The Last of Us.",
  "type": "search",
  "query": "Joel The Last of Us high resolution wallpaper direct image URL filetype:jpg",
  "search_type": "images"
}

2. To investigate or execute a bash command:
{
  "thought": "I need to find the FRIDAY-cli folder before navigating. I will run a search.",
  "type": "command",
  "cmd": "find ~ -type d -name 'FRIDAY-cli' 2>/dev/null"
}

3. To reply to the user (ONLY when a task is fully complete or you need user input):
{
  "thought": "I have successfully navigated to the directory and verified its contents. I will inform the user.",
  "type": "chat",
  "message": "We are now in the FRIDAY-cli directory. What's next?"
}

4. When you have a direct URL to a file, you can download it natively:
{
  "thought": "I found the direct PDF link. Downloading it straight to the drive, boss.",
  "type": "download",
  "url": "https://example.com/report.pdf",
  "filename": "report.pdf"
}

5. For long-running daemon processes that would block the terminal (dev servers, watchers, log tailers, etc.), add "background": true to a command. This spawns the process detached and immediately returns control:
{
  "thought": "npm run dev will run forever. I'll background it so the boss keeps control.",
  "type": "command",
  "cmd": "npm run dev",
  "background": true
}
You will receive the PID and log file path back. To stop a backgrounded process later, use kill <PID> as a normal command.

Background process registry: The file ~/.friday-bg.json tracks all backgrounded processes with their PIDs, commands, log paths, and working directories. cat this file to find a PID to kill or check a log path.
`;

const localOllama = createOpenAI({
  baseURL: 'http://localhost:11434/v1',
  apiKey: 'ollama',
});

const google = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY });

// Model registry — add new models here
const MODEL_MAP: Record<
  string,
  ReturnType<typeof google | typeof localOllama>
> = {
  gemini: google('gemini-2.0-flash'),
  qwen: localOllama('qwen2.5-coder:7b'),
  gemma: localOllama('gemma2:9b'),
  ollama: localOllama('gemma2:9b'),
  nemo: localOllama('mistral-nemo'),
};

const DEFAULT_MODEL = 'mistral-nemo';

// Capture the orders
const rawArgs = process.argv.slice(2);
const cleanArgs: string[] = [];
let selectedModelName = DEFAULT_MODEL;

for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === '-m' || rawArgs[i] === '--model') {
    const next = rawArgs[i + 1];
    if (!next || next.startsWith('-')) {
      console.error(
        '❌ FRIDAY: -m flag requires a model name (e.g. FRIDAY -m gemini <task>)',
      );
      process.exit(1);
    }
    if (!(next in MODEL_MAP)) {
      console.error(
        `❌ FRIDAY: Unknown model "${next}". Available: ${Object.keys(MODEL_MAP).join(', ')}`,
      );
      process.exit(1);
    }
    selectedModelName = next;
    i++; // skip the model name argument
  } else {
    cleanArgs.push(rawArgs[i]);
  }
}

const model = MODEL_MAP[selectedModelName];
console.log(`⚡ Using model: \x1b[33m${selectedModelName}\x1b[0m`);

const prompt = cleanArgs.join(' ');

if (!prompt) {
  console.log("⚡ FRIDAY: I'm awake, boss. What's the mission?");
  process.exit(0);
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface ParsedResponse {
  thought: string;
  type: 'chat' | 'command' | 'search' | 'download';
  message?: string;
  cmd?: string;
  background?: boolean;
  query?: string;
  filename?: string;
  url?: string;
  search_type?: 'text' | 'images';
}

// 🔎 Serper — Google results via API, clean JSON, 2500 free queries/month
async function serperSearch(
  query: string,
  endpoint: string,
  isImageSearch: boolean,
): Promise<string> {
  if (!SERPER_API_KEY) throw new Error('SERPER_API_KEY is not set in .env');

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'X-API-KEY': SERPER_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ q: query, num: 3 }),
  });

  if (!res.ok)
    throw new Error(`Serper API error: ${res.status} ${res.statusText}`);

  const data = await res.json();

  let topResults = '';
  if (isImageSearch && data.images) {
    console.log('FRIDAY is searching for images... 🌇');
    // Extract direct image URLs
    topResults = data.images
      .slice(0, 3)
      .map(
        (img: any, i: number) =>
          `Result ${i + 1}:\nTitle: ${img.title}\nImage URL: ${img.imageUrl}`,
      )
      .join('\n\n');
  } else if (!isImageSearch && data.organic) {
    console.log('FRIDAY is searching for text... 📚');
    // Extract standard text snippets
    topResults = data.organic
      .slice(0, 3)
      .map(
        (r: any, i: number) =>
          `Result ${i + 1}:\nTitle: ${r.title}\nURL: ${r.link}\nSnippet: ${r.snippet}`,
      )
      .join('\n\n');
  }

  return topResults;
}

// The Bouncer — reusable permission gate for any risky action
async function askPermission(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer: string = await rl.question(question);
  rl.close();
  return answer.toLowerCase() === 'y';
}

// Vercel prefers the system prompt separated from the dynamic memory
const messages: Message[] = [{ role: 'user', content: prompt }];

// 2. The Brain Loop
async function startFRIDAY(): Promise<void> {
  try {
    let steps = 0;

    while (steps < MAX_STEPS) {
      steps++;

      // Start the loading spinner
      const frames: string[] = [
        '⠋',
        '⠙',
        '⠹',
        '⠸',
        '⠼',
        '⠴',
        '⠦',
        '⠧',
        '⠇',
        '⠏',
      ];
      let frameIndex = 0;
      const spinner = setInterval(() => {
        process.stdout.write(
          `\r\x1b[35m${frames[frameIndex]} FRIDAY is thinking...\x1b[0m`,
        );
        frameIndex = (frameIndex + 1) % frames.length;
      }, 80);

      const { text } = await generateText({
        model,
        system: systemPrompt,
        messages: messages,
      });

      // Stop the spinner and clear the line
      clearInterval(spinner);
      process.stdout.write('\r\x1b[K');

      // 🛡️ Bulletproof Extractor: Ignores everything outside the JSON brackets
      let cleanText: string = text;
      const firstBrace: number = text.indexOf('{');
      const lastBrace: number = text.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1) {
        cleanText = text.substring(firstBrace, lastBrace + 1);
      }

      try {
        const parsed: ParsedResponse = JSON.parse(cleanText);
        console.log(`\n🧠 FRIDAY thinks: \x1b[90m${parsed.thought}\x1b[0m`);
        messages.push({ role: 'assistant', content: cleanText });

        // 🕸️ The Web Search Interceptor
        if (parsed.type === 'search') {
          const isImageSearch = parsed.search_type === 'images';
          const endpoint = isImageSearch
            ? 'https://google.serper.dev/images'
            : 'https://google.serper.dev/search';
          console.log(
            `\n🔍 FRIDAY is searching the web for: \x1b[33m${parsed.query}\x1b[0m`,
          );
          console.log('⏳ Searching...');

          try {
            const topResults = await serperSearch(
              parsed.query!,
              endpoint,
              isImageSearch,
            );

            if (!topResults) {
              messages.push({
                role: 'user',
                content: `No search results found for "${parsed.query}". Try a different query.`,
              });
            } else {
              messages.push({
                role: 'user',
                content: `Search Results:\n${topResults}\n\nWhat is your next step?`,
              });
            }
          } catch (err: any) {
            console.log(`\n❌ Search failed: ${err.message}`);
            messages.push({
              role: 'user',
              content: `Search threw an error: ${err.message}. Try an alternative method or ask the user.`,
            });
          }
          continue;
        }

        // 💬 Chat Interceptor
        if (parsed.type === 'chat') {
          console.log(`\n✨ FRIDAY: ${parsed.message}`);

          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });
          const nextCommand: string = await rl.question('\n❯ ');
          rl.close();

          if (
            nextCommand.toLowerCase() === 'exit' ||
            nextCommand.toLowerCase() === 'quit'
          ) {
            console.log('👋 FRIDAY: Catch ya later, boss.');
            break;
          }

          steps = 0;
          messages.push({ role: 'user', content: nextCommand });
          continue;
        }

        // 🤖 Bash Command Interceptor
        if (parsed.type === 'command') {
          const rawCmd = parsed.cmd?.trim() ?? '';
          console.log(`\n🤖 FRIDAY wants to run: \x1b[36m${rawCmd}\x1b[0m`);

          if (!isSafeRead(rawCmd)) {
            const allowed = await askPermission('⚠️ Allow execution? [y/N]: ');
            if (!allowed) {
              console.log('🚫 Aborted.');
              messages.push({
                role: 'user',
                content:
                  'User denied permission to run this command. Ask them what to do next.',
              });
              continue;
            }
          }

          // 🌙 Background branch — model flagged it OR heuristic caught it
          const modelWantsBackground = !!parsed.background;
          const heuristicMatch =
            !modelWantsBackground && looksLikeDaemon(rawCmd);

          if (modelWantsBackground || heuristicMatch) {
            // For heuristic matches the model didn't flag, give the user a choice
            let shouldBackground = modelWantsBackground;
            if (heuristicMatch) {
              const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
              });
              const answer = await rl.question(
                `\n⚠️  This looks like a long-running process. [B]ackground / [r]un normally / [N]abort: `,
              );
              rl.close();
              const choice = answer.trim().toLowerCase();
              if (choice === 'n' || choice === '' || choice === 'N') {
                console.log('🚫 Aborted.');
                messages.push({
                  role: 'user',
                  content: 'User aborted. Ask them what to do next.',
                });
                continue;
              }
              shouldBackground = choice === 'b' || choice === 'B';
            }

            if (shouldBackground) {
              try {
                const { pid, logFile } = spawnBackground(rawCmd, process.cwd());
                console.log(`\n🌙 Backgrounded! PID \x1b[32m${pid}\x1b[0m`);
                console.log(`📄 Logs: \x1b[90m${logFile}\x1b[0m`);
                messages.push({
                  role: 'user',
                  content: `Process launched in background. PID: ${pid}. Logs streaming to: ${logFile}. What next?`,
                });
              } catch (err: any) {
                console.log(
                  `\n❌ Failed to background process: ${err.message}`,
                );
                messages.push({
                  role: 'user',
                  content: `Failed to launch background process: ${err.message}. What next?`,
                });
              }
              continue;
            }
            // If user chose 'r' (run normally), fall through to the streaming executor below
          }

          // ⏱️ Elapsed timer — updates every second, clears itself once output starts flowing
          const startTime = Date.now();
          let timerCleared = false;
          const elapsedTimer = setInterval(() => {
            if (!timerCleared) {
              const secs = Math.floor((Date.now() - startTime) / 1000);
              process.stdout.write(
                `\r\x1b[33m⏳ Executing... [${secs}s]\x1b[0m`,
              );
            }
          }, 1000);

          // Clear the timer line the moment real output starts arriving
          const clearTimer = () => {
            if (!timerCleared) {
              timerCleared = true;
              clearInterval(elapsedTimer);
              process.stdout.write('\r\x1b[K'); // erase the timer line
            }
          };

          // Append the CWD tracker so we can sync directory changes after execution
          const finalCmd = `${rawCmd} ; echo "__CWD__:$PWD"`;

          // Helper to extract CWD and strip the tracker from the captured output
          const syncDirAndCleanOutput = (rawOutput: string) => {
            let cleanOut = rawOutput;
            const match = rawOutput.match(/__CWD__:(.+)/);
            if (match && match[1]) {
              const newDir = match[1].trim();
              if (newDir !== process.cwd()) {
                try {
                  process.chdir(newDir);
                  console.log(
                    `\n📂 FRIDAY moved to: \x1b[36m${process.cwd()}\x1b[0m`,
                  );
                } catch (_) {}
              }
              cleanOut = cleanOut.replace(/__CWD__:.*/g, '').trim();
            }
            return cleanOut;
          };

          try {
            // Wire up the timer-clear trigger before spawning
            const origStdoutWrite = process.stdout.write.bind(process.stdout);
            let firstOutput = true;
            const watchedWrite = (...args: any[]): boolean => {
              if (firstOutput) {
                firstOutput = false;
                clearTimer();
              }
              return (origStdoutWrite as any)(...args);
            };
            process.stdout.write = watchedWrite as any;

            const { stdout, stderr } = await spawnAsync(
              finalCmd,
              process.cwd(),
            );

            // Restore the original write and make sure timer is cleared
            process.stdout.write = origStdoutWrite;
            clearTimer();

            const combined = syncDirAndCleanOutput(
              (stdout || '') + '\n' + (stderr || ''),
            );
            const output =
              combined.trim() ||
              'Command executed successfully with no output.';

            const lines = output.split('\n');
            const truncated =
              lines.length > 50
                ? lines.slice(-50).join('\n') + '\n...[output truncated]'
                : output;

            messages.push({
              role: 'user',
              content: `Command output:\n${truncated}\nWhat next?`,
            });
          } catch (error: any) {
            process.stdout.write = process.stdout.write; // no-op safety restore
            clearTimer();

            const combinedOutput =
              (error.stdout || '') + '\n' + (error.stderr || '');
            syncDirAndCleanOutput(combinedOutput);

            const cleanError = error.message.replace(/__CWD__:.*/g, '').trim();
            console.log(`\n❌ Command failed.\n\x1b[31m${cleanError}\x1b[0m`);
            messages.push({
              role: 'user',
              content: `Execution failed: ${cleanError}\nWhat next?`,
            });
          }
        }

        // ⬇️ The Native Stream Download Interceptor
        if (parsed.type === 'download') {
          console.log(
            `\n⬇️ FRIDAY is pulling down: \x1b[36m${parsed.filename}\x1b[0m`,
          );
          console.log(`🔗 Source: \x1b[90m${parsed.url}\x1b[0m`);

          const allowed = await askPermission('⚠️ Allow download? [y/N]: ');
          if (!allowed) {
            console.log('🚫 Download aborted.');
            messages.push({
              role: 'user',
              content:
                'User denied permission to download this file. Ask them what to do next.',
            });
            continue;
          }

          try {
            const response = await fetch(parsed.url!, {
              headers: {
                'User-Agent':
                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                Accept:
                  'text/html,application/pdf,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
              },
            });

            if (!response.ok || !response.body) {
              throw new Error(
                `Server rejected the request. HTTP Status: ${response.status}`,
              );
            }

            const safeFilename = path.basename(parsed.filename!);
            const fileStream = fs.createWriteStream(safeFilename);

            // Grab the total file size from the headers
            const contentLength = response.headers.get('content-length');
            const totalBytes = contentLength ? parseInt(contentLength, 10) : 0;
            let downloadedBytes = 0;

            console.log('⏳ Handshake successful. Streaming data...');

            // Iterate over the stream chunks
            for await (const chunk of response.body as any) {
              downloadedBytes += chunk.length;
              fileStream.write(chunk);

              const downloadedMB = (downloadedBytes / (1024 * 1024)).toFixed(2);

              if (totalBytes) {
                const totalMB = (totalBytes / (1024 * 1024)).toFixed(2);
                const percent = Math.round(
                  (downloadedBytes / totalBytes) * 100,
                );

                // Build a 20-character visual bar
                const filledBar = '█'.repeat(Math.round(percent / 5));
                const emptyBar = '░'.repeat(20 - Math.round(percent / 5));

                // \r resets the cursor to the start of the line so it overwrites itself
                process.stdout.write(
                  `\r\x1b[36m⬇️ [${filledBar}${emptyBar}] ${percent}% | ${downloadedMB}/${totalMB} MB\x1b[0m`,
                );
              } else {
                // Fallback just in case the server hides the Content-Length header
                process.stdout.write(
                  `\r\x1b[36m⬇️ Downloading... ${downloadedMB} MB (Total size hidden)\x1b[0m`,
                );
              }
            }

            fileStream.end();
            console.log(); // Drop down a line after the progress bar finishes

            const finalSizeMB = (downloadedBytes / (1024 * 1024)).toFixed(2);
            messages.push({
              role: 'user',
              content: `Download successful! Saved as ${safeFilename} (${finalSizeMB} MB). What next?`,
            });
          } catch (err: any) {
            console.log(`\n❌ Download failed: ${err.message}`);
            messages.push({
              role: 'user',
              content: `The download failed with error: ${err.message}. The URL might be protected or not a direct file. Try another source or tell the boss.`,
            });
          }
          continue;
        }
      } catch (e) {
        messages.push({ role: 'assistant', content: text });
        messages.push({
          role: 'user',
          content:
            'Invalid JSON. Output ONLY valid JSON without markdown or conversational text.',
        });
      }
    }
  } catch (error) {
    console.error(
      '❌ FRIDAY: Brain freeze! Check if Ollama is running.',
      error,
    );
  }
}

// Prune dead entries from previous sessions before FRIDAY wakes up
const activeBgProcesses = pruneRegistry();
if (activeBgProcesses.length > 0) {
  console.log(
    `\n\ud83d\udde1\ufe0f  ${activeBgProcesses.length} background process(es) still running from a previous session.`,
  );
  console.log(`   Check \\x1b[90m${BG_REGISTRY}\\x1b[0m for details.\n`);
}

startFRIDAY();
