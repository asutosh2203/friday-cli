#!/usr/bin/env tsx
import 'dotenv/config';

// node dependencies
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import * as os from 'os';
import { promisify } from 'util';
import * as readline from 'readline/promises';

// internal dependencies
import { isSafeRead } from './utils.js';

// external dependencies
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';

const SERPER_API_KEY = process.env.SERPER_API_KEY;

const MAX_STEPS = 10;
const execAsync = promisify(exec);

const currentDir: string = process.cwd();
const currentOS: string = `${os.type()} ${os.release()} (${os.platform()})`;
const currentDate: string = new Date().toLocaleDateString('en-IN', {
  weekday: 'long',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});

const systemPrompt: string = `You are Friday, an Australian female witty autonomous CLI agent currently operating in: ${currentDir}
Today's date is: ${currentDate}
Operating System: ${currentOS}

You MUST follow the ReAct (Reason -> Act) framework. NEVER guess absolute paths, system states, or URLs. If you lack information, execute a command to investigate first (e.g., using 'find', 'ls', 'cat', 'which').
Do not chain investigation and execution into a single bash command. Always investigate first, read the terminal output in the next step, and THEN execute the final action. Never pipe output to a file if you need to know the result yourself.
You MUST respond ONLY in valid JSON matching one of these THREE structures:

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
  "thought": "I need to find the friday-cli folder before navigating. I will run a search.",
  "type": "command",
  "cmd": "find ~ -type d -name 'friday-cli' 2>/dev/null"
}

3. To reply to the user (ONLY when a task is fully complete or you need user input):
{
  "thought": "I have successfully navigated to the directory and verified its contents. I will inform the user.",
  "type": "chat",
  "message": "We are now in the friday-cli directory. What's next?"
}

4. When you have a direct URL to a file, you can download it natively:
{
  "thought": "I found the direct PDF link. Downloading it straight to the drive, boss.",
  "type": "download",
  "url": "https://example.com/report.pdf",
  "filename": "report.pdf"
}
`;

// Capture the orders
const rawArgs = process.argv.slice(2);
let useGemini = false;
const cleanArgs: string[] = [];

for (const arg of rawArgs) {
  if (arg === '-g' || arg === '--gemini') {
    console.log('Using Gemini');
    useGemini = true;
  } else if (arg === '-q' || arg === '--qwen') {
    console.log('Using Qwen');
    useGemini = false; // Default behavior
  } else {
    cleanArgs.push(arg); // Keep actual commands
  }
}

const prompt = cleanArgs.join(' ');

if (!prompt) {
  console.log("⚡ Friday: I'm awake, boss. What's the mission?");
  process.exit(0);
}

const localOllama = createOpenAI({
  baseURL: 'http://localhost:11434/v1',
  apiKey: 'ollama',
});

const google = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY });

// Select the model based on the flag
const model = useGemini
  ? google('gemini-2.0-flash')
  : localOllama('qwen2.5-coder:7b');

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface ParsedResponse {
  thought: string;
  type: 'chat' | 'command' | 'search' | 'download';
  message?: string;
  cmd?: string;
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
    console.log('Friday is searching for images... 🌇');
    // Extract direct image URLs
    topResults = data.images
      .slice(0, 3)
      .map(
        (img: any, i: number) =>
          `Result ${i + 1}:\nTitle: ${img.title}\nImage URL: ${img.imageUrl}`,
      )
      .join('\n\n');
  } else if (!isImageSearch && data.organic) {
    console.log('Friday is searching for text... 📚');
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
async function startFriday(): Promise<void> {
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
          `\r\x1b[35m${frames[frameIndex]} Friday is thinking...\x1b[0m`,
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
        console.log(`\n🧠 Friday thinks: \x1b[90m${parsed.thought}\x1b[0m`);
        messages.push({ role: 'assistant', content: cleanText });

        // 🕸️ The Web Search Interceptor
        if (parsed.type === 'search') {
          const isImageSearch = parsed.search_type === 'images';
          const endpoint = isImageSearch
            ? 'https://google.serper.dev/images'
            : 'https://google.serper.dev/search';
          console.log(
            `\n🔍 F.R.I.D.A.Y. is searching the web for: \x1b[33m${parsed.query}\x1b[0m`,
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
          console.log(`\n✨ Friday: ${parsed.message}`);

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
            console.log('👋 Friday: Catch ya later, boss.');
            break;
          }

          steps = 0;
          messages.push({ role: 'user', content: nextCommand });
          continue;
        }

        // 🤖 Bash Command Interceptor
        if (parsed.type === 'command') {
          console.log(`\n🤖 Friday wants to run: \x1b[36m${parsed.cmd}\x1b[0m`);

          if (parsed.cmd?.trim().startsWith('cd ')) {
            const targetDir = parsed.cmd.trim().substring(3).trim();
            try {
              process.chdir(targetDir);
              messages.push({
                role: 'user',
                content: `Directory changed successfully to ${process.cwd()}. What next?`,
              });
              console.log(
                `\n📂 Friday moved to: \x1b[36m${process.cwd()}\x1b[0m`,
              );
            } catch (err: any) {
              messages.push({
                role: 'user',
                content: `Failed to change directory: ${err?.message}`,
              });
              console.log(`\n❌ Failed to move: ${err?.message}`);
            }
            continue;
          }

          if (!isSafeRead(parsed.cmd ?? '')) {
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

          console.log('⏳ Executing...');
          try {
            const { stdout, stderr } = await execAsync(parsed.cmd ?? '');
            const output: string =
              stdout ||
              stderr ||
              'Command executed successfully with no output.';

            console.log(`\nTerminal Output:\n\x1b[90m${output.trim()}\x1b[0m`);

            const lines: string[] = output.split('\n');
            const truncated: string =
              lines.length > 50
                ? lines.slice(-50).join('\n') + '\n...[output truncated]'
                : output;

            messages.push({
              role: 'user',
              content: `Command output:\n${truncated}\nWhat next?`,
            });
          } catch (error) {
            const err = error as Error;
            console.log(`\n❌ Command failed.\n\x1b[31m${err.message}\x1b[0m`);
            messages.push({
              role: 'user',
              content: `Execution failed: ${err.message}\nWhat next?`,
            });
          }
        }

        // ⬇️ The Native Stream Download Interceptor
        if (parsed.type === 'download') {
          console.log(
            `\n⬇️ F.R.I.D.A.Y. is pulling down: \x1b[36m${parsed.filename}\x1b[0m`,
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
      '❌ Friday: Brain freeze! Check if Ollama is running.',
      error,
    );
  }
}

startFriday();
