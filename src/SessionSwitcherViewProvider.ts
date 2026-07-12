import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import { SessionManager, ClaudeSession, MessageExchange } from './SessionManager';
import { readLiveWindows, writeWindowEntry, removeWindowEntry, discoverOwnIpcSocket, detectIdeCli, type WindowEntry } from './WindowRegistry';
import { BUILD_TIME, BUILD_VERSION } from './buildInfo';

// Sessions view shows the N most recently updated sessions across all sources.
// The remainder go to History (capped separately below).
const SESSIONS_LIMIT = 20;
const HISTORY_LIMIT = 50;

function getNonce(): string {
  return randomBytes(16).toString('hex');
}

export class SessionSwitcherViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = 'claudeSessionSwitcher.view';

  private _view?: vscode.WebviewView;
  private _viewDisposables: vscode.Disposable[] = [];
  private _historyOpen = false;
  private _focusWatcher: vscode.Disposable | undefined;
  private _registryTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _sessionManager: SessionManager,
  ) {
    this._focusWatcher = this._startFocusRequestWatcher();
    void this._publishWindowEntry();
    this._registryTimer = setInterval(() => { void this._publishWindowEntry(); }, 60_000);
  }

  // Publish this window's identity + IPC socket so other windows can focus it.
  private async _publishWindowEntry(): Promise<void> {
    const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
    await writeWindowEntry({
      pid: process.pid,
      workspaceFolders: folders,
      ideCli: detectIdeCli(undefined, vscode.env.appName),
      ipcSocket: discoverOwnIpcSocket() ?? process.env.VSCODE_IPC_HOOK_CLI ?? '',
      updatedAt: Date.now(),
    });
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._viewDisposables.forEach(d => d.dispose());
    this._viewDisposables = [];

    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // Refresh when session file metadata changes (status, titles)
    this._viewDisposables.push(
      this._sessionManager.onDidChangeSessions(() => {
        void this._pushSessions();
        if (this._historyOpen) { void this._pushHistory(); }
      })
    );

    // Refresh when Claude Code tabs open, close, or get renamed (tabGroups API added in VS Code 1.65)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tabGroups = (vscode.window as any).tabGroups as { onDidChangeTabs: vscode.Event<unknown> } | undefined;
    if (tabGroups) {
      this._viewDisposables.push(
        tabGroups.onDidChangeTabs(() => {
          void this._pushSessions();
          if (this._historyOpen) { void this._pushHistory(); }
        })
      );
    }

    this._viewDisposables.push(
      webviewView.webview.onDidReceiveMessage(async message => {
        switch (message.type) {
          case 'switchSession': {
            const sessionId = message.sessionId as string | undefined;
            if (!sessionId) { break; }
            void this._tryFocusForeignWindow(sessionId).then(result => {
              if (result === 'local') {
                this._openSessionLocal(sessionId);
              } else if (result === 'foreign-failed') {
                void vscode.window.showWarningMessage('Could not switch to the window containing this session.');
              }
            });
            break;
          }
          case 'newSession': {
            this._openNewSession();
            break;
          }
          case 'newBobSession': {
            void vscode.commands.executeCommand('bob-code.task.pickWorkspace');
            break;
          }
          case 'removeTab': {
            const sessionId = message.sessionId as string | undefined;
            if (!sessionId) { break; }
            this._closeTabForSession(sessionId);
            break;
          }
          case 'loadHistory': {
            this._historyOpen = true;
            void this._pushHistory();
            break;
          }
          case 'closeHistory': {
            this._historyOpen = false;
            break;
          }
          case 'addFromHistory': {
            const sessionId = message.sessionId as string | undefined;
            if (!sessionId) { break; }
            const allSessions = this._sessionManager.getSessions();
            const histSession = allSessions.find(s => s.sessionId === sessionId);
            if (histSession?.source === 'bob') {
              void vscode.commands.executeCommand('bobChatView.focus');
            } else {
              void vscode.commands.executeCommand('claude-vscode.primaryEditor.open', sessionId);
            }
            break;
          }
          case 'ready': {
            void this._pushSessions();
            break;
          }
          case 'getSessionPreview': {
            const sessionId = message.sessionId as string | undefined;
            if (!sessionId || !this._view) { break; }
            const exchanges: MessageExchange[] = await this._sessionManager.getRecentExchanges(sessionId);
            const session = this._sessionManager.getSessions().find(s => s.sessionId === sessionId);
            void this._view.webview.postMessage({
              type: 'sessionPreview',
              sessionId,
              projectPath: session?.projectPath ?? '',
              exchanges,
            });
            break;
          }
          case 'uploadToReckon': {
            const sessionId = message.sessionId as string | undefined;
            if (!sessionId) { break; }
            void this._uploadSessionToReckon(sessionId);
            break;
          }
          case 'copyToClipboard': {
            const text = message.text as string | undefined;
            if (typeof text === 'string') {
              void vscode.env.clipboard.writeText(text);
            }
            break;
          }
        }
      })
    );

    this._viewDisposables.push(
      vscode.window.onDidChangeWindowState(() => { void this._publishWindowEntry(); })
    );

    this._viewDisposables.push(
      webviewView.onDidDispose(() => { this._view = undefined; })
    );

    void this._pushSessions();
  }

  public dispose(): void {
    this._viewDisposables.forEach(d => d.dispose());
    this._viewDisposables = [];
    this._focusWatcher?.dispose();
    if (this._registryTimer) { clearInterval(this._registryTimer); }
    void removeWindowEntry(process.pid);
  }

  // Open a brand-new Claude conversation in the current window's editor.
  // `primaryEditor.open` with no sessionId creates a fresh panel in the active
  // editor column. We do NOT use `claude-vscode.newConversation` here: it only
  // notifies already-open Claude panels and is a no-op when none exist.
  private _openNewSession(): void {
    void vscode.commands.executeCommand('claude-vscode.primaryEditor.open');
  }

  // Reveal a live session in the current window. If it is already an open editor
  // tab, reveal it there (unambiguous). Otherwise it lives in the secondary side
  // panel, so focus that — the Claude extension exposes no per-session sidebar API,
  // and `preferredLocation` is a single global that can't track mixed-mode layouts.
  private _openSessionLocal(sessionId: string): void {
    const session = this._sessionManager.getSessions().find(s => s.sessionId === sessionId);
    if (!session) { return; }

    if (session.source === 'bob') {
      void vscode.commands.executeCommand('bobChatView.focus');
      return;
    }

    // Claude: prefer revealing in editor tab, fall back to sidebar
    if (this._openClaudeTabLabels().has(session.title)) {
      void vscode.commands.executeCommand('claude-vscode.primaryEditor.open', sessionId);
    } else {
      void vscode.commands.executeCommand('claude-vscode.sidebar.open');
    }
  }

  // Returns labels of all currently open Claude Code or Bob editor tabs.
  // Uses duck-typing (not instanceof) so it works from both the local and
  // remote extension hosts.
  private _openClaudeTabLabels(): Set<string> {
    const labels = new Set<string>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tabGroups = (vscode.window as any).tabGroups as { all: readonly { tabs: readonly { input: unknown; label: string }[] }[] } | undefined;
    if (!tabGroups) { return labels; }
    for (const group of tabGroups.all) {
      for (const tab of group.tabs) {
        // Duck-type: Claude Code panels have 'claudeVSCodePanel', Bob panels have 'bobChatView'
        const input = tab.input as { viewType?: string } | null | undefined;
        if (input?.viewType?.includes('claudeVSCodePanel') ||
            input?.viewType?.includes('bobChatView')) {
          labels.add(tab.label);
        }
      }
    }
    return labels;
  }

  private _sortedByRecency(): ClaudeSession[] {
    return [...this._sessionManager.getSessions()]
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  private async _pushSessions(): Promise<void> {
    if (!this._view) { return; }
    const sessions = this._sortedByRecency().slice(0, SESSIONS_LIMIT);
    void this._view.webview.postMessage({ type: 'updateSessions', sessions });
  }

  private async _pushHistory(): Promise<void> {
    if (!this._view) { return; }
    const sessions = this._sortedByRecency().slice(SESSIONS_LIMIT, SESSIONS_LIMIT + HISTORY_LIMIT);
    void this._view.webview.postMessage({ type: 'updateHistory', sessions });
  }

  // Close the Claude Code editor tab whose label matches the session's title.
  private _closeTabForSession(sessionId: string): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tabGroups = (vscode.window as any).tabGroups as { all: readonly { tabs: readonly { input: unknown; label: string }[] }[]; close(tab: unknown): unknown } | undefined;
    if (!tabGroups) { return; }
    const session = this._sessionManager.getSessions().find(s => s.sessionId === sessionId);
    if (!session) { return; }
    for (const group of tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input as { viewType?: string } | null | undefined;
        if (input?.viewType?.includes('claudeVSCodePanel') && tab.label === session.title) {
          void tabGroups.close(tab);
          return;
        }
      }
    }
  }

  // Called when a focus-<pid>.json file is created/changed in the session-switcher dir.
  // Reads the request, checks freshness, calls primaryEditor.open, and deletes the file.
  async _handleFocusRequest(uri: { fsPath: string }): Promise<void> {
    try {
      const raw = await fs.promises.readFile(uri.fsPath, 'utf8');
      const data = JSON.parse(raw) as { sessionId?: unknown; requestedAt?: unknown };
      if (typeof data.sessionId !== 'string' || typeof data.requestedAt !== 'number') { return; }
      if (Date.now() - data.requestedAt > 10_000) { return; }
      this._openSessionLocal(data.sessionId);
    } catch { /* malformed or missing */ } finally {
      try { await fs.promises.unlink(uri.fsPath); } catch { /* already gone */ }
    }
  }

  // Watch for focus requests addressed to this window's PID and handle them.
  private _startFocusRequestWatcher(): vscode.Disposable {
    const dir = path.join(os.homedir(), '.claude', 'session-switcher');
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    const pattern = new vscode.RelativePattern(
      vscode.Uri.file(dir),
      `focus-${process.pid}.json`,
    );
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    watcher.onDidCreate(uri => { void this._handleFocusRequest(uri); });
    watcher.onDidChange(uri => { void this._handleFocusRequest(uri); });
    return watcher;
  }

  // Find the live registry entry for a different window whose workspace owns the
  // session's project. Returns null when the session belongs to this window (local)
  // or has no live owner.
  private async _findOwnerWindow(sessionId: string): Promise<WindowEntry | null> {
    const session = this._sessionManager.getSessions().find(s => s.sessionId === sessionId);
    if (!session?.projectPath) { return null; }
    const windows = await readLiveWindows();
    return windows.find(w =>
      w.pid !== process.pid &&
      w.workspaceFolders.some(wf => session.projectPath === wf || session.projectPath.startsWith(wf + '/')),
    ) ?? null;
  }

  private async _tryFocusForeignWindow(sessionId: string): Promise<'focused' | 'foreign-failed' | 'local'> {
    const owner = await this._findOwnerWindow(sessionId);
    if (!owner) { return 'local'; }
    if (!owner.ipcSocket || !owner.ideCli) { return 'foreign-failed'; }

    try {
      const dir = path.join(os.homedir(), '.claude', 'session-switcher');
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(
        path.join(dir, `focus-${owner.pid}.json`),
        JSON.stringify({ sessionId, requestedAt: Date.now() }),
        'utf8',
      );

      await new Promise<void>((resolve, reject) => {
        execFile(
          owner.ideCli,
          ['--reuse-window', owner.workspaceFolders[0]],
          { env: { ...process.env, VSCODE_IPC_HOOK_CLI: owner.ipcSocket }, timeout: 3000 },
          err => { if (err) { reject(err); } else { resolve(); } },
        );
      });

      return 'focused';
    } catch {
      return 'foreign-failed';
    }
  }

  private async _uploadSessionToReckon(sessionId: string): Promise<void> {
    const config = vscode.workspace.getConfiguration('reckon');
    const scriptPath: string = config.get('uploadScriptPath') ?? '';
    if (!scriptPath || !fs.existsSync(scriptPath)) {
      // Script not configured or not found — fail silently.
      console.log('[reckon] upload_session.py not found (reckon.uploadScriptPath:', scriptPath || '(unset)', ')');
      return;
    }

    const exported = await this._sessionManager.exportSessionAsJson(sessionId);
    if (!exported) {
      void vscode.window.showErrorMessage('reckon: could not resolve session file.');
      return;
    }

    const session = this._sessionManager.getSessions().find(s => s.sessionId === sessionId);
    const source = session?.source ?? 'other';
    const slug = this._slugify(session?.title ?? sessionId);

    void vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'reckon: uploading session…',
        cancellable: false,
      },
      () =>
        new Promise<void>(resolve => {
          execFile(
            'python3',
            [scriptPath, exported.filePath, '--source', source, '--slug', slug],
            { timeout: 60_000 },
            (err, stdout, stderr) => {
              exported.cleanup();
              if (err) {
                void vscode.window.showErrorMessage(
                  `reckon: upload failed — ${(stderr || String(err)).trim()}`,
                );
              } else {
                void vscode.window.showInformationMessage('reckon: session uploaded ✓');
                if (stdout.trim()) {
                  console.log('[reckon upload]', stdout.trim());
                }
              }
              resolve();
            },
          );
        }),
    );
  }

  private _slugify(text: string): string {
    return (
      text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 60) || 'session'
    );
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const mainScriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'src', 'webview', 'main.js')
    );
    const stylesUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'src', 'webview', 'styles.css')
    );
    const nonce = getNonce();

    const buildDisplay = BUILD_TIME.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${stylesUri}">
  <title>Claude Session Switcher</title>
</head>
<body>
  <div id="tab-bar">
    <div id="toolbar">
      <button id="about-btn" title="About Claude Session Switcher">&#x24D8;</button>
      <button id="new-session-btn" title="New Claude Session">+</button>
      <button id="new-bob-session-btn" title="New Bob Session">+B</button>
    </div>
    <div id="tab-strip" role="tablist" aria-label="Claude Sessions"></div>
    <button id="history-toggle" aria-expanded="false">History &#x25B6;</button>
    <div id="history-panel" hidden></div>
  </div>
  <div id="about-box" hidden>
    <div class="about-name">Claude Session Switcher</div>
    <div class="about-version">v${BUILD_VERSION}</div>
    <div class="about-built">Built ${buildDisplay}</div>
    <button id="about-close">Close</button>
  </div>
  <div id="session-preview" hidden></div>
  <script nonce="${nonce}" src="${mainScriptUri}"></script>
</body>
</html>`;
  }
}
