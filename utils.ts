export function isSafeRead(cmd: string) {
  // Expanded VIP list for pipeline operations
  const safeCommands = [
    'ls',
    'cat',
    'find',
    'which',
    'pwd',
    'whoami',
    'grep',
    'wc',
    'head',
    'tail',
    'echo',
  ];

  // 🛑 Instantly block redirects, sequences, backgrounding, and variable/command injection
  const dangerousOps = /[><;&\$`]/;
  if (dangerousOps.test(cmd)) return false;

  // Split the command by the pipe to check the chain
  const pipeline = cmd.split('|');

  for (let part of pipeline) {
    // Grab the first word of each piped segment (ignoring flags and args)
    const baseCmd = part.trim().split(/\s+/)[0];

    // If even one command in the pipe isn't on the VIP list, bounce it
    if (!safeCommands.includes(baseCmd)) {
      return false;
    }
  }

  return true;
}
