/**
 * Agent Tools & Autonomous Execution Loop for Nexus Terminal.
 * Inspired by OpenCode architecture:
 * - Tool definitions with risk classification (bash, write_file, edit_file)
 * - Multi-syntax tool call parser (Qwen/Hermes, XML, Markdown JSON)
 * - Safe terminal execution with buffer capture
 * - Human-in-the-loop approval and auto-approval for read-only actions
 * - File change tracking, diff calculation, and atomic reverting
 */
import { registry } from './sessions';
import { classifyRisk, type Risk } from './ollama';
import { AgentFileChange, recordFileChange } from './fileTracker';
import { bridge } from './bridge';

export interface AgentToolCall {
  id: string;
  tool: 'bash' | 'read_terminal' | 'write_file' | 'edit_file' | 'read_file';
  command: string;
  path?: string;
  content?: string;
  oldString?: string;
  newString?: string;
  description?: string;
  risk: Risk;
  status: 'pending' | 'running' | 'completed' | 'skipped' | 'failed';
  output?: string;
  error?: string;
  cwd?: string;
  fileChange?: AgentFileChange;
  createdAt: number;
}

export interface ParsedToolCallResult {
  cleanText: string;
  toolCalls: AgentToolCall[];
}

const uid = () => 'call_' + Math.random().toString(36).slice(2, 9);

/**
 * Parses tool calls from LLM response text across different model conventions:
 * 1. Qwen / Hermes / Ollama format:
 *    <|tool_call_start|>[bash(command='...')]<|tool_call_end|>
 * 2. XML tag format:
 *    <tool_call>{"name": "bash", "arguments": {"command": "..."}}</tool_call>
 * 3. Fenced code block format:
 *    ```tool_call\n{"name": "bash", "command": "..."}\n```
 */
function parseSingleToolJson(rawJson: string): AgentToolCall | null {
  try {
    const parsed = JSON.parse(rawJson);
    const root = parsed.function || parsed;
    const name = (root.name || root.tool || parsed.name || parsed.tool || '').toLowerCase();
    let args = root.arguments || root.args || parsed.arguments || parsed.args || root;
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {}
    }
    const command =
      args.command ||
      args.cmd ||
      (typeof root.command === 'string' ? root.command : '') ||
      (typeof parsed.command === 'string' ? parsed.command : '');
    const path = args.path || args.file || '';
    const content = args.content !== undefined ? args.content : '';
    const oldString = args.old_string || args.oldString || '';
    const newString = args.new_string || args.newString || '';

    if (name === 'read_file' || name === 'read') {
      const offset = typeof args.offset === 'number' ? args.offset : undefined;
      const limit = typeof args.limit === 'number' ? args.limit : undefined;
      return {
        id: uid(),
        tool: 'read_file',
        command: `Read ${path}${offset ? ` (lines ${offset}-${offset + (limit || 2000)})` : ''}`,
        path,
        args: { path, offset, limit },
        risk: { level: 'safe', reasons: ['Read-only file inspection'] },
        status: 'pending',
        createdAt: Date.now(),
      };
    }
    if (name === 'write_file' || name === 'write') {
      return {
        id: uid(),
        tool: 'write_file',
        command: `Write to ${path} (${content.split('\n').length} lines)`,
        path,
        content,
        args,
        risk: classifyRisk(`echo > "${path}"`),
        status: 'pending',
        createdAt: Date.now(),
      };
    }
    if (name === 'edit_file' || name === 'edit') {
      return {
        id: uid(),
        tool: 'edit_file',
        command: `Edit ${path}`,
        path,
        oldString,
        newString,
        args,
        risk: classifyRisk(`sed -i "${path}"`),
        status: 'pending',
        createdAt: Date.now(),
      };
    }
    if (name === 'bash' || name === 'sh' || name === 'read_terminal' || (name === '' && command)) {
      if (command) {
        const trimmedCmd = command.trim();
        // OpenCode normalization: If the model invoked `cat <filepath>` without pipes/redirects,
        // automatically normalize it to a first-class `read_file` tool call!
        const catMatch = trimmedCmd.match(/^cat\s+['"]?([^'"|><&;]+)['"]?$/);
        if (catMatch && !catMatch[1].startsWith('-')) {
          const filePath = catMatch[1].trim();
          return {
            id: uid(),
            tool: 'read_file',
            command: `Read ${filePath}`,
            path: filePath,
            args: { path: filePath },
            risk: { level: 'safe', reasons: ['Read-only file inspection'] },
            status: 'pending',
            createdAt: Date.now(),
          };
        }

        return {
          id: uid(),
          tool: name === 'read_terminal' ? 'read_terminal' : 'bash',
          command,
          args,
          description: parsed.description || root.description,
          risk: classifyRisk(command),
          status: 'pending',
          createdAt: Date.now(),
        };
      }
    }
  } catch {}
  return null;
}

export function parseAgentToolCalls(rawText: string): {
  cleanText: string;
  toolCalls: AgentToolCall[];
} {
  const toolCalls: AgentToolCall[] = [];
  let cleanText = rawText;

  // 1. Qwen / Hermes / Ollama: <|tool_call_start|>...<|tool_call_end|>
  const qwenPattern = /<\|tool_call_start\|>([\s\S]*?)<\|tool_call_end\|>/g;
  let match: RegExpExecArray | null;
  while ((match = qwenPattern.exec(rawText)) !== null) {
    const inner = match[1].trim();
    const fnMatch = inner.match(/\[?\s*([a-zA-Z0-9_-]+)\s*\(([\s\S]*?)\)\s*\]?/);
    if (fnMatch) {
      const toolName = fnMatch[1].toLowerCase();
      const rawArgs = fnMatch[2];

      if (toolName === 'read' || toolName === 'read_file') {
        const pathMatch = rawArgs.match(/(?:path|file)\s*=\s*(?:'([^']*)'|"([^"]*)")/);
        const p = pathMatch ? (pathMatch[1] ?? pathMatch[2]) : rawArgs.replace(/^['"]|['"]$/g, '').trim();
        if (p) {
          toolCalls.push({
            id: uid(),
            tool: 'read_file',
            command: `Read ${p}`,
            path: p,
            args: { path: p },
            risk: { level: 'safe', reasons: ['Read-only file inspection'] },
            status: 'pending',
            createdAt: Date.now(),
          });
        }
      } else if (toolName === 'edit' || toolName === 'edit_file') {
        const pathMatch = rawArgs.match(/(?:path|file)\s*=\s*(?:'([^']*)'|"([^"]*)")/);
        const oldMatch = rawArgs.match(/(?:old_string|oldString)\s*=\s*(?:'([^']*)'|"([^"]*)")/);
        const newMatch = rawArgs.match(/(?:new_string|newString)\s*=\s*(?:'([^']*)'|"([^"]*)")/);
        const p = pathMatch ? (pathMatch[1] ?? pathMatch[2]) : '';
        const oldString = oldMatch ? (oldMatch[1] ?? oldMatch[2]) : '';
        const newString = newMatch ? (newMatch[1] ?? newMatch[2]) : '';
        if (p) {
          toolCalls.push({
            id: uid(),
            tool: 'edit_file',
            command: `Edit ${p}`,
            path: p,
            oldString,
            newString,
            args: { path: p, oldString, newString },
            risk: classifyRisk(`sed -i "${p}"`),
            status: 'pending',
            createdAt: Date.now(),
          });
        }
      } else if (toolName === 'write' || toolName === 'write_file') {
        const pathMatch = rawArgs.match(/(?:path|file)\s*=\s*(?:'([^']*)'|"([^"]*)")/);
        const contentMatch = rawArgs.match(/(?:content)\s*=\s*(?:'([^']*)'|"([^"]*)")/);
        const p = pathMatch ? (pathMatch[1] ?? pathMatch[2]) : '';
        const content = contentMatch ? (contentMatch[1] ?? contentMatch[2]) : '';
        if (p) {
          toolCalls.push({
            id: uid(),
            tool: 'write_file',
            command: `Write to ${p}`,
            path: p,
            content,
            args: { path: p, content },
            risk: classifyRisk(`echo > "${p}"`),
            status: 'pending',
            createdAt: Date.now(),
          });
        }
      } else {
        let command = '';
        const cmdMatch = rawArgs.match(/command\s*=\s*(?:'([^']*)'|"([^"]*)")/);
        if (cmdMatch) {
          command = cmdMatch[1] ?? cmdMatch[2] ?? '';
        } else {
          command = rawArgs.replace(/^['"]|['"]$/g, '').trim();
        }

        if (command) {
          const trimmedCmd = command.trim();
          const catMatch = trimmedCmd.match(/^cat\s+['"]?([^'"|><&;]+)['"]?$/);
          if (catMatch && !catMatch[1].startsWith('-')) {
            const filePath = catMatch[1].trim();
            toolCalls.push({
              id: uid(),
              tool: 'read_file',
              command: `Read ${filePath}`,
              path: filePath,
              args: { path: filePath },
              risk: { level: 'safe', reasons: ['Read-only file inspection'] },
              status: 'pending',
              createdAt: Date.now(),
            });
          } else {
            toolCalls.push({
              id: uid(),
              tool: toolName === 'read_terminal' ? 'read_terminal' : 'bash',
              command,
              args: { command },
              risk: classifyRisk(command),
              status: 'pending',
              createdAt: Date.now(),
            });
          }
        }
      }
    }
  }
  cleanText = cleanText.replace(qwenPattern, '').trim();

  // 2. XML tag format: <tool_call>...</tool_call>
  const xmlPattern = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  while ((match = xmlPattern.exec(rawText)) !== null) {
    const toolCall = parseSingleToolJson(match[1].trim());
    if (toolCall) {
      toolCalls.push(toolCall);
    }
  }
  cleanText = cleanText.replace(xmlPattern, '').trim();

  // 3. Fenced code blocks with tool calls: ```tool_call, ```json, ```bash, ```sh, etc.
  const fenceBlockPattern = /```(?:tool_call|json|bash|sh|zsh)?\s*\n?([\s\S]*?)\n?```/gi;
  cleanText = cleanText.replace(fenceBlockPattern, (fullMatch, inner) => {
    const trimmedInner = inner.trim();
    const toolCall = parseSingleToolJson(trimmedInner);
    if (toolCall) {
      if (!toolCalls.some((c) => c.command === toolCall.command && c.tool === toolCall.tool)) {
        toolCalls.push(toolCall);
      }
      return ''; // Strip the tool call code block completely from user-facing text
    }
    return fullMatch; // Keep regular code blocks intended for the user to read
  });

  // 4. Naked balanced JSON objects (handles tool calls printed outside of code fences, or unclosed fences)
  const jsonCandidates: { start: number; end: number; call: AgentToolCall }[] = [];
  let i = 0;
  while (i < cleanText.length) {
    if (cleanText[i] === '{') {
      let depth = 0;
      let inString = false;
      let escape = false;
      const start = i;
      let foundEnd = -1;

      for (let j = i; j < cleanText.length; j++) {
        const char = cleanText[j];
        if (escape) {
          escape = false;
          continue;
        }
        if (char === '\\') {
          escape = true;
          continue;
        }
        if (char === '"') {
          inString = !inString;
          continue;
        }
        if (!inString) {
          if (char === '{') depth++;
          else if (char === '}') {
            depth--;
            if (depth === 0) {
              foundEnd = j;
              break;
            }
          }
        }
      }

      if (foundEnd !== -1) {
        const candidate = cleanText.slice(start, foundEnd + 1);
        const call = parseSingleToolJson(candidate);
        if (call) {
          jsonCandidates.push({ start, end: foundEnd + 1, call });
          i = foundEnd + 1;
          continue;
        }
      }
    }
    i++;
  }

  // Remove parsed naked JSON from cleanText in reverse order of index to preserve character positions
  for (let idx = jsonCandidates.length - 1; idx >= 0; idx--) {
    const { start, end, call } = jsonCandidates[idx];
    if (!toolCalls.some((c) => c.command === call.command && c.tool === call.tool)) {
      toolCalls.push(call);
    }
    cleanText = cleanText.slice(0, start) + cleanText.slice(end);
  }

  // 5. Clean up any leftover empty code fences or unclosed trailing fences
  cleanText = cleanText
    .replace(/```(?:tool_call|json|bash|sh|zsh)?\s*```/gi, '')
    .replace(/```(?:tool_call|json|bash|sh|zsh)?\s*$/i, '')
    .trim();

  return {
    cleanText,
    toolCalls,
  };
}

/**
 * Execute an agent tool call on the active terminal pane and capture its stdout/stderr.
 */
export async function executeAgentTool(
  call: AgentToolCall,
  activePaneId: string | null
): Promise<{ output: string; error?: string; fileChange?: AgentFileChange }> {
  if (!activePaneId) {
    throw new Error('No active terminal pane selected.');
  }

  const pane = registry.get(activePaneId);
  if (!pane || pane.status !== 'connected' || !pane.term) {
    throw new Error('Active terminal pane is not connected.');
  }

  const term = pane.term;
  call.cwd = pane.cwd || '~';

  if (call.tool === 'read_terminal') {
    const output = registry.context(activePaneId, 250);
    return { output: output || '(Terminal buffer is empty)' };
  }

  // Handle read_file (OpenCode direct file reader)
  if (call.tool === 'read_file' && call.path) {
    const filePath = call.path.trim().replace(/^['"]|['"]$/g, '');
    const isRemote = pane.hostId && pane.hostId !== 'local' && pane.hostId !== '__local__' && !pane.hostId.startsWith('local');

    if (!isRemote) {
      try {
        const fileContent = await bridge.localReadFile(
          filePath,
          typeof call.args?.offset === 'number' ? call.args.offset : undefined,
          typeof call.args?.limit === 'number' ? call.args.limit : undefined
        );
        return {
          output: fileContent,
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          output: `Error reading file: ${msg}`,
          error: msg,
        };
      }
    } else {
      // Remote SSH read
      const startLine = term.buffer.active.baseY + term.buffer.active.cursorY;
      pane.send(`cat "${filePath}"\r`);
      await new Promise((r) => setTimeout(r, 600));

      const maxWaitMs = 5000;
      const pollIntervalMs = 250;
      let elapsed = 0;
      let lastCaptured = '';

      while (elapsed < maxWaitMs) {
        await new Promise((r) => setTimeout(r, pollIntervalMs));
        elapsed += pollIntervalMs;
        const currentEnd = term.buffer.active.baseY + term.buffer.active.cursorY;
        const lines: string[] = [];
        const fromLine = Math.max(0, startLine);
        for (let i = fromLine; i <= currentEnd; i++) {
          const lineStr = term.buffer.active.getLine(i)?.translateToString(true) ?? '';
          lines.push(lineStr);
        }
        const currentText = lines.join('\n').trim();
        if (currentText && currentText === lastCaptured) break;
        lastCaptured = currentText;
      }
      return { output: lastCaptured || '(File is empty or no output)' };
    }
  }

  // Handle write_file
  if (call.tool === 'write_file' && call.path && call.content !== undefined) {
    const filePath = call.path.trim().replace(/^['"]|['"]$/g, '');
    const newContent = call.content;
    const isRemote = pane.hostId && pane.hostId !== 'local' && pane.hostId !== '__local__' && !pane.hostId.startsWith('local');
    let beforeContent = '';

    if (!isRemote) {
      try {
        beforeContent = await bridge.localReadFile(filePath);
      } catch {}
      await bridge.localWriteFile(filePath, newContent);
    } else {
      pane.send(`cat << 'NX_AGENT_EOF' > "${filePath}"\n${newContent}\nNX_AGENT_EOF\r`);
      await new Promise((r) => setTimeout(r, 600));
    }

    const change = recordFileChange(filePath, beforeContent, newContent);
    return {
      output: `✓ Wrote ${newContent.split('\n').length} lines to ${filePath} (+${change.additions} lines)`,
      fileChange: change,
    };
  }

  // Handle edit_file
  if (call.tool === 'edit_file' && call.path && call.oldString && call.newString) {
    const filePath = call.path.trim().replace(/^['"]|['"]$/g, '');
    const oldStr = call.oldString;
    const newStr = call.newString;
    const isRemote = pane.hostId && pane.hostId !== 'local' && pane.hostId !== '__local__' && !pane.hostId.startsWith('local');

    if (!isRemote) {
      await bridge.localEditFile(filePath, oldStr, newStr, call.args?.replaceAll);
    } else {
      const pyScript = `python3 -c "import sys; p='${filePath}'; s=open(p).read(); open(p,'w').write(s.replace(sys.argv[1], sys.argv[2]))" "${oldStr}" "${newStr}"`;
      pane.send(pyScript + '\r');
      await new Promise((r) => setTimeout(r, 700));
    }

    const change = recordFileChange(filePath, oldStr, newStr);
    return {
      output: `✓ Successfully edited ${filePath} (+${change.additions} -${change.deletions})`,
      fileChange: change,
    };
  }

  // Standard bash tool execution
  const buf = term.buffer.active;
  const startLine = buf.baseY + buf.cursorY;

  // Send command with carriage return
  pane.send(call.command + '\r');

  // Wait for command execution and capture output
  const maxWaitMs = 6000;
  const pollIntervalMs = 250;
  let elapsed = 0;
  let lastCaptured = '';

  await new Promise((r) => setTimeout(r, 600));

  while (elapsed < maxWaitMs) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    elapsed += pollIntervalMs;

    const currentEnd = term.buffer.active.baseY + term.buffer.active.cursorY;
    const lines: string[] = [];

    const fromLine = Math.max(0, startLine);
    for (let i = fromLine; i <= currentEnd; i++) {
      const lineStr = term.buffer.active.getLine(i)?.translateToString(true) ?? '';
      lines.push(lineStr);
    }

    const currentText = lines.join('\n').trim();
    if (currentText && currentText === lastCaptured) {
      break;
    }
    lastCaptured = currentText;
  }

  let finalOutput = lastCaptured;
  if (!finalOutput) {
    finalOutput = registry.context(activePaneId, 150);
  }

  const maxOutputChars = 24000;
  if (finalOutput.length > maxOutputChars) {
    finalOutput =
      finalOutput.slice(0, maxOutputChars) +
      `\n\n... [Output truncated to ${maxOutputChars} characters]`;
  }

  return {
    output: finalOutput || '(Command finished with no output)',
  };
}

/**
 * Reverts a file change on the live terminal pane.
 */
export async function revertFileChangeOnTerminal(
  change: AgentFileChange,
  activePaneId: string | null
): Promise<void> {
  if (!activePaneId) throw new Error('No active terminal pane');
  const pane = registry.get(activePaneId);
  if (!pane || pane.status !== 'connected') throw new Error('Terminal pane is not connected');

  if (change.before === '') {
    pane.send(`rm -f "${change.path}"\r`);
  } else {
    pane.send(`cat << 'NX_AGENT_EOF' > "${change.path}"\n${change.before}\nNX_AGENT_EOF\r`);
  }
}

/**
 * Format single tool execution output into a prompt for the agent continuation loop.
 */
export function formatToolContinuationPrompt(call: AgentToolCall, output: string): string {
  const isErr = call.status === 'failed' || Boolean(call.error);
  return (
    `[Tool execution result]\n` +
    `Action: ${call.tool} (\`${call.command}\`)\n` +
    `${isErr ? 'Error / Output:' : 'Output:'}\n\`\`\`\n${output}\n\`\`\`\n\n` +
    `Instructions: The command \`${call.command}\` has finished execution and its result is provided above. Analyze this result and take the single next step. Do NOT re-execute or repeat this same command. If another action is required, emit ONLY that next tool call now. If you have gathered all necessary information or completed the task, explain your conclusion to the user.`
  );
}

/**
 * Format batch tool execution outputs into a prompt for the agent continuation loop.
 */
export function formatBatchToolContinuationPrompt(
  completed: { call: AgentToolCall; output: string }[]
): string {
  const parts = completed
    .map(
      ({ call, output }, i) =>
        `--- Action ${i + 1}: ${call.tool} (\`${call.command}\`) ---\n\`\`\`\n${output}\n\`\`\``
    )
    .join('\n\n');

  return (
    `[Batch tool execution results]\n${parts}\n\n` +
    `Instructions: The commands above have finished execution and their results are provided. Analyze these results and take the single next step. Do NOT re-execute or repeat these commands. If another action is required, emit ONLY that next tool call now. If you have gathered all necessary information or completed the task, explain your conclusion to the user.`
  );
}
