import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';

export interface MessageExchange {
  role: 'user' | 'assistant';
  text: string;
  timestamp?: string;
}

export interface ClaudeSession {
  sessionId: string;    // UUID from filename (e.g. "d61ee3f8-38ea-4316-8b4e-c90a8dd2e45e")
  projectName: string;  // last path segment of cwd (e.g. "my-project")
  projectPath: string;  // full cwd from first user record
  title: string;        // AI-generated title if available, otherwise first user message (≤60 chars)
  updatedAt: Date;      // file mtime (last write time)
  status: 'idle' | 'waiting' | 'active'; // idle=done, waiting=user sent/no reply yet, active=tools running
  source: 'claude' | 'bob'; // which AI IDE this session belongs to
}

interface ContentBlock {
  type?: string;
}

interface JsonlRecord {
  type?: string;
  cwd?: string;
  aiTitle?: string;     // present in ai-title records written by Claude Code
  timestamp?: string;
  message?: {
    content?: string | ContentBlock[];
  };
}

// Read ~/.claude/sessions/*.json and return session IDs whose Claude process
// is still running. Each file stores the PID and the kernel start-time
// (procStart) of the Claude process so we can distinguish a live session
// from a recycled PID.  Only interactive VS Code sessions are included.
export async function getActiveSessionIds(): Promise<Set<string>> {
  const active = new Set<string>();
  const sessionsDir = path.join(os.homedir(), '.claude', 'sessions');
  let files: string[];
  try {
    files = (await fs.promises.readdir(sessionsDir)).filter(f => f.endsWith('.json'));
  } catch {
    return active;
  }
  const DAY_MS = 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - DAY_MS;

  for (const file of files) {
    try {
      const raw = await fs.promises.readFile(path.join(sessionsDir, file), 'utf8');
      const data = JSON.parse(raw) as {
        pid?: number;
        sessionId?: string;
        procStart?: string | number;
        entrypoint?: string;
        startedAt?: number;
      };
      if (typeof data.pid !== 'number' || !data.sessionId) { continue; }
      if (data.entrypoint !== 'claude-vscode') { continue; }
      // Exclude processes started before the 24-hour window — these are
      // background sessions from a previous VS Code session that was never
      // properly closed, not sessions the user opened today.
      if (typeof data.startedAt === 'number' && data.startedAt < cutoff) { continue; }
      try {
        process.kill(data.pid, 0); // throws if process is dead
        // Verify the PID hasn't been recycled by comparing kernel start-times.
        const stat = await fs.promises.readFile(`/proc/${data.pid}/stat`, 'utf8');
        const actualStart = stat.split(' ')[21];
        if (String(data.procStart) === actualStart) {
          active.add(data.sessionId);
        }
      } catch {
        // Dead or unreadable — skip
      }
    } catch {
      // Malformed session file — skip
    }
  }
  return active;
}

// Fingerprint used to skip firing the event when nothing changed.
function sessionsFingerprint(sessions: ClaudeSession[]): string {
  return sessions.map(s => `${s.sessionId}:${s.status}:${s.title}:${s.updatedAt.getTime()}`).join('|');
}

// Run python3 with the given args and return stdout. Rejects on non-zero exit.
function _execPython3(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('python3', args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { reject(new Error(stderr || String(err))); return; }
      resolve(stdout);
    });
  });
}

export class SessionManager implements vscode.Disposable {
  private readonly _onDidChangeSessions = new vscode.EventEmitter<ClaudeSession[]>();
  readonly onDidChangeSessions: vscode.Event<ClaudeSession[]> = this._onDidChangeSessions.event;

  private _sessions: ClaudeSession[] = [];
  private _sessionFilePaths = new Map<string, string>();
  private _sessionSources = new Map<string, 'claude' | 'bob'>();
  private readonly _watcher: vscode.FileSystemWatcher;
  private readonly _projectsDir: string;
  private readonly _bobDbPath: string;
  private _debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly _pollTimer: ReturnType<typeof setInterval>;

  constructor(context: vscode.ExtensionContext) {
    this._projectsDir = path.join(os.homedir(), '.claude', 'projects');
    this._bobDbPath = path.join(os.homedir(), '.bob', 'db', 'bob.db');

    // Initial scan
    void this._scanSessions().then(sessions => {
      this._sessions = sessions;
      this._onDidChangeSessions.fire([...this._sessions]);
    });

    // FileSystemWatcher as fast path (may not fire reliably in WSL2)
    const pattern = new vscode.RelativePattern(
      vscode.Uri.file(this._projectsDir),
      '**/*.jsonl'
    );
    this._watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const refresh = () => {
      if (this._debounceTimer !== undefined) {
        clearTimeout(this._debounceTimer);
      }
      this._debounceTimer = setTimeout(() => {
        this._debounceTimer = undefined;
        void this._runScan();
      }, 250);
    };

    this._watcher.onDidCreate(refresh);
    this._watcher.onDidChange(refresh);
    this._watcher.onDidDelete(refresh);

    // Watch Bob DB WAL file for changes (written on every transaction commit)
    const bobDbDir = path.dirname(this._bobDbPath);
    const bobDbName = path.basename(this._bobDbPath);
    const bobPattern = new vscode.RelativePattern(
      vscode.Uri.file(bobDbDir),
      `${bobDbName}-wal`,
    );
    const bobWatcher = vscode.workspace.createFileSystemWatcher(bobPattern);
    bobWatcher.onDidCreate(refresh);
    bobWatcher.onDidChange(refresh);
    context.subscriptions.push({ dispose: () => bobWatcher.dispose() });

    // Polling fallback: re-scan every 5 s so status indicators and new sessions
    // stay current even when the FileSystemWatcher is silent (common in WSL2).
    this._pollTimer = setInterval(() => { void this._runScan(); }, 5_000);

    context.subscriptions.push(this);
  }

  getSessions(): ClaudeSession[] {
    return [...this._sessions];
  }

  /**
   * Resolve the upload source file for a session:
   * - Claude sessions: returns the existing .jsonl file path.
   * - Bob sessions: serialises recent exchanges to a temp .bob.json file.
   * Returns { filePath, cleanup } or null if the session cannot be found.
   */
  async exportSessionAsJson(
    sessionId: string,
  ): Promise<{ filePath: string; cleanup: () => void } | null> {
    const session = this._sessions.find(s => s.sessionId === sessionId);
    if (!session) { return null; }

    if (session.source === 'claude') {
      const filePath = this._sessionFilePaths.get(sessionId);
      if (!filePath) { return null; }
      return { filePath, cleanup: () => { /* nothing to clean up */ } };
    }

    // Bob session — build a minimal .bob.json envelope from DB data.
    const exchanges = await this._getBobRecentExchanges(sessionId);
    const envelope = {
      session_id: sessionId,
      harness: 'bob',
      username: os.userInfo().username,
      created_at: session.updatedAt.toISOString(),
      title: session.title,
      messages: exchanges.map(e => ({
        role: e.role,
        content: e.text,
        timestamp: e.timestamp ?? new Date().toISOString(),
      })),
    };

    const tmpFile = path.join(os.tmpdir(), `bob-session-${sessionId}.bob.json`);
    await fs.promises.writeFile(tmpFile, JSON.stringify(envelope, null, 2), 'utf8');
    return {
      filePath: tmpFile,
      cleanup: () => { try { fs.unlinkSync(tmpFile); } catch { /* ignore */ } },
    };
  }


  async getRecentExchanges(sessionId: string): Promise<MessageExchange[]> {
    const filePath = this._sessionFilePaths.get(sessionId);
    if (!filePath) { return []; }

    if (this._sessionSources.get(sessionId) === 'bob') {
      return this._getBobRecentExchanges(filePath);
    }


    let stat: { size: number };
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      return [];
    }

    const TAIL = 32768;
    const offset = Math.max(0, stat.size - TAIL);
    const size = stat.size - offset;
    const buf = Buffer.alloc(size);

    const fh = await fs.promises.open(filePath, 'r');
    try {
      const { bytesRead } = await fh.read(buf, 0, size, offset);
      const chunk = buf.subarray(0, bytesRead).toString('utf8');
      const lines = chunk.split('\n');
      const collected: MessageExchange[] = [];

      for (let i = lines.length - 1; i >= 0 && collected.length < 6; i--) {
        const trimmed = lines[i].trim();
        if (!trimmed) { continue; }
        try {
          const record = JSON.parse(trimmed) as JsonlRecord;

          if (record.type === 'user') {
            const content = record.message?.content;
            let text: string | null = null;
            if (typeof content === 'string' && content.trim().length > 0) {
              text = content.trim();
            } else if (Array.isArray(content)) {
              for (const block of content) {
                const b = block as { type?: string; text?: string };
                if (b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0) {
                  text = b.text.trim();
                  break;
                }
              }
            }
            if (text !== null) {
              const truncated = text.length > 150 ? text.slice(0, 150) + '…' : text;
              collected.push({ role: 'user', text: truncated, timestamp: record.timestamp });
            }

          } else if (record.type === 'assistant') {
            const content = record.message?.content;
            let text: string | null = null;
            if (Array.isArray(content)) {
              for (const block of content) {
                const b = block as { type?: string; text?: string };
                if (b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0) {
                  text = b.text.trim();
                  break;
                }
              }
            } else if (typeof content === 'string' && content.trim().length > 0) {
              text = content.trim();
            }
            if (text !== null) {
              const truncated = text.length > 250 ? text.slice(0, 250) + '…' : text;
              collected.push({ role: 'assistant', text: truncated, timestamp: record.timestamp });
            }
          }
        } catch {
          // Malformed line — skip
        }
      }

      return collected.reverse();
    } finally {
      await fh.close();
    }
  }

  dispose(): void {
    if (this._debounceTimer !== undefined) {
      clearTimeout(this._debounceTimer);
    }
    clearInterval(this._pollTimer);
    this._watcher.dispose();
    this._onDidChangeSessions.dispose();
  }

  private async _getBobRecentExchanges(taskId: string): Promise<MessageExchange[]> {
    const script = `
import sqlite3, json, sys
conn = sqlite3.connect(sys.argv[1])
cur = conn.cursor()
cur.execute(
    "SELECT role, data, created_at FROM messages WHERE task_id=? AND role IN ('user','assistant') ORDER BY created_at",
    (sys.argv[2],)
)
rows = [{'role': r[0], 'data': r[1], 'ts': r[2]} for r in cur.fetchall()]
print(json.dumps(rows))
conn.close()
`;
    let rows: Array<{ role: string; data: string; ts: number }>;
    try {
      const out = await _execPython3(['-c', script, this._bobDbPath, taskId]);
      rows = JSON.parse(out) as typeof rows;
    } catch {
      return [];
    }

    const collected: MessageExchange[] = [];
    for (const row of rows) {
      try {
        const d = JSON.parse(row.data) as { content?: unknown };
        let text: string | null = null;
        const content = d.content;
        if (typeof content === 'string' && content.trim()) {
          text = content.trim();
        } else if (Array.isArray(content)) {
          for (const block of content) {
            const b = block as { type?: string; text?: string };
            if (b.type === 'text' && b.text?.trim()) { text = b.text.trim(); break; }
          }
        }
        if (text === null) { continue; }
        const role = row.role === 'user' ? 'user' : 'assistant';
        const maxLen = role === 'user' ? 150 : 250;
        const truncated = text.length > maxLen ? text.slice(0, maxLen) + '…' : text;
        collected.push({ role, text: truncated, timestamp: new Date(row.ts).toISOString() });
      } catch { /* skip malformed */ }
    }

    return collected.slice(-6);
  }

  // Run a full scan and fire onDidChangeSessions only when something changed.
  private async _runScan(): Promise<void> {
    const sessions = await this._scanSessions();
    if (sessionsFingerprint(sessions) !== sessionsFingerprint(this._sessions)) {
      this._sessions = sessions;
      this._onDidChangeSessions.fire([...this._sessions]);
    }
  }

  private async _scanSessions(): Promise<ClaudeSession[]> {
    // Run sequentially to avoid the clear() in _scanClaudeSessions racing with
    // the map writes in _scanBobSessions.
    const claudeSessions = await this._scanClaudeSessions();
    const bobSessions = await this._scanBobSessions();
    const merged = [...claudeSessions, ...bobSessions];
    merged.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    return merged;
  }

  private async _scanClaudeSessions(): Promise<ClaudeSession[]> {
    const sessions: ClaudeSession[] = [];
    this._sessionFilePaths.clear();
    this._sessionSources.clear();

    const jsonlFiles = await this._findJsonlFiles(this._projectsDir);
    for (const filePath of jsonlFiles) {
      try {
        const session = await this._parseSessionFile(filePath);
        if (session !== null) {
          sessions.push(session);
        }
      } catch {
        // Silently skip files that fail to parse
      }
    }

    return sessions;
  }

  private async _scanBobSessions(): Promise<ClaudeSession[]> {
    // Bob IDE stores sessions in a SQLite DB at ~/.bob/db/bob.db.
    // We query it via python3 (always available) since there is no bundled
    // Node SQLite driver in the extension.
    const script = `
import sqlite3, json, sys
conn = sqlite3.connect(sys.argv[1])
conn.row_factory = sqlite3.Row
cur = conn.cursor()
cur.execute(
    "SELECT id, project_id, title, status, first_message, created_at, updated_at, env "
    "FROM tasks WHERE time_archived IS NULL AND first_message IS NOT NULL "
    "ORDER BY updated_at DESC LIMIT 100"
)
rows = [dict(r) for r in cur.fetchall()]
print(json.dumps(rows))
conn.close()
`;
    let rows: Array<{
      id: string;
      project_id: string;
      title: string;
      status: string;
      first_message: string;
      created_at: number;
      updated_at: number;
      env: string;
    }>;
    try {
      const out = await _execPython3(['-c', script, this._bobDbPath]);
      rows = JSON.parse(out) as typeof rows;
    } catch {
      return []; // DB absent or python3 unavailable
    }

    const sessions: ClaudeSession[] = [];
    for (const row of rows) {
      try {
        const sessionId = row.id;
        const title = (row.title || row.first_message || '').slice(0, 60);
        if (!title) { continue; }
        const updatedAt = new Date(row.updated_at);

        // Extract workspace path from env JSON
        let projectPath = '';
        try {
          const env = JSON.parse(row.env) as {
            workspace?: string;
            staticEnvInfo?: { primaryWorkspace?: string };
          };
          projectPath = env.staticEnvInfo?.primaryWorkspace ?? env.workspace ?? '';
          // project_id is "file:/path" — use as fallback
          if (!projectPath && row.project_id.startsWith('file:')) {
            projectPath = row.project_id.slice('file:'.length);
          }
        } catch { /* leave empty */ }
        const projectName = projectPath ? path.basename(projectPath) : '';

        // Map DB status to ClaudeSession status
        // 'running' = actively processing, 'active' = completed task (idle)
        const status: ClaudeSession['status'] = row.status === 'running' ? 'active' : 'idle';

        this._sessionFilePaths.set(sessionId, sessionId); // store id as key for lookup
        this._sessionSources.set(sessionId, 'bob');
        sessions.push({ sessionId, projectName, projectPath, title, updatedAt, status, source: 'bob' });
      } catch { /* skip malformed row */ }
    }
    return sessions;
  }

  private async _findJsonlFiles(dir: string): Promise<string[]> {
    const results: string[] = [];
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory() && entry.name !== 'subagents') {
          results.push(...(await this._findJsonlFiles(fullPath)));
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          results.push(fullPath);
        }
      }
    } catch {
      // Directory doesn't exist or isn't readable — return empty
    }
    return results;
  }

  private async _parseSessionFile(filePath: string): Promise<ClaudeSession | null> {
    const sessionId = path.basename(filePath, '.jsonl');

    const stat = await fs.promises.stat(filePath);
    const updatedAt = stat.mtime;

    // VS Code plugin sessions can have large attachment records before the first
    // user message. Read in 16 KB chunks up to 256 KB, collecting:
    //   - firstUserText + projectPath  (from the first user record)
    //   - aiTitle                      (from the ai-title record Claude Code writes)
    // Use aiTitle as the display title when available — it matches what VS Code
    // shows in the editor tab — and fall back to the raw first user message.
    const CHUNK_SIZE = 16384;
    const MAX_BYTES  = 262144;

    const fh = await fs.promises.open(filePath, 'r');
    try {
      let fileOffset = 0;
      let leftover = '';
      let firstUserText: string | null = null;
      let projectPath = '';
      let aiTitle: string | null = null;

      outer: while (fileOffset < MAX_BYTES) {
        const buf = Buffer.alloc(CHUNK_SIZE);
        const { bytesRead } = await fh.read(buf, 0, CHUNK_SIZE, fileOffset);
        if (bytesRead === 0) { break; }
        fileOffset += bytesRead;

        const chunk = leftover + buf.subarray(0, bytesRead).toString('utf8');
        const lines = chunk.split('\n');
        leftover = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) { continue; }
          try {
            const record = JSON.parse(trimmed) as JsonlRecord;

            if (record.type === 'user' && firstUserText === null) {
              const content = record.message?.content;
              let text: string | null = null;
              if (typeof content === 'string' && content.trim().length > 0) {
                text = content.trim();
              } else if (Array.isArray(content)) {
                for (const block of content) {
                  const b = block as { type?: string; text?: string };
                  if (
                    block !== null &&
                    typeof block === 'object' &&
                    b.type === 'text' &&
                    typeof b.text === 'string' &&
                    (b.text ?? '').trim().length > 0
                  ) {
                    text = (b.text ?? '').trim();
                    break;
                  }
                }
              }
              if (text !== null) {
                firstUserText = text;
                projectPath = typeof record.cwd === 'string' && record.cwd.length > 0
                  ? record.cwd : '';
              }
            }

            if (record.type === 'ai-title' &&
                typeof record.aiTitle === 'string' &&
                record.aiTitle.trim().length > 0) {
              aiTitle = record.aiTitle.trim();
            }

          } catch {
            // Malformed JSON line — skip
          }
        }

        // Stop once we have both pieces; ai-title appears shortly after the
        // first assistant reply so we never need to read far.
        if (firstUserText !== null && aiTitle !== null) { break outer; }
      }

      if (firstUserText === null) {
        return null;
      }

      const title = (aiTitle ?? firstUserText).slice(0, 60);
      const projectName = projectPath ? path.basename(projectPath) : '';
      const status = await this._readStatus(fh, stat.size, updatedAt);
      this._sessionFilePaths.set(sessionId, filePath);
      return { sessionId, projectName, projectPath, title, updatedAt, status, source: 'claude' as const };
    } finally {
      await fh.close();
    }
  }

  // Infer session status from the tail of the JSONL file.

  //
  // Status semantics:
  //   'idle'    — Claude is done, session is waiting for the user to act
  //   'waiting' — user sent a message, Claude has not yet started responding
  //   'active'  — Claude is generating a response or executing tools
  //
  // Gray (idle) should mean "nothing is happening, your turn". Green (active)
  // should cover everything Claude is actively doing.
  private async _readStatus(
    fh: Awaited<ReturnType<typeof fs.promises.open>>,
    fileSize: number,
    updatedAt: Date,
  ): Promise<'idle' | 'waiting' | 'active'> {
    if (fileSize === 0) {
      return 'idle';
    }
    const TAIL = 32768; // 32 KB covers large file-history-snapshot records
    const offset = Math.max(0, fileSize - TAIL);
    const size = fileSize - offset;
    const buf = Buffer.alloc(size);
    const { bytesRead } = await fh.read(buf, 0, size, offset);
    const chunk = buf.subarray(0, bytesRead).toString('utf8');

    // File modified in the last 30 s — Claude may be mid-stream even if the
    // last JSONL record looks terminal.
    const recentlyModified = (Date.now() - updatedAt.getTime()) < 30_000;

    const lines = chunk.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i].trim();
      if (!trimmed) { continue; }
      try {
        const record = JSON.parse(trimmed) as JsonlRecord;

        if (record.type === 'user') { return 'waiting'; }

        if (record.type === 'tool_use' || record.type === 'tool_result') {
          return 'active';
        }

        // Terminal records written at session end — session is done.
        if (record.type === 'pr-link' || record.type === 'last-prompt') {
          return 'idle';
        }

        if (record.type === 'assistant') {
          // If the assistant message contains tool_use blocks, those tools are
          // still executing — keep green regardless of recency.
          const content = record.message?.content;
          if (Array.isArray(content)) {
            const hasToolUse = content.some(b => b?.type === 'tool_use');
            if (hasToolUse) { return 'active'; }
          }
          // Pure text response: green if file is still being written (streaming),
          // gray once the file has been quiet for 30+ seconds.
          return recentlyModified ? 'active' : 'idle';
        }

        // Other record types (queue-operation, ai-title, file-history-snapshot)
        // are not meaningful for status — keep scanning backward.
      } catch {
        // Partial line at the start of the tail window — skip
      }
    }
    return recentlyModified ? 'active' : 'idle';
  }
}

